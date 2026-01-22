(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function truncateTitle(title, max = 33) {
    if (!title) return "";
    if (title.length <= max) return title;
    return title.slice(0, max - 3) + "...";
  }

  // -----------------------------
  // Elements
  // -----------------------------
  const elMain = () => $('#main-window');
  const elPlaylistWin = () => $('#playlist-window');
  const elEqWin = () => $('#equalizer-window');

  const elBtns = {
    prev: () => $('#previous'),
    play: () => $('#play'),
    pause: () => $('#pause'),
    stop: () => $('#stop'),
    next: () => $('#next'),
    eject: () => $('#eject'),
    shuffle: () => $('#shuffle'),
    repeat: () => $('#repeat'),

    eqToggle: () => $('#equalizer-button'),
    plToggle: () => $('#playlist-button'),

    mainClose: () => $('#title-bar #close'),
    mainShade: () => $('#title-bar #shade'),
    mainMin: () => $('#title-bar #minimize'),

    eqClose: () => $('#equalizer-close'),
    eqShade: () => $('#equalizer-shade'),

    plClose: () => $('#playlist-close-button'),
    plShade: () => $('#playlist-shade-button'),
  };

  const elRanges = {
    volume: () => $('#volume input[type="range"]'),
    balance: () => $('#balance'),
    position: () => $('#position'),
  };

  const elTimeDigits = {
    m1: () => $('#minute-first-digit'),
    m2: () => $('#minute-second-digit'),
    s1: () => $('#second-first-digit'),
    s2: () => $('#second-second-digit'),
  };

  const elMarqueeInner = () => $('#marquee > div');

  const elPlaylist = {
    titles: () => $('.playlist-track-titles'),
    durs: () => $('.playlist-track-durations'),
    center: () => $('.playlist-middle-center'),
    scrollbarTrack: () => $('.playlist-scrollbar > div'),
    scrollbarHandle: () => $('.playlist-scrollbar-handle'),
    scrollbarHandleWrap: () => {
      // Structure: .playlist-scrollbar > div(track) > div(wrapper with transform) > .playlist-scrollbar-handle
      return document.querySelector('.playlist-scrollbar > div > div');
    },
  };

  const fileInput = () => $('#webamp-file-input');

  // Create audio graph (audio + gain + panner + analyser)
  function createAudioGraph() {
    const audio = document.createElement('audio');
    audio.id = 'idkamp-audio';
    audio.preload = 'metadata';
    audio.crossOrigin = 'anonymous';
    audio.style.display = 'none';
    document.body.appendChild(audio);

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = AudioCtx ? new AudioCtx() : null;

    if (!ctx) {
      return { audio, ctx: null, gain: null, panner: null, analyser: null, source: null };
    }

    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const analyser = ctx.createAnalyser();

    // Winamp-ish feel: decent resolution + smoothing
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;

    if (panner) {
      source.connect(gain);
      gain.connect(panner);
      panner.connect(analyser);
      analyser.connect(ctx.destination);
    } else {
      // Fallback: no panner support
      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);
    }

    return { audio, ctx, gain, panner, analyser, source };
  }

  const GRAPH = createAudioGraph();

  // -----------------------------
  // Visualizer (early-2000s-ish)
  // - multiple modes (random)
  // - NO "beat bar" spectrum-bars mode
  // - mode switches use either CUT or FADE transitions
  // - pauses (freezes) when audio pauses; clears on stop
  // -----------------------------
  const VIS = {
    canvas: null,
    ctx2d: null,

    // Offscreen render target (persistent trails live here)
    buf: null,
    bufCtx: null,

    // Snapshot used for fade transitions
    snap: null,
    snapCtx: null,

    raf: 0,
    running: false,

    mode: 0,
    lastModeChangeMs: 0,
    nextChangeAfterMs: 0,

    hueBase: 0,
    freq: null,
    time: null,

    // Transition state
    trans: {
      active: false,
      type: 'cut', // 'cut' | 'fade'
      startMs: 0,
      durMs: 650,
    },

    // Per-mode scratch
    particles: [],
  };

  function getVisualizerCanvas() {
    // The “MilkDrop” style window in your HTML is a generic window with a single canvas.
    // We grab the first canvas inside .gen-window.
    const c = document.querySelector('.gen-window canvas');
    return c || null;
  }

  function ensureVisualizerReady() {
    if (VIS.canvas && VIS.ctx2d && VIS.buf && VIS.bufCtx && VIS.snap && VIS.snapCtx) return true;
    const c = getVisualizerCanvas();
    if (!c) return false;

    VIS.canvas = c;
    VIS.ctx2d = c.getContext('2d', { alpha: false });
    VIS.ctx2d.imageSmoothingEnabled = false;

    VIS.buf = document.createElement('canvas');
    VIS.bufCtx = VIS.buf.getContext('2d', { alpha: false });
    VIS.bufCtx.imageSmoothingEnabled = false;

    VIS.snap = document.createElement('canvas');
    VIS.snapCtx = VIS.snap.getContext('2d', { alpha: false });
    VIS.snapCtx.imageSmoothingEnabled = false;

    return true;
  }

  function nowPlayingText() {
    if (!STATE.playlist.length) return 'NO TRACK';
    const t = STATE.playlist[getCurrentTrackIndex()];
    const artist = (t?.artist || '').trim();
    const title = (t?.title || t?.name || '').trim();
    const base = artist ? `${artist} - ${title}` : title;
    return (base || 'UNKNOWN').toUpperCase();
  }

  function resizeCanvasToCSS(canvas, ctx) {
    if (!canvas) return;
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const rect = VIS.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      if (ctx) ctx.imageSmoothingEnabled = false;
    }
  }

  function resizeVisualizerToCSS() {
    if (!ensureVisualizerReady()) return;
    resizeCanvasToCSS(VIS.canvas, VIS.ctx2d);
    resizeCanvasToCSS(VIS.buf, VIS.bufCtx);
    resizeCanvasToCSS(VIS.snap, VIS.snapCtx);
  }

  function clearCanvas(ctx, w, h) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  }

  function clearVisualizer() {
    if (!ensureVisualizerReady()) return;
    resizeVisualizerToCSS();
    clearCanvas(VIS.ctx2d, VIS.canvas.width, VIS.canvas.height);
    clearCanvas(VIS.bufCtx, VIS.buf.width, VIS.buf.height);
    clearCanvas(VIS.snapCtx, VIS.snap.width, VIS.snap.height);
  }

  function stopVisualizerLoop({ clear = false } = {}) {
    VIS.running = false;
    if (VIS.raf) cancelAnimationFrame(VIS.raf);
    VIS.raf = 0;
    if (clear) clearVisualizer();
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  // Modes (NO classic spectrum bar "beat bar")
  // 0 oscilloscope ribbon
  // 1 lissajous loop
  // 2 particles (bass-reactive)
  // 3 radial spectrum ring (non-bar)
  // 4 plasma waves
  // 5 tunnel spiral
  // 6 dot-matrix waveform
  const VIS_MODES = [0, 1, 2, 3, 4, 5, 6];

  function pickNextVisMode() {
    // avoid repeating the same mode too often
    const cur = VIS.mode;
    let m = cur;
    for (let i = 0; i < 10 && m === cur; i++) {
      m = VIS_MODES[Math.floor(Math.random() * VIS_MODES.length)];
    }
    return m;
  }

  function startTransition() {
    // 65% fade, 35% cut
    const fade = Math.random() < 0.65;
    VIS.trans.type = fade ? 'fade' : 'cut';
    VIS.trans.active = fade;
    VIS.trans.startMs = performance.now();
    VIS.trans.durMs = Math.floor(randomBetween(520, 860));

    if (fade) {
      // snapshot current buffer for crossfade
      resizeVisualizerToCSS();
      VIS.snapCtx.globalAlpha = 1;
      VIS.snapCtx.drawImage(VIS.buf, 0, 0);
    }

    // When switching modes, start fresh so fades look crisp
    clearCanvas(VIS.bufCtx, VIS.buf.width, VIS.buf.height);
  }

  function scheduleNextModeChange(now) {
    VIS.lastModeChangeMs = now;
    VIS.nextChangeAfterMs = Math.floor(randomBetween(7000, 14000));
  }

  function startVisualizerLoop() {
    if (!GRAPH?.ctx || !GRAPH?.analyser) return;
    if (!ensureVisualizerReady()) return;
    if (VIS.running) return;

    const a = GRAPH.analyser;
    VIS.freq = new Uint8Array(a.frequencyBinCount);
    VIS.time = new Uint8Array(a.fftSize);

    resizeVisualizerToCSS();
    VIS.running = true;

    if (VIS.mode === undefined || VIS.mode === null) VIS.mode = pickNextVisMode();
    VIS.hueBase = Math.random() * 360;
    scheduleNextModeChange(performance.now());

    const tick = () => {
      if (!VIS.running) return;

      // Pause/freeze when audio pauses
      if (GRAPH.audio.paused) {
        VIS.running = false;
        VIS.raf = 0;
        return;
      }

      resizeVisualizerToCSS();

      const ctx = VIS.ctx2d;
      const bctx = VIS.bufCtx;
      const w = VIS.buf.width;
      const h = VIS.buf.height;

      const now = performance.now();

      // Mode change timing
      if (now - VIS.lastModeChangeMs > VIS.nextChangeAfterMs) {
        startTransition();
        VIS.mode = pickNextVisMode();
        scheduleNextModeChange(now);
      }

      const analyser = GRAPH.analyser;
      analyser.getByteFrequencyData(VIS.freq);
      analyser.getByteTimeDomainData(VIS.time);

      // Trails in offscreen buffer
      bctx.fillStyle = 'rgba(0,0,0,0.12)';
      bctx.fillRect(0, 0, w, h);

      // Hue drift
      VIS.hueBase = (VIS.hueBase + 0.7) % 360;
      const hue1 = VIS.hueBase;
      const hue2 = (VIS.hueBase + 135) % 360;
      const hue3 = (VIS.hueBase + 255) % 360;

      // Helpers
      const bass = VIS.freq.slice(0, 12).reduce((a, b) => a + b, 0) / 12 / 255;
      const mid = VIS.freq.slice(12, 64).reduce((a, b) => a + b, 0) / 52 / 255;
      const tre = VIS.freq.slice(64, 160).reduce((a, b) => a + b, 0) / 96 / 255;

      // Small helpers (per-frame)
      const avgFreq = (from, to) => {
        const n = Math.max(1, to - from);
        let sum = 0;
        for (let i = from; i < to; i++) sum += (VIS.freq[i] || 0);
        return (sum / n) / 255;
      };
      const luma = (p) => Math.floor(20 + p * 80); // 20..100

      // Draw mode into buffer
      if (VIS.mode === 0) {
        // Oscilloscope ribbon + secondary echo
        bctx.lineWidth = Math.max(1, Math.floor(w / 620));
        bctx.strokeStyle = `hsla(${hue1}, 100%, 55%, 0.95)`;
        bctx.beginPath();
        for (let i = 0; i < VIS.time.length; i++) {
          const x = (i / (VIS.time.length - 1)) * w;
          const v = (VIS.time[i] - 128) / 128;
          const y = h / 2 + v * (h * (0.28 + bass * 0.16));
          if (i === 0) bctx.moveTo(x, y);
          else bctx.lineTo(x, y);
        }
        bctx.stroke();

        bctx.strokeStyle = `hsla(${hue2}, 100%, 55%, 0.28)`;
        bctx.beginPath();
        for (let i = 0; i < VIS.time.length; i += 2) {
          const x = (i / (VIS.time.length - 1)) * w;
          const v = (VIS.time[i] - 128) / 128;
          const y = h / 2 + v * (h * 0.16) + Math.sin((now / 180) + i / 18) * (h * 0.04);
          if (i === 0) bctx.moveTo(x, y);
          else bctx.lineTo(x, y);
        }
        bctx.stroke();

      } else if (VIS.mode === 1) {
        // Lissajous loop
        bctx.lineWidth = Math.max(1, Math.floor(w / 760));
        bctx.strokeStyle = `hsla(${hue2}, 100%, 55%, ${0.75 + bass * 0.2})`;
        bctx.beginPath();
        const n = VIS.time.length;
        for (let i = 0; i < n; i += 2) {
          const a = (VIS.time[i] - 128) / 128;
          const b = (VIS.time[(i + 128) % n] - 128) / 128;
          const x = w / 2 + a * (w * (0.32 + mid * 0.12));
          const y = h / 2 + b * (h * (0.32 + tre * 0.12));
          if (i === 0) bctx.moveTo(x, y);
          else bctx.lineTo(x, y);
        }
        bctx.closePath();
        bctx.stroke();

      } else if (VIS.mode === 2) {
        // Particles (bass-reactive, classic chaos)
        const target = Math.floor(80 + bass * 260);
        // spawn
        while (VIS.particles.length < target) {
          VIS.particles.push({
            x: w / 2,
            y: h / 2,
            vx: (Math.random() - 0.5) * (2 + bass * 8),
            vy: (Math.random() - 0.5) * (2 + bass * 8),
            life: randomBetween(20, 80),
            hue: (hue1 + Math.random() * 90) % 360,
          });
        }
        // update/draw
        for (let i = VIS.particles.length - 1; i >= 0; i--) {
          const p = VIS.particles[i];
          p.vx *= 1.02;
          p.vy *= 1.02;
          p.x += p.vx * (1 + bass * 1.9);
          p.y += p.vy * (1 + bass * 1.9);
          p.life -= 1;
          if (p.life <= 0 || p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) {
            VIS.particles.splice(i, 1);
            continue;
          }
          const r = 1 + bass * 2.2;
          bctx.fillStyle = `hsla(${p.hue}, 100%, 60%, ${0.18 + bass * 0.55})`;
          bctx.fillRect(p.x, p.y, r, r);
        }
        // trim
        if (VIS.particles.length > target * 1.1) {
          VIS.particles.length = target;
        }

      } else if (VIS.mode === 3) {
        // Vector-scope thick (B&W + tint)
        bctx.lineWidth = Math.max(.1, Math.floor(w / 520));
        const n = VIS.time.length;
        bctx.strokeStyle = `rgba(255,255,255,${0.18 + bass * 0.30})`;
        bctx.beginPath();
        for (let i = 0; i < n; i += 1) {
          const a = (VIS.time[i] - 128) / 128;
          const b = (VIS.time[(i + 96) % n] - 128) / 128;
          const x = w / 2 + a * (w * (0.85 + mid * 0.72));
          const y = h / 2 + b * (h * (0.85 + tre * 0.72));
          if (i === 0) bctx.moveTo(x, y);
          else bctx.lineTo(x, y);
        }
        bctx.closePath();
        bctx.stroke();
        bctx.strokeStyle = `hsla(${hue2}, 100%, 70%, ${0.06 + tre * 0.14})`;
        bctx.stroke();

      } else if (VIS.mode === 4) {
        // Plasma waves (cheap but looks very 2000s)
        const rows = Math.max(40, Math.floor(h / 10));
        const cols = Math.max(60, Math.floor(w / 10));
        const cellW = w / cols;
        const cellH = h / rows;
        const t = now / 1000;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const nx = x / cols;
            const ny = y / rows;
            const v = (
              Math.sin((nx * 10) + t * (1.2 + bass * 1.8)) +
              Math.sin((ny * 12) + t * (1.0 + mid * 1.5)) +
              Math.sin(((nx + ny) * 8) + t * (0.7 + tre * 1.3))
            ) / 3;
            const lum = 40 + (v * 0.5 + 0.5) * 40;
            const hh = (hue2 + (nx * 120) + (ny * 120) + v * 40) % 360;
            bctx.fillStyle = `hsla(${hh}, 100%, ${lum}%, ${0.15 + bass * 0.25})`;
            bctx.fillRect(x * cellW, y * cellH, cellW + 0.5, cellH + 0.5);
          }
        }

      } else if (VIS.mode === 5) {
        // Tunnel spiral (frequency-modulated)
        const cx = w / 2;
        const cy = h / 2;
        const layers = 70;
        const t = now / 1000;
        for (let i = 0; i < layers; i++) {
          const z = i / layers;
          const bin = Math.floor(z * (VIS.freq.length * 0.6));
          const v = (VIS.freq[bin] || 0) / 255;
          const ang = t * (1.8 + bass * 2.0) + z * 10 + v * 2;
          const rad = (1 - z) * Math.min(w, h) * (0.46 + v * 0.10);
          const x = cx + Math.cos(ang) * rad;
          const y = cy + Math.sin(ang * 1.08) * rad;
          const size = 1 + (1 - z) * (3 + bass * 6);
          bctx.fillStyle = `hsla(${(hue1 + z * 220) % 360}, 100%, 60%, ${0.08 + v * 0.22})`;
          bctx.fillRect(x, y, size, size);
        }

      } else if (VIS.mode === 6) {
        // == (fills the screen, chunky)
        const cols = Math.max(24, Math.floor(w / 18));
        const rows = Math.max(18, Math.floor(h / 18));
        const cellW = w / cols;
        const cellH = h / rows;
        for (let x = 0; x < cols; x++) {
          const band = avgFreq(Math.floor(x * 6), Math.floor(x * 6 + 10));
          const filled = Math.floor(band * rows);
          for (let y = 0; y < filled; y++) {
            const yy = rows - 1 - y;
            const v = y / rows;
            const hh = (hue1 + v * 140 + x * 0.8) % 360;
            bctx.fillStyle = `hsla(${hh}, 100%, ${40 + v * 45}%, ${0.10 + band * 0.35})`;
            bctx.fillRect(x * cellW, yy * cellH, cellW - 1, cellH - 1);
          }
        }

      } else {
        // Dot-matrix waveform (grid + dancing dots)
        const dots = Math.min(240, Math.max(80, Math.floor(w / 4)));
        const step = Math.floor(VIS.time.length / dots);
        for (let i = 0; i < dots; i++) {
          const x = (i / (dots - 1)) * w;
          const v = (VIS.time[i * step] - 128) / 128;
          const y = h / 2 + v * (h * (0.28 + bass * 0.12));
          const r = 1 + mid * 2;
          bctx.fillStyle = `hsla(${(hue3 + i * 1.2) % 360}, 100%, 60%, 0.55)`;
          bctx.fillRect(x, y, r, r);
        }

        // grid shimmer
        const grid = Math.max(10, Math.floor(w / 40));
        bctx.fillStyle = `rgba(255,255,255,${0.02 + tre * 0.03})`;
        for (let gx = 0; gx < w; gx += grid) bctx.fillRect(gx, 0, 1, h);
        for (let gy = 0; gy < h; gy += grid) bctx.fillRect(0, gy, w, 1);
      }

      // Composite to visible canvas with optional fade transition
      ctx.globalCompositeOperation = 'source-over';
      if (VIS.trans.active && VIS.trans.type === 'fade') {
        const t = (now - VIS.trans.startMs) / VIS.trans.durMs;
        const tt = clamp(t, 0, 1);

        // Old snapshot fades out
        ctx.globalAlpha = 1 - tt;
        ctx.drawImage(VIS.snap, 0, 0);

        // New buffer fades in
        ctx.globalAlpha = tt;
        ctx.drawImage(VIS.buf, 0, 0);

        if (tt >= 1) {
          VIS.trans.active = false;
        }
      } else {
        ctx.globalAlpha = 1;
        ctx.drawImage(VIS.buf, 0, 0);
        VIS.trans.active = false;
      }
      ctx.globalAlpha = 1;

      // Song title overlay (on visible canvas so it stays crisp during fades)
      const title = nowPlayingText();
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      const fontSize = Math.max(10, Math.floor(w / 40));
      ctx.font = `${fontSize}px monospace`;
      ctx.textBaseline = 'top';
      const tw = Math.min(w - 16, ctx.measureText(title).width + 18);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(8, 8, tw, fontSize + 10);
      ctx.fillStyle = `hsla(${hue1}, 100%, 70%, 0.95)`;
      ctx.fillText(title, 14, 10);
      ctx.restore();

      VIS.raf = requestAnimationFrame(tick);
    };

    VIS.raf = requestAnimationFrame(tick);
  }

  function onTrackChangedForVisualizer() {
    // Force a transition on track change for extra vibe
    if (!ensureVisualizerReady()) return;
    resizeVisualizerToCSS();
    VIS.snapCtx.globalAlpha = 1;
    VIS.snapCtx.drawImage(VIS.buf, 0, 0);

    VIS.trans.active = true;
    VIS.trans.type = 'fade';
    VIS.trans.startMs = performance.now();
    VIS.trans.durMs = Math.floor(randomBetween(420, 720));

    VIS.mode = pickNextVisMode();
    VIS.hueBase = Math.random() * 360;
    scheduleNextModeChange(performance.now());

    clearCanvas(VIS.bufCtx, VIS.buf.width, VIS.buf.height);
    VIS.particles = [];

    if (!GRAPH.audio.paused) startVisualizerLoop();
  }
  // Bitmap text rendering (marquee)
  // -----------------------------
  function mapCharToSpriteCode(ch) {
    // This skin's bitmap font maps letters to *lowercase* ASCII classes
    // (97-122). To render ALL CAPS text, we keep the displayed character
    // uppercase but map sprite classes A-Z -> a-z.
    const code = ch.codePointAt(0) ?? 32;
    if (code >= 65 && code <= 90) return code + 32; // A-Z -> a-z
    return code;
  }

  function renderBitmapText(container, text, { forceUpper = false } = {}) {
    if (!container) return;

    // Keep the same scrolling wrapper that exists in your HTML.
    // We'll replace its contents with spans using the existing character classes.
    container.innerHTML = '';

    const t = (text ?? '').toString();

    for (const rawCh of t) {
      const ch = forceUpper ? rawCh.toUpperCase() : rawCh;
      const code = mapCharToSpriteCode(ch);
      const span = document.createElement('span');
      span.className = `character character-${code}`;
      span.textContent = ch; // fallback if CSS sprite missing
      container.appendChild(span);
    }
  }

  // -----------------------------
  // Playlist enhancements
  // - Highlight currently playing track (Winamp-like)
  // - Update running time display: <track duration>/<total playlist duration>
  // - Preload ALL track durations on load (no click-to-populate)
  // -----------------------------

  function elPlaylistRunningTimeInner() {
    // Structure: .playlist-running-time-display > div (the inner bitmap span container)
    return document.querySelector('.playlist-running-time-display > div');
  }

  let _playlistStyleInjected = false;
  function ensureInjectedPlaylistStyles() {
    if (_playlistStyleInjected) return;
    _playlistStyleInjected = true;
    const style = document.createElement('style');
    style.id = 'idkamp-playlist-highlight-style';
    // Use a simple CSS highlight. If you later add a bitmap texture, we can swap this.
    style.textContent = `
      #webamp .playlist-track-titles .idk-pl-inner,
      #webamp .playlist-track-durations .idk-pl-inner {
        position: relative;
      }
      #webamp .playlist-track-titles .track-cell.current,
      #webamp .playlist-track-durations .track-cell.current {
        background: #0b3d91;
        color: #fff;
      }
      #webamp .playlist-track-titles .track-cell.current span {
        color: #fff;
      }
    `;
    document.head.appendChild(style);
  }

  function sumKnownPlaylistDurationSec() {
    let total = 0;
    for (const t of STATE.playlist) {
      if (typeof t.durationSec === 'number' && isFinite(t.durationSec) && t.durationSec > 0) {
        total += t.durationSec;
      }
    }
    return total;
  }

  function updatePlaylistRunningTimeDisplay() {
    const inner = elPlaylistRunningTimeInner();
    if (!inner) return;

    const curIdx = getCurrentTrackIndex();
    const cur = STATE.playlist[curIdx];

    const curDur = (cur && typeof cur.durationSec === 'number' && isFinite(cur.durationSec) && cur.durationSec > 0)
      ? cur.durationSec
      : 0;
    const totalDur = sumKnownPlaylistDurationSec();

    const left = formatDuration(curDur) || '0:00';
    const right = formatDuration(totalDur) || '0:00';

    // Keep it compact like Winamp: "3:00/15:00" then pad with spaces to fill the box.
    let s = `${left}/${right}`;
    // This display is fixed-width; pad so we don't leave old characters visible.
    s = s.padEnd(18, ' ');

    renderBitmapText(inner, s);
  }

  async function preloadAllDurations({ concurrency = 4 } = {}) {
    // Preload durations for ALL tracks so the playlist durations are populated on load.
    // Browsers require a separate <audio> per URL to read metadata without interrupting playback.
    const tracks = STATE.playlist;
    if (!tracks.length) return;

    // Only load missing durations.
    const jobs = tracks
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => !(typeof t.durationSec === 'number' && isFinite(t.durationSec) && t.durationSec > 0));

    if (!jobs.length) return;

    let active = 0
    let cursor = 0

    await new Promise((resolve) => {
      const launchNext = () => {
        while (active < concurrency && cursor < jobs.length) {
          const { t } = jobs[cursor++];
          active++;

          const a = document.createElement('audio');
          a.preload = 'metadata';
          a.crossOrigin = 'anonymous';
          a.src = t.url;

          const done = () => {
            a.removeAttribute('src');
            try { a.load(); } catch (_) { }
            active--;
            if (cursor >= jobs.length && active === 0) {
              resolve();
            } else {
              launchNext();
            }
          };

          a.addEventListener('loadedmetadata', () => {
            const d = a.duration;
            if (typeof d === 'number' && isFinite(d) && d > 0) t.durationSec = d;
            done();
          }, { once: true });

          a.addEventListener('error', () => done(), { once: true });
        }
      };

      launchNext();
    });

    // After preloading, update playlist durations and the running-time display.
    renderPlaylist();
    updatePlaylistRunningTimeDisplay();
  }


  function setMarquee(text) {
    const inner = elMarqueeInner();
    if (!inner) return;
    renderBitmapText(inner, text);
  }

  function setPlaybackState(state) {
    const main = elMain();
    if (!main) return;
    main.classList.remove('play', 'pause', 'stop');
    main.classList.add(state);
  }

  function setDigit(el, digit) {
    if (!el) return;
    for (let i = 0; i <= 9; i++) el.classList.remove(`digit-${i}`);
    el.classList.add(`digit-${digit}`);
  }

  function setTimeDigits(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;

    const m1 = Math.floor(m / 10) % 10;
    const m2 = m % 10;
    const s1 = Math.floor(sec / 10);
    const s2 = sec % 10;

    setDigit(elTimeDigits.m1(), m1);
    setDigit(elTimeDigits.m2(), m2);
    setDigit(elTimeDigits.s1(), s1);
    setDigit(elTimeDigits.s2(), s2);
  }



  // -----------------------------
  // Mini-time (playlist + any other mini-time blocks)
  // - mirrors current playback time
  // - blinks when paused
  // -----------------------------
  function setMiniTime(seconds, { blinking = false } = {}) {
    const minis = $$('.mini-time');
    if (!minis.length) return;

    const s = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;

    // 5 chars to match the existing 5 slots: "00:00"
    const str = `${String(m).padStart(2, '0').slice(-2)}:${String(r).padStart(2, '0')}`;
    const padded = str.slice(-5);

    for (const mini of minis) {
      mini.classList.toggle('blinking', !!blinking);
      const spans = Array.from(mini.querySelectorAll('span.character:not(.background-character)'));
      for (let i = 0; i < spans.length; i++) {
        const ch = padded[i] ?? ' ';
        const code = mapCharToSpriteCode(ch);
        spans[i].className = `character character-${code}`;
        spans[i].textContent = ch;
      }
    }
  }

  // -----------------------------
  // Marquee scrolling (Winamp-ish)
  // - uses bitmap character spans
  // - if text is long, scrolls right-to-left and loops
  // - includes "***" separator between repeats
  // -----------------------------
  const MARQ = {
    base: '',
    long: '',
    override: null,
    x: 0,
    // Separate speeds so bounce feels slower (readable) while cycle stays snappy.
    speedBounce: 14, // px/sec (slow)
    speedCycle: 26,  // px/sec (original)
    active: false,
    raf: 0,
    lastTs: 0,
  };

  function sanitizeMarqueeText(t) {
    // Keep a conservative set of glyphs known to render.
    // NOTE: We include [] because you want: "... [00:00]".
    // We do NOT force uppercase here; rendering uses sprite mapping.
    const s = (t ?? '').toString();
    // Include + so EQ status can show "+ 10.2DB" etc.
    return s.replace(/[^A-Za-z0-9 \+\-:<>*'().%/\[\]]/g, ' ');
  }

  function buildMarqueeLoopText(base) {
    // Used only for the long "cycle" marquee mode.
    const b = sanitizeMarqueeText(base);
    const sep = '   ***   ';
    // Repeat enough so loop never shows blank gap
    return `${b}${sep}${b}${sep}${b}`;
  }

  // Marquee behavior modes:
  // - static: fits in the window, no movement
  // - bounce: slightly long; slides right until readable then back left
  // - cycle: very long; continuous scroll + repeats with "***" separators
  const MARQ_MODE = {
    STATIC: 'static',
    BOUNCE: 'bounce',
    CYCLE: 'cycle',
  };

  function chooseMarqueeMode(wrapW, textW) {
    const overflow = Math.max(0, textW - wrapW);
    if (overflow <= 0) return MARQ_MODE.STATIC;
    // "Slightly long": bounce up to ~90px overflow (tweakable)
    if (overflow <= 90) return MARQ_MODE.BOUNCE;
    return MARQ_MODE.CYCLE;
  }

  function applyMarqueeContent(inner, wrap, baseText, { preserveX = true } = {}) {
    if (!inner || !wrap) return;
    const base = sanitizeMarqueeText(baseText);

    // First render base once so we can measure.
    renderBitmapText(inner, base, { forceUpper: true });
    inner.style.transform = 'translateX(0px)';

    const wrapW = wrap.clientWidth || 0;
    const textW = inner.scrollWidth || 0;
    const mode = chooseMarqueeMode(wrapW, textW);

    MARQ.mode = mode;
    MARQ.base = base;

    if (!preserveX) MARQ.x = 0;

    if (mode === MARQ_MODE.CYCLE) {
      MARQ.loopText = buildMarqueeLoopText(base);
      renderBitmapText(inner, MARQ.loopText, { forceUpper: true });
    } else {
      // static/bounce uses single render
      MARQ.loopText = '';
    }
  }

  function setMarquee(text, { preserveX = false } = {}) {
    const inner = elMarqueeInner();
    const wrap = $('#marquee');
    if (!inner || !wrap) return;
    MARQ.override = null;
    applyMarqueeContent(inner, wrap, text, { preserveX });
    startMarqueeLoop();
  }

  function setMarqueeOverride(text) {
    // Overrides should NEVER scroll/cycle. They always fit in the box.
    const inner = elMarqueeInner();
    const wrap = $('#marquee');
    if (!inner || !wrap) return;

    MARQ.override = sanitizeMarqueeText(text);
    MARQ.mode = MARQ_MODE.STATIC;
    MARQ.x = 0;
    renderBitmapText(inner, MARQ.override, { forceUpper: true });
    inner.style.transform = 'translateX(0px)';
  }

  function clearMarqueeOverride() {
    if (MARQ.override == null) return;
    // Restore base marquee and allow it to scroll/bounce as needed
    setMarquee(MARQ.base, { preserveX: true });
  }

  // Expose marquee override helpers so other modules (eq.js/app.js)
  // can show temporary status text using the bitmap font.
  window.IDK_setMarqueeOverride = (t) => setMarqueeOverride(t);
  window.IDK_clearMarqueeOverride = () => clearMarqueeOverride();

  function startMarqueeLoop() {
    if (MARQ.raf) cancelAnimationFrame(MARQ.raf);
    MARQ.active = true;
    MARQ.lastTs = 0;
    MARQ.raf = requestAnimationFrame(tickMarquee);
  }

  function stopMarqueeLoop() {
    MARQ.active = false;
    if (MARQ.raf) cancelAnimationFrame(MARQ.raf);
    MARQ.raf = 0;
  }

  function tickMarquee(ts) {
    if (!MARQ.active) return;
    const inner = elMarqueeInner();
    const wrap = $('#marquee');
    if (!inner || !wrap) return;

    if (!MARQ.lastTs) MARQ.lastTs = ts;
    const dt = Math.min(0.05, (ts - MARQ.lastTs) / 1000);
    MARQ.lastTs = ts;

    // Override text: frozen in place
    if (MARQ.override != null) {
      inner.style.transform = 'translateX(0px)';
      MARQ.raf = requestAnimationFrame(tickMarquee);
      return;
    }

    const wrapW = wrap.clientWidth || 0;
    const contentW = inner.scrollWidth || 0;

    if (MARQ.mode === MARQ_MODE.STATIC || contentW <= wrapW + 2) {
      inner.style.transform = 'translateX(0px)';
      MARQ.raf = requestAnimationFrame(tickMarquee);
      return;
    }

    if (MARQ.mode === MARQ_MODE.BOUNCE) {
      // Bounce between 0 and -(contentW-wrapW)
      const max = Math.max(0, contentW - wrapW);
      if (!('dir' in MARQ)) MARQ.dir = 1;
      MARQ.x += MARQ.dir * MARQ.speedBounce * dt;
      if (MARQ.x >= max) {
        MARQ.x = max;
        MARQ.dir = -1;
      } else if (MARQ.x <= 0) {
        MARQ.x = 0;
        MARQ.dir = 1;
      }
      inner.style.transform = `translateX(${-Math.floor(MARQ.x)}px)`;
      MARQ.raf = requestAnimationFrame(tickMarquee);
      return;
    }

    // CYCLE: continuous scroll with repeated text
    MARQ.x += MARQ.speedCycle * dt;
    const resetAt = contentW / 3;
    if (MARQ.x >= resetAt) MARQ.x = 0;
    inner.style.transform = `translateX(${-Math.floor(MARQ.x)}px)`;
    MARQ.raf = requestAnimationFrame(tickMarquee);
  }
  function formatDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function formatClockMMSS(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    // Winamp-style clock: 2-digit minutes
    return `${String(m).padStart(2, '0').slice(-2)}:${String(r).padStart(2, '0')}`;
  }

  function nowPlayingMarqueeText(currentSec) {
    const i = getCurrentTrackIndex();
    const t = STATE.playlist[i];
    const n = i + 1;
    const clock = formatClockMMSS(currentSec);
    if (!t) return `${n}. [${clock}]`;
    const artist = (t.artist || '').trim();
    const title = (t.title || t.name || '').trim();
    const base = artist ? `${artist} - ${title}` : title;
    return `${n}. ${base} [${clock}]`;
  }

  // -----------------------------
  // Playlist / ordering
  // -----------------------------
  const STATE = {
    playlist: [],
    order: [],
    currentOrderIdx: 0,
    shuffle: false,
    repeat: false,
    // UI windows start visible (like Winamp/Webamp)
    eqVisible: true,
    plVisible: true,
    // Playlist scrolling
    plScrollStart: 0,
    // Computed from the playlist viewport height; fallback used if measurement fails.
    plVisibleCount: 13,
    _holdingVolume: false,
    _holdingBalance: false,
    seeking: false,
  };

  function getWindowWrapById(idSel) {
    // Your draggable wrapper is a positioned div with inline transform.
    const el = document.querySelector(idSel);
    return el?.closest('div[style*="transform: translate"]') || null;
  }

  function setEqVisible(visible) {
    STATE.eqVisible = !!visible;
    const wrap = getWindowWrapById('#equalizer-window');
    if (wrap) wrap.style.display = STATE.eqVisible ? '' : 'none';
    elBtns.eqToggle()?.classList.toggle('selected', STATE.eqVisible);
  }

  function setPlVisible(visible) {
    STATE.plVisible = !!visible;
    const wrap = getWindowWrapById('#playlist-window');
    if (wrap) wrap.style.display = STATE.plVisible ? '' : 'none';
    elBtns.plToggle()?.classList.toggle('selected', STATE.plVisible);
  }

  function deStickyPress(btn) {
    // Some skins/browser combos can leave the :active sprite stuck until mouseout.
    // Briefly disabling pointer-events forces a repaint and releases the pressed state.
    if (!btn) return;
    btn.blur?.();
    btn.style.pointerEvents = 'none';
    requestAnimationFrame(() => {
      btn.style.pointerEvents = '';
    });
  }

  function buildOrder() {
    STATE.order = STATE.playlist.map((_, i) => i);
    STATE.currentOrderIdx = clamp(STATE.currentOrderIdx, 0, Math.max(0, STATE.order.length - 1));
  }

  function getCurrentTrackIndex() {
    return STATE.order[STATE.currentOrderIdx] ?? 0;
  }

  function parseArtistTitleFromFilename(filename) {
    // Expect: "ARTIST - SONG.ext" or "ARTIST - SONG".
    const base = filename.replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '');
    const parts = base.split(' - ');
    if (parts.length >= 2) {
      return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
    }
    return { artist: '', title: base.trim() };
  }
  function trackDisplayName(track, durationSec) {
    // Desired: "ARTIST - TITLE <3:07>" (ALL CAPS)
    const dur = formatDuration(durationSec ?? track.durationSec);
    const artist = (track.artist || '').trim();
    const title = (track.title || track.name || '').trim();

    let base = artist ? `${artist} - ${title}` : title;
    base = (base || 'UNKNOWN').toUpperCase();

    // Avoid duplicate duration formatting; ONLY use <m:ss>
    return dur ? `${base} <${dur}>` : base;
  }

  // -----------------------------
  // Playlist scrolling (functional scrollbar)
  // -----------------------------
  let _plRowHeight = null;
  function getPlaylistRowHeight() {
    if (_plRowHeight) return _plRowHeight;
    const cell = document.querySelector('.playlist-track-titles .track-cell');
    _plRowHeight = cell?.offsetHeight || 13;
    return _plRowHeight;
  }

  function computePlaylistVisibleCount() {
    // The playlist is one continuous list. We compute how many rows are visible
    // in the existing viewport (CSS already sizes this like classic Winamp).
    const tracks = document.querySelector('.playlist-tracks');
    const rowH = getPlaylistRowHeight();
    const h = tracks?.clientHeight || 0;
    const vis = rowH > 0 ? Math.floor(h / rowH) : 0;
    // Fallback: Winamp-ish default if measurement fails
    STATE.plVisibleCount = clamp(vis || 13, 1, 50);
    return STATE.plVisibleCount;
  }

  function getPlaylistMaxStart() {
    const vis = computePlaylistVisibleCount();
    return Math.max(0, (STATE.playlist.length || 0) - vis);
  }

  function getPlaylistInners() {
    const titles = elPlaylist.titles();
    const durs = elPlaylist.durs();
    if (!titles || !durs) return { titles, durs, titlesInner: null, dursInner: null };
    const titlesInner = titles.querySelector('.idk-pl-inner');
    const dursInner = durs.querySelector('.idk-pl-inner');
    return { titles, durs, titlesInner, dursInner };
  }

  function ensurePlaylistInnerWrappers() {
    const titles = elPlaylist.titles();
    const durs = elPlaylist.durs();
    if (!titles || !durs) return;

    if (!titles.querySelector('.idk-pl-inner')) {
      const inner = document.createElement('div');
      inner.className = 'idk-pl-inner';
      // Move existing children into inner
      while (titles.firstChild) inner.appendChild(titles.firstChild);
      titles.appendChild(inner);
    }
    if (!durs.querySelector('.idk-pl-inner')) {
      const inner = document.createElement('div');
      inner.className = 'idk-pl-inner';
      while (durs.firstChild) inner.appendChild(durs.firstChild);
      durs.appendChild(inner);
    }
  }

  function applyPlaylistScrollTransforms() {
    const titles = elPlaylist.titles();
    const durs = elPlaylist.durs();
    if (!titles || !durs) return;

    const titlesInner = titles.querySelector('.idk-pl-inner');
    const dursInner = durs.querySelector('.idk-pl-inner');
    if (!titlesInner || !dursInner) return;

    const rowH = getPlaylistRowHeight();
    // Do NOT force a "page" height; rely on your CSS viewport.
    // We just translate the full list inside that viewport.
    computePlaylistVisibleCount();
    const y = -STATE.plScrollStart * rowH;
    titlesInner.style.transform = `translateY(${y}px)`;
    dursInner.style.transform = `translateY(${y}px)`;
  }

  function applyPlaylistScrollbarHandle() {
    const wrap = elPlaylist.scrollbarHandleWrap();
    const track = elPlaylist.scrollbarTrack();
    const handle = elPlaylist.scrollbarHandle();
    if (!wrap || !track || !handle) return;

    const maxStart = getPlaylistMaxStart();
    const trackH = track.offsetHeight || 174;
    const handleH = handle.offsetHeight || 18;
    const travel = Math.max(0, trackH - handleH);

    let y = 0;
    if (maxStart > 0 && travel > 0) {
      y = (STATE.plScrollStart / maxStart) * travel;
    }
    wrap.style.transform = `translateY(${Math.round(y)}px)`;
  }

  function setPlaylistScrollStart(start) {
    const maxStart = getPlaylistMaxStart();
    STATE.plScrollStart = clamp(start, 0, maxStart);
    applyPlaylistScrollTransforms();
    applyPlaylistScrollbarHandle();
  }

  function ensurePlaylistIndexVisible(index) {
    const vis = computePlaylistVisibleCount();
    if (index < STATE.plScrollStart) {
      setPlaylistScrollStart(index);
    } else if (index >= STATE.plScrollStart + vis) {
      setPlaylistScrollStart(index - vis + 1);
    }
  }

  function renderPlaylist() {
    ensureInjectedPlaylistStyles();

    const titles = elPlaylist.titles();
    const durs = elPlaylist.durs();
    if (!titles || !durs) return;

    // Create a stable inner wrapper so scrolling translates CONTENT, not the viewport.
    titles.innerHTML = '<div class="idk-pl-inner"></div>';
    durs.innerHTML = '<div class="idk-pl-inner"></div>';

    const titlesInner = titles.querySelector('.idk-pl-inner');
    const dursInner = durs.querySelector('.idk-pl-inner');
    if (!titlesInner || !dursInner) return;

    const currentIdx = getCurrentTrackIndex();

    STATE.playlist.forEach((t, i) => {
      const num = i + 1;

      const titleCell = document.createElement('div');
      titleCell.className = 'track-cell';
      titleCell.dataset.index = String(i);

      const span = document.createElement('span');
      // Keep leading space like the original markup
      span.textContent = (num < 10 ? ` ${num}. ` : `${num}. `) + `${t.artist ? t.artist + ' - ' : ''}${truncateTitle(t.title, 20) || t.name || ''}`;
      titleCell.appendChild(span);

      const durCell = document.createElement('div');
      durCell.className = 'track-cell';
      durCell.dataset.index = String(i);
      durCell.textContent = t.durationSec ? formatDuration(t.durationSec) : '';

      if (i === currentIdx) {
        titleCell.classList.add('current');
        durCell.classList.add('current');
      }

      titlesInner.appendChild(titleCell);
      dursInner.appendChild(durCell);
    });

    updatePlaylistRunningTimeDisplay();
    wirePlaylistInteractions();
    wirePlaylistScrollbar();

    // Keep the currently playing track visible (auto-follow)
    ensurePlaylistIndexVisible(getCurrentTrackIndex());
    applyPlaylistScrollTransforms();
    applyPlaylistScrollbarHandle();
  }

  let selectedIndex = 0;

  function setSelectedIndex(i) {
    selectedIndex = clamp(i, 0, Math.max(0, STATE.playlist.length - 1));

    const titles = elPlaylist.titles();
    const durs = elPlaylist.durs();
    if (!titles || !durs) return;

    $$('.track-cell', titles).forEach((cell) => cell.classList.remove('selected'));
    $$('.track-cell', durs).forEach((cell) => cell.classList.remove('selected'));

    const tCell = titles.querySelector(`.track-cell[data-index="${selectedIndex}"]`);
    const dCell = durs.querySelector(`.track-cell[data-index="${selectedIndex}"]`);
    tCell?.classList.add('selected');
    dCell?.classList.add('selected');
  }

  function wirePlaylistInteractions() {
    const titles = elPlaylist.titles();
    if (!titles) return;

    // Delegate clicks
    titles.onclick = (e) => {
      const cell = e.target.closest('.track-cell');
      if (!cell) return;
      const i = parseInt(cell.dataset.index || '0', 10);
      setSelectedIndex(i);
    };

    titles.ondblclick = (e) => {
      const cell = e.target.closest('.track-cell');
      if (!cell) return;
      const i = parseInt(cell.dataset.index || '0', 10);
      playIndex(i);
    };
  }

  let _playlistScrollbarWired = false;
  function wirePlaylistScrollbar() {
    if (_playlistScrollbarWired) return;
    _playlistScrollbarWired = true;

    const up = document.getElementById('playlist-scroll-up-button');
    const down = document.getElementById('playlist-scroll-down-button');
    const handle = elPlaylist.scrollbarHandle();
    const track = elPlaylist.scrollbarTrack();
    const wrap = elPlaylist.scrollbarHandleWrap();

    const step = () => 1; // one row per click

    up?.addEventListener('click', (e) => {
      e.preventDefault();
      setPlaylistScrollStart(STATE.plScrollStart - step());
    });
    down?.addEventListener('click', (e) => {
      e.preventDefault();
      setPlaylistScrollStart(STATE.plScrollStart + step());
    });

    // Drag handle
    if (handle && track && wrap) {
      let dragging = false;
      let startY = 0;
      let startHandleY = 0;

      const getHandleY = () => {
        const m = /translateY\(([-0-9.]+)px\)/.exec(wrap.style.transform || '');
        return m ? parseFloat(m[1]) : 0;
      };

      const onMove = (ev) => {
        if (!dragging) return;
        const maxStart = getPlaylistMaxStart();
        const trackH = track.offsetHeight || 174;
        const handleH = handle.offsetHeight || 18;
        const travel = Math.max(0, trackH - handleH);
        if (travel <= 0 || maxStart <= 0) return;

        const dy = (ev.clientY - startY);
        const newY = clamp(startHandleY + dy, 0, travel);
        // STEP snapping: map drag position to discrete row offsets.
        const ratio = newY / travel;
        const newStart = clamp(Math.round(ratio * maxStart), 0, maxStart);
        // setPlaylistScrollStart will also position the handle at the exact stepped location.
        setPlaylistScrollStart(newStart);
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      handle.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const maxStart = getPlaylistMaxStart();
        if (maxStart <= 0) return;
        dragging = true;
        startY = ev.clientY;
        startHandleY = getHandleY();
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    }
  }

  function setCurrentByIndex(i) {
    // Set currentOrderIdx so that order[currentOrderIdx] === i
    const idx = STATE.order.indexOf(i);
    if (idx >= 0) STATE.currentOrderIdx = idx;
  }

  async function loadTrack(i) {
    if (!STATE.playlist[i]) return;

    const track = STATE.playlist[i];

    // Ensure AudioContext is running (autoplay policies)
    if (GRAPH.ctx && GRAPH.ctx.state === 'suspended') {
      try { await GRAPH.ctx.resume(); } catch (_) { }
    }

    GRAPH.audio.src = track.url;
    GRAPH.audio.load();

    // Update UI immediately (show track + current time)
    STATE._lastMarqSec = -1;
    setMarquee(nowPlayingMarqueeText(0));

    // highlight current
    renderPlaylist();

    // When metadata loads, capture duration + update UI
    GRAPH.audio.onloadedmetadata = () => {
      track.durationSec = isFinite(GRAPH.audio.duration) ? GRAPH.audio.duration : undefined;
      renderPlaylist();
      updatePlaylistRunningTimeDisplay();
    };

    // New track = new visualizer theme/mode
    onTrackChangedForVisualizer();
  }

  async function playIndex(i) {
    if (!STATE.playlist.length) return;

    i = clamp(i, 0, STATE.playlist.length - 1);
    setCurrentByIndex(i);
    await loadTrack(i);

    try {
      await GRAPH.audio.play();
      setPlaybackState('play');
    } catch (err) {
      // Typically blocked until a user gesture; show hint in marquee
      setPlaybackState('pause');
      setMarquee(`CLICK PLAY AGAIN (BROWSER BLOCKED AUTOPLAY)`);
      return;
    }
  }

  async function playCurrent() {
    if (!STATE.playlist.length) return;
    const i = getCurrentTrackIndex();
    // If no src yet, load
    if (!GRAPH.audio.src || GRAPH.audio.src === window.location.href) {
      await loadTrack(i);
    }

    try {
      await GRAPH.audio.play();
      setPlaybackState('play');
    } catch (err) {
      setPlaybackState('pause');
      setMarquee(`CLICK PLAY AGAIN (BROWSER BLOCKED AUTOPLAY)`);
    }
  }

  function pause() {
    GRAPH.audio.pause();
    setPlaybackState('pause');
  }

  function stop() {
    GRAPH.audio.pause();
    GRAPH.audio.currentTime = 0;
    setPlaybackState('stop');
    setTimeDigits(0);
    setMiniTime(0, { blinking: false });
    const pos = elRanges.position();
    if (pos) pos.value = '0';
    stopVisualizerLoop({ clear: true });
  }

  async function nextTrack() {
    if (!STATE.playlist.length) return;

    if (STATE.shuffle) {
      // Choose random next different from current
      const current = getCurrentTrackIndex();
      if (STATE.playlist.length === 1) {
        playCurrent();
        return;
      }
      let tries = 0;
      let pick = current;
      while (pick === current && tries < 50) {
        pick = Math.floor(Math.random() * STATE.playlist.length);
        tries++;
      }
      await playIndex(pick);
      return;
    }

    const nextOrderIdx = STATE.currentOrderIdx + 1;
    if (nextOrderIdx >= STATE.order.length) {
      // End of list: wrap to the start (Winamp-ish)
      STATE.currentOrderIdx = 0;
      await playIndex(getCurrentTrackIndex());
      return;
    }

    STATE.currentOrderIdx = nextOrderIdx;
    // IMPORTANT: actually load the new track.
    await playIndex(getCurrentTrackIndex());
  }

  async function prevTrack() {
    if (!STATE.playlist.length) return;

    // Winamp-ish: if past 3 seconds, go to start of track
    if (GRAPH.audio.currentTime > 3) {
      GRAPH.audio.currentTime = 0;
      return;
    }

    if (STATE.shuffle) {
      // Random previous
      if (STATE.playlist.length === 1) {
        playCurrent();
        return;
      }
      let pick = getCurrentTrackIndex();
      let tries = 0;
      while (pick === getCurrentTrackIndex() && tries < 50) {
        pick = Math.floor(Math.random() * STATE.playlist.length);
        tries++;
      }
      await playIndex(pick);
      return;
    }

    const prevOrderIdx = STATE.currentOrderIdx - 1;
    if (prevOrderIdx < 0) {
      // Start of list: restart
      GRAPH.audio.currentTime = 0;
      return;
    }

    STATE.currentOrderIdx = prevOrderIdx;
    // IMPORTANT: actually load the new track.
    await playIndex(getCurrentTrackIndex());
  }

  // -----------------------------
  // Seek / volume / balance
  // -----------------------------
  function applyVolumeFromUI() {
    const vol = elRanges.volume();
    if (!vol) return;
    const v = clamp(parseInt(vol.value || '0', 10), 0, 100) / 100;
    if (GRAPH.gain) GRAPH.gain.gain.value = v;
    GRAPH.audio.volume = v; // also set element volume (safe)
  }

  function applyBalanceFromUI() {
    const bal = elRanges.balance();
    if (!bal) return;
    const b = clamp(parseInt(bal.value || '0', 10), -100, 100) / 100;
    if (GRAPH.panner) GRAPH.panner.pan.value = b;
  }

  function applySeekFromUI() {
    const pos = elRanges.position();
    if (!pos) return;
    if (!isFinite(GRAPH.audio.duration) || GRAPH.audio.duration <= 0) return;

    const pct = clamp(parseFloat(pos.value || '0'), 0, 100) / 100;
    GRAPH.audio.currentTime = pct * GRAPH.audio.duration;
  }

  // -----------------------------
  // Window controls (close/minimize/shade)
  // -----------------------------
  function hideWindowById(id) {
    const win = $(id);
    if (!win) return;
    const wrap = win.closest('div[style*="transform: translate"]') || win;
    wrap.style.display = 'none';
  }

  function toggleShade(winId) {
    const win = $(winId);
    if (!win) return;
    win.classList.toggle('shade');
  }

  // -----------------------------
  // Loading from songs/manifest.json
  // -----------------------------
  async function loadManifestPlaylist() {
    // You will create songs/manifest.json like:
    // ["MF DOOM - Rapp Snitch Knishes.mp3", "Aphex Twin - Xtal.ogg"]
    // or objects: [{"file":"...","title":"...","artist":"..."}]
    const url = 'songs/manifest.json';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest not found (${res.status})`);
    const data = await res.json();

    const tracks = [];

    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') {
          const meta = parseArtistTitleFromFilename(item);
          tracks.push({
            name: item,
            artist: meta.artist,
            title: meta.title,
            url: `songs/${encodeURIComponent(item).replace(/%2F/g, '/')}`,
            durationSec: undefined,
            source: 'manifest',
          });
        } else if (item && typeof item === 'object') {
          const file = item.file || item.path || item.name;
          if (!file) continue;
          const meta = parseArtistTitleFromFilename(file);
          tracks.push({
            name: file,
            artist: item.artist || meta.artist,
            title: item.title || meta.title,
            url: item.url || `songs/${encodeURIComponent(file).replace(/%2F/g, '/')}`,
            durationSec: item.durationSec,
            source: 'manifest',
          });
        }
      }
    }

    STATE.playlist = tracks;
    buildOrder();
    setSelectedIndex(0);

    // Render immediately (titles) then preload ALL durations and re-render once populated.
    renderPlaylist();
    setMarquee('LOADING IDKAMP...');
    try {
      await preloadAllDurations({ concurrency: 4 });
    } catch (_) { }

    // Re-render so ALL durations show immediately (no click-to-populate).
    renderPlaylist();
    // Ensure current is loaded and UI is in a stopped state initially


    if (tracks.length) {
      await loadTrack(0);
      stop();
    } else {
      setMarquee('NO SONGS IN MANIFEST');
    }
  }

  // -----------------------------
  // File picker (Eject)
  // -----------------------------
  function addFilesToPlaylist(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;

    for (const f of arr) {
      const meta = parseArtistTitleFromFilename(f.name);
      const url = URL.createObjectURL(f);
      STATE.playlist.push({
        name: f.name,
        artist: meta.artist,
        title: meta.title,
        url,
        durationSec: undefined,
        source: 'file',
      });
    }

    buildOrder();
    renderPlaylist();

    // If nothing loaded yet, load first
    if (!GRAPH.audio.src && STATE.playlist.length) {
      loadTrack(0);
      stop();
    }
  }

  function openFilePicker() {
    const inp = fileInput();
    if (!inp) return;
    inp.accept = 'audio/*';
    inp.multiple = true;
    inp.onchange = () => {
      addFilesToPlaylist(inp.files);
      inp.value = '';
    };
    inp.click();
  }

  // -----------------------------
  // Wire buttons / ranges
  // -----------------------------
  function wireButtons() {
    elBtns.play()?.addEventListener('click', (e) => { e.preventDefault(); playCurrent(); });
    elBtns.pause()?.addEventListener('click', (e) => { e.preventDefault(); pause(); });
    elBtns.stop()?.addEventListener('click', (e) => { e.preventDefault(); stop(); });
    elBtns.next()?.addEventListener('click', (e) => { e.preventDefault(); nextTrack(); });
    elBtns.prev()?.addEventListener('click', (e) => { e.preventDefault(); prevTrack(); });
    elBtns.eject()?.addEventListener('click', (e) => { e.preventDefault(); openFilePicker(); });

    elBtns.shuffle()?.addEventListener('click', () => {
      STATE.shuffle = elBtns.shuffle()?.classList.contains('selected') || false;
    });

    elBtns.repeat()?.addEventListener('click', () => {
      STATE.repeat = !STATE.repeat;
      const rep = elBtns.repeat();
      rep?.classList.toggle('selected', STATE.repeat);
      // Repeat loops the CURRENT track
      GRAPH.audio.loop = STATE.repeat;
    });

    // Window show/hide toggles
    // These start ON/visible, and one click should hide/show while the button
    // returns immediately to its normal (on/off) sprite after mouseup.
    const eqBtn = elBtns.eqToggle();
    const plBtn = elBtns.plToggle();

    eqBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      setEqVisible(!STATE.eqVisible);
      deStickyPress(eqBtn);
    });
    plBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      setPlVisible(!STATE.plVisible);
      deStickyPress(plBtn);
    });

    // Also de-stick on pointerup so it never stays visually pressed.
    eqBtn?.addEventListener('pointerup', () => deStickyPress(eqBtn));
    plBtn?.addEventListener('pointerup', () => deStickyPress(plBtn));

    // Main window buttons
    elBtns.mainClose()?.addEventListener('click', (e) => { e.preventDefault(); hideWindowById('#main-window'); });
    elBtns.mainShade()?.addEventListener('click', (e) => { e.preventDefault(); toggleShade('#main-window'); });
    elBtns.mainMin()?.addEventListener('click', (e) => {
      e.preventDefault();
      // Winamp minimize: hide windows, but allow restore by clicking taskbar (we don't have one)
      // So we toggle hide/show
      const wrap = elMain()?.closest('div[style*="transform: translate"]');
      if (!wrap) return;
      wrap.style.display = (wrap.style.display === 'none') ? '' : 'none';
    });

    // EQ window
    elBtns.eqClose()?.addEventListener('click', (e) => { e.preventDefault(); hideWindowById('#equalizer-window'); });
    elBtns.eqShade()?.addEventListener('click', (e) => { e.preventDefault(); toggleShade('#equalizer-window'); });

    // Playlist window
    elBtns.plClose()?.addEventListener('click', (e) => { e.preventDefault(); hideWindowById('#playlist-window'); });
    elBtns.plShade()?.addEventListener('click', (e) => { e.preventDefault(); toggleShade('#playlist-window'); });
  }

  function wireRanges() {
    const vol = elRanges.volume();
    const bal = elRanges.balance();
    const pos = elRanges.position();

    vol?.addEventListener('input', () => {
      applyVolumeFromUI();
      if (STATE._holdingVolume) {
        const pct = clamp(parseInt(vol.value || '0', 10), 0, 100);
        setMarqueeOverride(`VOLUME - ${pct}%`);
      }
    });

    if (vol) {
      const down = () => {
        STATE._holdingVolume = true;
        const pct = clamp(parseInt(vol.value || '0', 10), 0, 100);
        setMarqueeOverride(`VOLUME - ${pct}%`);
      };
      const up = () => {
        STATE._holdingVolume = false;
        clearMarqueeOverride();
      };
      vol.addEventListener('pointerdown', down);
      vol.addEventListener('pointerup', up);
      vol.addEventListener('pointercancel', up);
      vol.addEventListener('blur', up);
    }
    bal?.addEventListener('input', () => {
      applyBalanceFromUI();
      if (STATE._holdingBalance) {
        const val = clamp(parseInt(bal.value || '0', 10), -100, 100);
        let msg = 'BALANCE - CENTER';
        if (val < 0) msg = `BALANCE - ${Math.abs(val)}%: LEFT`;
        if (val > 0) msg = `BALANCE - ${val}%: RIGHT`;
        setMarqueeOverride(msg);
      }
    });

    if (bal) {
      const down = () => {
        STATE._holdingBalance = true;
        const val = clamp(parseInt(bal.value || '0', 10), -100, 100);
        let msg = 'BALANCE - CENTER';
        if (val < 0) msg = `BALANCE - ${Math.abs(val)}%: LEFT`;
        if (val > 0) msg = `BALANCE - ${val}%: RIGHT`;
        setMarqueeOverride(msg);
      };
      const up = () => {
        STATE._holdingBalance = false;
        clearMarqueeOverride();
      };
      bal.addEventListener('pointerdown', down);
      bal.addEventListener('pointerup', up);
      bal.addEventListener('pointercancel', up);
      bal.addEventListener('blur', up);
    }

    // Seek: only commit on pointerup/mouseup for smoother tracking
    if (pos) {
      const start = () => { STATE.seeking = true; };
      const end = () => { STATE.seeking = false; applySeekFromUI(); };

      pos.addEventListener('pointerdown', start);
      pos.addEventListener('pointerup', end);
      pos.addEventListener('pointercancel', end);

      pos.addEventListener('input', () => {
        if (!isFinite(GRAPH.audio.duration) || GRAPH.audio.duration <= 0) return;
        const pct = clamp(parseFloat(pos.value || '0'), 0, 100) / 100;
        const preview = pct * GRAPH.audio.duration;
        setTimeDigits(preview);
      });
    }

    // Initial apply
    applyVolumeFromUI();
    applyBalanceFromUI();
  }

  // -----------------------------
  // Audio events -> UI updates
  // -----------------------------
  function wireAudioEvents() {
    GRAPH.audio.addEventListener('timeupdate', () => {
      if (STATE.seeking) return;

      const cur = GRAPH.audio.currentTime || 0;
      setTimeDigits(cur);
      setMiniTime(cur, { blinking: GRAPH.audio.paused });

      // Update marquee clock once per second (and preserve scroll position)
      const sec = Math.floor(cur);
      if (MARQ.override == null && sec !== STATE._lastMarqSec) {
        STATE._lastMarqSec = sec;
        setMarquee(nowPlayingMarqueeText(sec), { preserveX: true });
      }

      const pos = elRanges.position();
      if (pos && isFinite(GRAPH.audio.duration) && GRAPH.audio.duration > 0) {
        const pct = (cur / GRAPH.audio.duration) * 100;
        pos.value = String(clamp(pct, 0, 100));
      }
    });

    GRAPH.audio.addEventListener('ended', async () => {
      // Repeat = loop the CURRENT track (Winamp-style)
      if (STATE.repeat) {
        try {
          GRAPH.audio.currentTime = 0;
          await GRAPH.audio.play();
          setPlaybackState('play');
        } catch (_) { }
        return;
      }

      // Otherwise advance; nextTrack() will stop at end
      await nextTrack();
    });

    GRAPH.audio.addEventListener('play', () => {
      setPlaybackState('play');
      setMiniTime(GRAPH.audio.currentTime || 0, { blinking: false });
      startVisualizerLoop();
    });
    GRAPH.audio.addEventListener('pause', () => {
      // if at start and stopped, keep stop
      if (GRAPH.audio.currentTime === 0) return;
      setPlaybackState('pause');
      setMiniTime(GRAPH.audio.currentTime || 0, { blinking: true });
      stopVisualizerLoop();
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  async function init() {
    wireButtons();
    wireRanges();
    wireAudioEvents();

    // Default window state: EQ + PL are visible and their buttons are "on".
    // This matches Webamp/Winamp behavior and fixes the first-click double-toggle bug.
    setEqVisible(true);
    setPlVisible(true);

    // Try to load from songs/manifest.json
    try {
      await loadManifestPlaylist();
    } catch (e) {
      // No manifest? Totally fine.
      // Tell user how to proceed.
      setMarquee('PRESS EJECT TO ADD SONGS');
      stop();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
