(() => {
  'use strict';

  // eq.js - Visual EQ behavior (Winamp-style). No audio DSP.
  // - Draws a curved EQ line in #eqGraph based on the 10 band sliders.
  // - Moves the preamp horizontal line sprite with the preamp slider.
  // - Applies stepped color frames to each band + preamp using the skin sprite.
  //
  // IMPORTANT: Your bar sprite sheet is 28 frames total:
  //   - 14 frames on the top row  (green -> yellow)
  //   - 14 frames on the bottom row (yellow -> red)
  // We treat it like a Unity-style sprite sheet: each visual state is a discrete frame.
  // The slider never "scrolls" the sheet; it jumps to a single frame index 0..27.

  const $ = (sel, root = document) => root.querySelector(sel);

  const BAND_IDS = [
    'band-60',
    'band-170',
    'band-310',
    'band-600',
    'band-1000',
    'band-3000',
    'band-6000',
    'band-12000',
    'band-14000',
    'band-16000'
  ];

  // ============================
  // Tweakables (override via window.IDK_EQ_CONFIG)
  // ============================
  // window.IDK_EQ_CONFIG = {
  //   SPRITE_GAP_X: 1,
  //   SPRITE_GAP_Y: 1,
  //   GRAPH_DB_BOOST: 1.6,
  //   GRAPH_BOTTOM_EXTRA_PX: 3,
  // }
  const DEFAULTS = Object.freeze({
    SPRITE_W: 14,
    SPRITE_H: 64,
    SPRITE_GAP_X: 1,
    SPRITE_GAP_Y: 1,
    FRAMES_PER_ROW: 14,
    FRAMES_TOTAL: 28,
    // Visual curve exaggeration: >1 means more extreme curve (hits red/green sooner).
    GRAPH_DB_BOOST: 1.6,
    // Let the curve dip a little lower than before.
    GRAPH_BOTTOM_EXTRA_PX: 3,
  });

  function cfg() {
    const c = window.IDK_EQ_CONFIG || {};
    const out = { ...DEFAULTS };
    for (const k of Object.keys(out)) {
      if (Number.isFinite(c[k])) out[k] = c[k];
    }
    return out;
  }

  // Graph constants
  const DB_RANGE = 12; // +/- 12 dB

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function parseTranslateY(el) {
    if (!el) return 0;
    // Prefer inline transform, but fall back to computed style.
    let t = el.style.transform || '';
    if (!t) {
      const cs = getComputedStyle(el);
      t = cs.transform || cs.webkitTransform || '';
      // If it's a matrix, read it.
      if (t && t.startsWith('matrix(')) {
        const parts = t.slice(7, -1).split(',').map(s => parseFloat(s.trim()));
        // matrix(a,b,c,d,tx,ty)
        if (parts.length === 6 && Number.isFinite(parts[5])) return parts[5];
      }
    }
    const m = t.match(/translateY\(([-\d.]+)px\)/i);
    return m ? parseFloat(m[1]) : 0;
  }

  function getSliderParts(sliderRoot) {
    // sliderRoot -> child track (height:62,width:14) -> mover (transform translateY)
    // handle has class slider-handle
    const track = sliderRoot.querySelector('div[style*="height"]') || sliderRoot.querySelector('div');
    const mover = sliderRoot.querySelector('div[style*="transform"]');
    const handle = sliderRoot.querySelector('.slider-handle');
    return { track, mover, handle };
  }

  function getSliderMaxY(trackEl, handleEl) {
    if (!trackEl || !handleEl) return 51;
    const th = trackEl.getBoundingClientRect().height;
    const hh = handleEl.getBoundingClientRect().height;
    return Math.max(0, Math.round(th - hh));
  }

  function yToDb(y, maxY) {
    // y=0 top => +12dB, y=maxY bottom => -12dB
    const t = maxY <= 0 ? 0.5 : (y / maxY);
    const db = (0.5 - t) * 2 * DB_RANGE;
    return clamp(db, -DB_RANGE, DB_RANGE);
  }

  function dbToGraphY(db, h) {
    // map +12..-12 to 1..(h-2), 0dB goes to middle
    // then optionally push the curve down a few pixels.
    const top = 1;
    const bottom = h - 2;
    const t = (DB_RANGE - db) / (2 * DB_RANGE); // +12->0, -12->1
    const base = Math.round(top + t * (bottom - top));
    const extra = cfg().GRAPH_BOTTOM_EXTRA_PX;
    return clamp(base + extra, 0, h - 1);
  }

  function colorForDb(db) {
    // yellow at 0, green down, red up
    const Y = { r: 255, g: 255, b: 0 };
    if (db >= 0) {
      const t = clamp(db / DB_RANGE, 0, 1);
      return `rgb(${Y.r},${Math.round(Y.g * (1 - t))},0)`;
    }
    const t = clamp((-db) / DB_RANGE, 0, 1);
    return `rgb(${Math.round(Y.r * (1 - t))},${Y.g},0)`;
  }

  function yToFrameIndex28(y, maxY) {
    // Bottom should be 0 (green), top should be 27 (red).
    const c = cfg();
    const t = maxY <= 0 ? 0.5 : (1 - (y / maxY)); // top=1
    const idx = Math.round(clamp(t, 0, 1) * (c.FRAMES_TOTAL - 1));
    return clamp(idx, 0, c.FRAMES_TOTAL - 1);
  }

  function setSliderBarFrame(sliderRoot, y, maxY) {
    const c = cfg();
    const idx = yToFrameIndex28(y, maxY);

    // Map frame index -> (row, col) on the original 2-row sheet.
    // 0..13: top row (green->yellow)
    // 14..27: bottom row (yellow->red)
    const row = idx < c.FRAMES_PER_ROW ? 0 : 1;
    const col = idx < c.FRAMES_PER_ROW ? idx : (idx - c.FRAMES_PER_ROW);

    const stepX = c.SPRITE_W + c.SPRITE_GAP_X;
    const stepY = c.SPRITE_H + c.SPRITE_GAP_Y;

    sliderRoot.style.backgroundPosition = `${-col * stepX}px ${-row * stepY}px`;
  }

  function ensurePreampLine(eqWin, canvas) {
    let line = $('#preamp-line', eqWin);
    if (!line) {
      line = document.createElement('div');
      line.id = 'preamp-line';
      line.style.position = 'absolute';
      line.style.width = '113px';
      line.style.height = '1px';
      line.style.pointerEvents = 'none';
      eqWin.appendChild(line);
    }

    // Align line's left with the canvas.
    const cRect = canvas.getBoundingClientRect();
    const wRect = eqWin.getBoundingClientRect();
    line.style.left = `${Math.round(cRect.left - wRect.left)}px`;
    return line;
  }

  function getEvenBandXPositions(canvas, count) {
    // The EQ graph should be evenly spaced left-to-right.
    // (We intentionally ignore DOM element positions so the high bands don't get squished.)
    const w = canvas.width;
    if (count <= 1) return [Math.round(w / 2)];
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(Math.round((i / (count - 1)) * (w - 1)));
    }
    return out;
  }

  // Catmull-Rom to Bezier control points (smooth curve through points)
  function drawCurveBezier(canvas, points) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Draw each segment with its own strokeStyle (for per-segment color).
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];

      // Catmull-Rom -> Bezier (tension 1)
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      const avgDb = (p1.db + p2.db) / 2;
      ctx.strokeStyle = colorForDb(avgDb);

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      ctx.stroke();
    }

    // subtle points
    ctx.fillStyle = 'rgba(255,255,0,0.65)';
    for (const p of points) {
      ctx.fillRect(p.x, p.y, 1, 1);
    }
  }

  function init() {
    const eqWin = $('#equalizer-window');
    const canvas = $('#eqGraph');
    if (!eqWin || !canvas) return;

    const preampEl = $('#preamp', eqWin);
    const bandEls = BAND_IDS.map(id => $('#' + id, eqWin)).filter(Boolean);
    if (!preampEl || bandEls.length !== 10) return;

    const preampParts = getSliderParts(preampEl);
    const bandParts = bandEls.map(getSliderParts);

    // Compute maxY after layout.
    const preampMaxY = getSliderMaxY(preampParts.track, preampParts.handle);
    const bandMaxY = bandParts.map(p => getSliderMaxY(p.track, p.handle));

    const preampLine = ensurePreampLine(eqWin, canvas);

    // Cache x positions (evenly spaced) and update on resize.
    let bandXs = getEvenBandXPositions(canvas, bandEls.length);
    const refreshBandXs = () => { bandXs = getEvenBandXPositions(canvas, bandEls.length); };

    window.addEventListener('resize', () => {
      refreshBandXs();
      ensurePreampLine(eqWin, canvas);
      schedule();
    });

    // Observe style changes on movers so we update as you drag.
    const movers = [preampParts.mover, ...bandParts.map(p => p.mover)].filter(Boolean);
    const mo = new MutationObserver(() => schedule());
    for (const m of movers) mo.observe(m, { attributes: true, attributeFilter: ['style'] });

    let raf = 0;
    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(update);
    }

    function update() {
      raf = 0;

      // PREAMP
      const py = clamp(parseTranslateY(preampParts.mover), 0, preampMaxY);
      // Make the curve feel more extreme (hits red/green earlier).
      const boost = cfg().GRAPH_DB_BOOST;
      const pdb = clamp(yToDb(py, preampMaxY) * boost, -DB_RANGE, DB_RANGE);
      const preampGraphY = dbToGraphY(pdb, canvas.height);

      // Move preamp line relative to canvas, centered at 0dB by default.
      const cRect = canvas.getBoundingClientRect();
      const wRect = eqWin.getBoundingClientRect();
      const topPx = Math.round((cRect.top - wRect.top) + preampGraphY);
      preampLine.style.top = `${topPx}px`;

      // Apply preamp bar color snapping too
      setSliderBarFrame(preampEl, py, preampMaxY);

      // BANDS: update bar frames and build points
      const points = [];
      for (let i = 0; i < bandEls.length; i++) {
        const mover = bandParts[i].mover;
        const maxY = bandMaxY[i] || 51;
        const y = clamp(parseTranslateY(mover), 0, maxY);
        const db = clamp(yToDb(y, maxY) * boost, -DB_RANGE, DB_RANGE);

        setSliderBarFrame(bandEls[i], y, maxY);

        const x = bandXs[i] ?? Math.round((i / 9) * (canvas.width - 1));
        points.push({ x, y: dbToGraphY(db, canvas.height), db });
      }

      // Draw smoothed curve
      drawCurveBezier(canvas, points);
    }

    // Initial draw
    schedule();

    // Also update during pointer drags even if style mutation is throttled.
    window.addEventListener('pointermove', () => schedule(), { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
