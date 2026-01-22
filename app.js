/* webamp_controls.js
   Minimal interactions for the static Webamp HTML+CSS clone:
   - Press/active states for buttons
   - Toggle buttons (shuffle/repeat, EQ/PL visibility, mono/stereo highlight)
   - Window dragging (Winamp-style)
   - Vertical EQ band dragging + playlist scrollbar dragging
   - Shade/close buttons

   No audio logic yet; this is purely UI state + draggable handles.
*/

(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  // -----------------------------
  // Pixel grid snapping (shared across ALL draggables)
  // -----------------------------
  const GRID_SIZE = 4; // px step (invisible pixel grid)
  const snapToGrid = (n) => Math.round(n / GRID_SIZE) * GRID_SIZE;

  // -----------------------------
  // Global placement (move the whole rig as a group)
  // -----------------------------
  // Edit these two numbers to place the entire Webamp + EQ + Visualizer "rig" anywhere on the page.
  // (0,0) means "normal" top-left.
  const IDK_RIG_ORIGIN = { x: 100, y: 50 };

  // If true, we auto-center the MAIN window on load (like before). Usually you want this OFF once you start hand-placing.
  const IDK_AUTO_CENTER_MAIN = false;

  // -----------------------------
  // Snapping behavior
  // -----------------------------
  // How close (in px) two edges need to be to snap together.
  const IDK_SNAP_THRESHOLD = 10;

  // Sticky "release distance" (hysteresis). Once snapped, you must move this far away to unstick.
  const IDK_UNSTICK_DISTANCE = 16;

  function getTranslateXY(el) {
    const t = (el.style.transform || '').trim();
    // Expect: translate(398px, 297px)
    const m = t.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    if (!m) return { x: 0, y: 0 };
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  }

  function setTranslateXY(el, x, y) {
    el.style.transform = `translate(${snapToGrid(x)}px, ${snapToGrid(y)}px)`;
  }

  // -----------------------------
  // Press feedback for buttons
  // -----------------------------
  function wirePressState(el, { activeClass = 'idk-active' } = {}) {
    if (!el) return;

    const down = (e) => {
      // Prevent text selection and also helps stop drag-start on click.
      e.preventDefault();
      el.classList.add(activeClass);
      el.setPointerCapture?.(e.pointerId);
    };

    const up = () => el.classList.remove(activeClass);

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  }

  function wireToggle(el, {
    pressedClass = 'selected',
    onToggle,
  } = {}) {
    if (!el) return;

    wirePressState(el);

    el.addEventListener('click', (e) => {
      e.preventDefault();
      const next = !el.classList.contains(pressedClass);
      el.classList.toggle(pressedClass, next);
      onToggle?.(next);
    });
  }

  // -----------------------------
  // Transport state (play/pause/stop)
  // -----------------------------
  function setPlaybackState(state) {
    const main = $('#main-window');
    if (!main) return;
    main.classList.remove('play', 'pause', 'stop');
    main.classList.add(state);
  }

  // -----------------------------
  // Marquee helper (simple, no scrolling yet)
  // -----------------------------
  function setMarqueeText(text) {
    const marquee = $('#marquee > div');
    if (!marquee) return;
    // Keep it super simple: replace text content (no sprite font mapping yet)
    // This is only a temporary debug/status readout.
    marquee.textContent = text;
  }

  // -----------------------------
  // Generic vertical slider drag (handles inside translateY wrapper)
  // bandEl: element with class 'band' (or scrollbar track)
  // handleEl: draggable handle element
  // translateTargetEl: the element whose style.transform we set to translateY(px)
  // -----------------------------
  function makeVerticalTranslateDrag({
    trackEl,
    handleEl,
    translateTargetEl,
    minY = 0,
    maxY,
    onChange,
    onStart,
    onEnd,
  }) {
    if (!trackEl || !handleEl || !translateTargetEl) return;

    const computeMaxY = () => {
      const trackH = trackEl.getBoundingClientRect().height;
      const handleH = handleEl.getBoundingClientRect().height;
      return Math.max(0, Math.round(trackH - handleH));
    };

    let dragging = false;
    let pointerId = null;

    const start = (e) => {
      e.preventDefault();
      dragging = true;
      pointerId = e.pointerId;
      handleEl.classList.add('idk-active');
      handleEl.setPointerCapture?.(pointerId);
      onStart?.();
      move(e);
    };

    const stop = () => {
      dragging = false;
      pointerId = null;
      handleEl.classList.remove('idk-active');
      onEnd?.();
    };

    const move = (e) => {
      if (!dragging) return;

      const rect = trackEl.getBoundingClientRect();
      const handleRect = handleEl.getBoundingClientRect();
      const localY = e.clientY - rect.top;

      const max = (typeof maxY === 'number') ? maxY : computeMaxY();
      const rawY = Math.round(localY - handleRect.height / 2);
      const clampedY = clamp(rawY, minY, max);
      const nextY = clamp(snapToGrid(clampedY), minY, max);

      translateTargetEl.style.transform = `translateY(${nextY}px)`;
      onChange?.(nextY, { maxY: max });
    };

    // Pointer events on the handle + clicking the track
    handleEl.addEventListener('pointerdown', start);
    trackEl.addEventListener('pointerdown', (e) => {
      // If user clicks the track, jump handle there
      if (e.target === handleEl) return;
      start(e);
    });

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  

  // -----------------------------
  // Snap-to-edge logic (Winamp-style)
  // -----------------------------
  function snapWindowToOthers(wrapper, nextX, nextY, opts = {}) {
    const threshold = (typeof opts.threshold === 'number') ? opts.threshold : IDK_SNAP_THRESHOLD;
    const root = $('#webamp') || document.body;

    // Current size (translate doesn't affect width/height)
    const curRect = wrapper.getBoundingClientRect();
    const w = curRect.width;
    const h = curRect.height;

    const candidatesX = [];
    const candidatesY = [];

    // Snap to viewport/root edges (and keep it "sticky" via lockX/lockY in the drag loop)
    candidatesX.push(0);
    candidatesY.push(0);

    // If #webamp is offset (via IDK_RIG_ORIGIN), compute viewport-edge snaps in #webamp-local coordinates.
    // wrapperRect.left = rootRect.left + x, so to align wrapper to viewport left: x = -rootRect.left
    const rootRect = root.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    candidatesX.push(Math.round(-rootRect.left));
    candidatesY.push(Math.round(-rootRect.top));
    candidatesX.push(Math.round(vw - rootRect.left - w));   // viewport right
    candidatesY.push(Math.round(vh - rootRect.top - h));    // viewport bottom

    // Also snap to the root's own box edges if it has a measurable size.
    if (root.clientWidth) candidatesX.push(Math.round(root.clientWidth - w));
    if (root.clientHeight) candidatesY.push(Math.round(root.clientHeight - h));

    const wrappers = $$('div[style*="transform: translate"]', root).filter(el => el !== wrapper && el.offsetParent !== null);
    for (const other of wrappers) {
      const t = getTranslateXY(other);
      const r = other.getBoundingClientRect();
      const ox = t.x;
      const oy = t.y;
      const ow = r.width;
      const oh = r.height;

      // X alignments: left-left, right-right, left-to-right, right-to-left
      candidatesX.push(ox);                 // align left
      candidatesX.push(ox + ow - w);        // align right
      candidatesX.push(ox + ow);            // snap our left to their right
      candidatesX.push(ox - w);             // snap our right to their left

      // Y alignments: top-top, bottom-bottom, top-to-bottom, bottom-to-top
      candidatesY.push(oy);                 // align top
      candidatesY.push(oy + oh - h);        // align bottom
      candidatesY.push(oy + oh);            // snap our top to their bottom
      candidatesY.push(oy - h);             // snap our bottom to their top
    }

    const snapAxis = (val, candidates) => {
      let best = val;
      let bestDist = threshold + 1;
      for (const c of candidates) {
        const d = Math.abs(val - c);
        if (d <= threshold && d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      return Math.round(best);
    };

    return {
      x: snapAxis(nextX, candidatesX),
      y: snapAxis(nextY, candidatesY),
    };
  }

// -----------------------------
  // Window dragging
  // -----------------------------
  function wireWindowDragging(windowEl) {
    if (!windowEl) return;

    // The actual translated wrapper is the absolute-positioned parent with inline transform.
    const wrapper = windowEl.closest('div[style*="transform: translate"]');
    if (!wrapper) return;

    let dragging = false;
    let pid = null;
    let startX = 0, startY = 0;
    let baseX = 0, baseY = 0;
    let lastX = 0, lastY = 0;
    let lockX = null, lockY = null;

    const isInteractive = (target) => {
      return !!target.closest('input, button, a, .slider-handle, .playlist-scrollbar-handle, canvas');
    };

    const start = (e) => {
      // Only allow drag from draggable regions (title bars / frames)
      const inDraggable = !!e.target.closest('.draggable');
      if (!inDraggable) return;
      if (isInteractive(e.target)) return;

      e.preventDefault();
      dragging = true;
      pid = e.pointerId;
      const t = getTranslateXY(wrapper);
      baseX = t.x;
      baseY = t.y;
      startX = e.clientX;
      startY = e.clientY;
      lockX = null;
      lockY = null;
      wrapper.setPointerCapture?.(pid);

      // Bring to front
      const root = $('#webamp');
      if (root) {
        const z = Number(wrapper.style.zIndex || 1);
        const maxZ = Math.max(1, ...$$('div[style*="transform: translate"]', root).map(d => Number(d.style.zIndex || 1)));
        wrapper.style.zIndex = String(maxZ + 1);
      }
    };

    const move = (e) => {
      if (!dragging || e.pointerId !== pid) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Raw grid-snapped position
      const rawX = snapToGrid(baseX + dx);
      const rawY = snapToGrid(baseY + dy);

      // Live snapping + "stickiness"
      const snapped = snapWindowToOthers(wrapper, rawX, rawY, { threshold: IDK_SNAP_THRESHOLD });

      // Lock/unlock per-axis so it "sticks" when aligned until you pull away far enough
      if (lockX != null) {
        if (Math.abs(rawX - lockX) > IDK_UNSTICK_DISTANCE) lockX = null;
      }
      if (lockY != null) {
        if (Math.abs(rawY - lockY) > IDK_UNSTICK_DISTANCE) lockY = null;
      }

      if (lockX == null && snapped.x !== rawX) lockX = snapped.x;
      if (lockY == null && snapped.y !== rawY) lockY = snapped.y;

      lastX = (lockX != null) ? lockX : snapped.x;
      lastY = (lockY != null) ? lockY : snapped.y;

      setTranslateXY(wrapper, lastX, lastY);
    };

    const stop = (e) => {
      if (!dragging) return;
      if (pid != null && e && e.pointerId !== pid) return;

      // Final snap (in case pointerup happens mid-move)
      const finalX = (lastX || baseX);
      const finalY = (lastY || baseY);
      const snapped = snapWindowToOthers(wrapper, finalX, finalY, { threshold: IDK_SNAP_THRESHOLD });
      setTranslateXY(wrapper, snapped.x, snapped.y);

      dragging = false;
      pid = null;
      lockX = null;
      lockY = null;
    };

    wrapper.addEventListener('pointerdown', start);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  // -----------------------------
  // Wire everything on DOM ready
  // -----------------------------
  function init() {
    const root = $('#webamp');
    if (!root) return;

    // Global origin (moves ALL windows together)
    root.style.transform = `translate(${IDK_RIG_ORIGIN.x}px, ${IDK_RIG_ORIGIN.y}px)`;
    root.style.transformOrigin = 'top left';

    // Optional: center the main window on load
    const mainWin = $('#main-window');
    const mainWrap = mainWin?.closest('div[style*="transform: translate"]');
    if (IDK_AUTO_CENTER_MAIN && mainWrap) {
      const r = mainWrap.getBoundingClientRect();
      const x = snapToGrid((window.innerWidth - r.width) / 2);
      const y = snapToGrid((window.innerHeight - r.height) / 2);
      setTranslateXY(mainWrap, x, y);
    }

    // Set a sane initial stacking order (so MAIN is always above the visualizer, etc.)
    const eqWrap = $('#equalizer-window')?.closest('div[style*="transform: translate"]');
    const plWrap = $('#playlist-window')?.closest('div[style*="transform: translate"]');
    const genWrap = $('.gen-window')?.closest('div[style*="transform: translate"]');
    // Lowest first
    if (genWrap) genWrap.style.zIndex = '1';
    if (eqWrap) eqWrap.style.zIndex = '2';
    if (plWrap) plWrap.style.zIndex = '2';
    if (mainWrap) mainWrap.style.zIndex = '3';


    // Transport buttons
    const previous = $('#previous');
    const play = $('#play');
    const pause = $('#pause');
    const stop = $('#stop');
    const next = $('#next');
    const eject = $('#eject');

    [previous, play, pause, stop, next, eject].forEach((el) => wirePressState(el));

    previous?.addEventListener('click', () => setMarqueeText('<< PREVIOUS (stub)'));
    next?.addEventListener('click', () => setMarqueeText('NEXT >> (stub)'));

    play?.addEventListener('click', () => {
      setPlaybackState('play');
      setMarqueeText('PLAY (stub)');
    });

    pause?.addEventListener('click', () => {
      setPlaybackState('pause');
      setMarqueeText('PAUSE (stub)');
    });

    stop?.addEventListener('click', () => {
      setPlaybackState('stop');
      setMarqueeText('STOP (stub)');
    });

    eject?.addEventListener('click', () => setMarqueeText('EJECT (stub)'));

    // Shuffle / Repeat
    wireToggle($('#shuffle'));
    wireToggle($('#repeat'));

    // Stereo / Mono (pure UI)
    const stereo = $('#stereo');
    const mono = $('#mono');
    wirePressState(stereo);
    wirePressState(mono);
    stereo?.addEventListener('click', (e) => {
      e.preventDefault();
      stereo.classList.add('selected');
      mono?.classList.remove('selected');
    });
    mono?.addEventListener('click', (e) => {
      e.preventDefault();
      mono.classList.add('selected');
      stereo?.classList.remove('selected');
    });

    // Seeking bar (position)
    const pos = $('#position');
    pos?.addEventListener('input', () => {
      setMarqueeText(`SEEK ${pos.value}% (stub)`);
    });

    // Volume + Balance status (you said these already work, so we just add UX feedback)
    const vol = $('#volume input[type="range"]');
    vol?.addEventListener('input', () => setMarqueeText(`VOLUME ${vol.value}%`));

    const bal = $('#balance');
    bal?.addEventListener('input', () => {
      const v = Number(bal.value);
      if (v === 0) return setMarqueeText('BALANCE CENTER');
      const side = v > 0 ? 'RIGHT' : 'LEFT';
      setMarqueeText(`BALANCE ${Math.abs(v)}% ${side}`);
    });

    // Toggle windows (EQ / Playlist)
    const eqButton = $('#equalizer-button');
    const plButton = $('#playlist-button');
    const eqWindow = $('#equalizer-window');
    const plWindow = $('#playlist-window');

    function setWindowVisible(win, visible) {
      if (!win) return;
      const wrap = win.closest('div[style*="transform: translate"]') || win;
      wrap.style.display = visible ? '' : 'none';
    }

    wireToggle(eqButton, {
      pressedClass: 'selected',
      onToggle: (on) => setWindowVisible(eqWindow, on),
    });

    wireToggle(plButton, {
      pressedClass: 'selected',
      onToggle: (on) => setWindowVisible(plWindow, on),
    });

    // Close buttons
    wirePressState($('#close'));
    $('#close')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });

    // The visualizer (gen) window close button
    const genClose = $('.gen-close');
    wirePressState(genClose);
    genClose?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });

    wirePressState($('#equalizer-close'));
    $('#equalizer-close')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });

    wirePressState($('#playlist-close-button'));
    $('#playlist-close-button')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });

    // Shade buttons
    wirePressState($('#equalizer-shade'));
    $('#equalizer-shade')?.addEventListener('click', (e) => {
      e.preventDefault();
      eqWindow?.classList.toggle('shade');
    });

    wirePressState($('#playlist-shade-button'));
    $('#playlist-shade-button')?.addEventListener('click', (e) => {
      e.preventDefault();
      plWindow?.classList.toggle('shade');
    });

    // Playlist bottom menus (just click feedback for now)
    [
      '#playlist-add-menu',
      '#playlist-remove-menu',
    ].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      wirePressState(el);
      el.addEventListener('click', (e) => {
        e.preventDefault();
        setMarqueeText(`${sel.replace('#', '').toUpperCase()} (stub)`);
      });
    });

    // EQ bands + preamp
    const MARQ = {
      set(text) {
        const fn = window.IDK_setMarqueeOverride;
        if (typeof fn === 'function') fn(text);
        else setMarqueeText(text);
      },
      clear() {
        const fn = window.IDK_clearMarqueeOverride;
        if (typeof fn === 'function') fn();
      }
    };

    const DB_RANGE = 12;
    const round1 = (n) => Math.round(n * 10) / 10;
    const fmtDb = (db, { spacedSign = false } = {}) => {
      // Clamp and normalize tiny values to 0.
      const v = clamp(round1(db), -DB_RANGE, DB_RANGE);
      if (Math.abs(v) < 0.05) return '0DB';
      const abs = Math.abs(v).toFixed(1);
      if (v < 0) return spacedSign ? `- ${abs}DB` : `-${abs}DB`;
      return spacedSign ? `+ ${abs}DB` : `+${abs}DB`;
    };

    const yToDb = (y, maxY) => {
      const t = maxY <= 0 ? 0.5 : (y / maxY); // 0..1
      return (0.5 - t) * 2 * DB_RANGE;        // +12..-12
    };

    const eqBands = $$('#equalizer-window .band');
    eqBands.forEach((band) => {
      const trackEl = band.querySelector(':scope > div');
      const translateTargetEl = trackEl?.querySelector(':scope > div');
      const handleEl = translateTargetEl?.querySelector('.slider-handle');
      if (!trackEl || !translateTargetEl || !handleEl) return;

      const isPreamp = (band.id || '').toLowerCase() === 'preamp';
      const label = isPreamp
        ? 'PREAMP'
        : ((band.id || '').replace('band-', '') + 'HZ').toUpperCase();

      const show = (y, maxY) => {
        const db = yToDb(y, maxY);
        const s = isPreamp
          ? `EQ: ${label} ${fmtDb(db, { spacedSign: false })}`
          : `EQ: ${label} ${fmtDb(db, { spacedSign: true })}`;
        MARQ.set(s);
      };

      makeVerticalTranslateDrag({
        trackEl,
        handleEl,
        translateTargetEl,
        onChange: (y, meta) => {
          show(y, meta.maxY || 0);
        },
        onStart: () => {
          // Show current value immediately on grab.
          const t = (translateTargetEl.style.transform || '').match(/translateY\(([-\d.]+)px\)/);
          const y = t ? parseFloat(t[1]) : 0;
          const maxY = Math.max(1, Math.round(trackEl.getBoundingClientRect().height - handleEl.getBoundingClientRect().height));
          show(clamp(y, 0, maxY), maxY);
        },
        onEnd: () => {
          MARQ.clear();
        }
      });
    });

    // EQ ON/OFF button (sprites)
    const eqOnBtn = $('#equalizer-window #on');
    if (eqOnBtn) {
      // Default ON
      eqOnBtn.classList.add('selected');
      window.IDK_EQ_ENABLED = true;
      wirePressState(eqOnBtn);
      eqOnBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const next = !eqOnBtn.classList.contains('selected');
        eqOnBtn.classList.toggle('selected', next);
        window.IDK_EQ_ENABLED = next;
        MARQ.set(next ? 'EQ: ON' : 'EQ: OFF');
        // Clear after a moment so it returns to track info.
        window.clearTimeout(eqOnBtn._idkT);
        eqOnBtn._idkT = window.setTimeout(() => MARQ.clear(), 700);
      });
    }

    // Playlist scrollbar drag (disabled - handled by idkamp_player.js)
// Window dragging
    $$('.window').forEach(wireWindowDragging);

    // Visualizer close (Milkdrop window)
    // const genClose = $('.gen-close');
    wirePressState(genClose, { activeClass: 'selected' });
    genClose?.addEventListener('click', (e) => {
      e.preventDefault();
      const genWin = genClose.closest('.gen-window');
      if (!genWin) return;
      const wrap = genWin.closest('div[style*="transform: translate"]') || genWin;
      wrap.style.display = 'none';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();