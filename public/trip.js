/**
 * 960 Throne — Psychedelic Party Mode
 * Pure client-side CSS/SVG filter effects with control panel & timeline scheduler.
 * Each effect has an independent 0–1 slider, multiplied by a master intensity.
 * All state persisted to localStorage so it survives page reloads.
 *
 * Display mode: include with data-display attribute to hide controls and just render effects.
 *   <script src="/trip.js" data-display></script>
 * Control mode (default): shows the control panel.
 *   <script src="/trip.js"></script>
 *
 * Press 'T' to toggle control panel (control mode only).
 */
(function() {
  'use strict';

  // Detect display-only mode from script tag attribute
  const scriptTag = document.currentScript;
  const isDisplayMode = scriptTag && scriptTag.hasAttribute('data-display');

  // ─── State ────────────────────────────────────────────────
  const STORAGE_KEY = '_trip';
  const defaults = {
    master: 0,
    hueRotate: 0,       // rainbow color cycling speed
    kaleidoscope: 0,     // bumpy lens distortion
    // Timeline
    rampStart: null,
    rampDuration: 60,    // minutes
    rampTarget: 1,
    rampActive: false,
    panelOpen: true,
  };

  let S = Object.assign({}, defaults);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) Object.assign(S, saved);
  } catch(e) {}

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S)); } catch(e) {}
  }

  // In display mode, periodically re-read state from localStorage
  // so the display page follows the control page's settings
  if (isDisplayMode) {
    setInterval(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved) Object.assign(S, saved);
      } catch(e) {}
    }, 200);
  }

  // ─── SVG Filter Definitions ───────────────────────────────
  function injectSVGFilters() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = `
      <defs>
        <filter id="trip-lens" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence id="trip-lens-turb" type="turbulence" baseFrequency="0.01 0.01" numOctaves="4" seed="3" result="noise" stitchTiles="stitch"/>
          <feDisplacementMap id="trip-lens-disp" in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
    `;
    document.body.appendChild(svg);
  }

  // ─── Control Panel (only in control mode) ─────────────────
  function createPanel() {
    if (isDisplayMode) return;

    const panel = document.createElement('div');
    panel.id = 'trip-panel';
    panel.innerHTML = `
      <style>
        #trip-panel {
          position: fixed; bottom: 20px; right: 20px; z-index: 99999;
          background: rgba(10,10,25,0.92); border: 1px solid rgba(255,215,0,0.3);
          border-radius: 16px; padding: 20px; width: 340px;
          font-family: system-ui, sans-serif; color: #fff; font-size: 13px;
          backdrop-filter: blur(12px); box-shadow: 0 8px 32px rgba(0,0,0,0.6);
          transition: transform 0.3s, opacity 0.3s;
          max-height: 90vh; overflow-y: auto;
        }
        #trip-panel.hidden { transform: translateX(400px); opacity: 0; pointer-events: none; }
        #trip-panel h3 { margin: 0 0 12px; color: #FFD700; font-size: 16px; display: flex; align-items: center; gap: 8px; }
        .trip-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
        .trip-row label { width: 90px; font-size: 12px; color: #aaa; flex-shrink: 0; }
        .trip-row input[type=range] { flex: 1; accent-color: #FFD700; height: 6px; }
        .trip-row .trip-val { width: 36px; text-align: right; font-family: monospace; font-size: 12px; color: #FFD700; }
        .trip-section { border-top: 1px solid rgba(255,255,255,0.1); margin-top: 12px; padding-top: 10px; }
        .trip-section h4 { margin: 0 0 8px; font-size: 13px; color: #888; }
        .trip-btn { background: rgba(255,215,0,0.15); border: 1px solid rgba(255,215,0,0.3); color: #FFD700; padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 600; }
        .trip-btn:hover { background: rgba(255,215,0,0.25); }
        .trip-btn-danger { background: rgba(239,68,68,0.15); border-color: rgba(239,68,68,0.3); color: #ef4444; }
        .trip-btn-danger:hover { background: rgba(239,68,68,0.25); }
        #trip-ramp-bar { width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin: 6px 0; }
        #trip-ramp-fill { height: 100%; background: linear-gradient(90deg, #FFD700, #ff6b6b, #a855f7); width: 0%; transition: width 1s linear; border-radius: 4px; }
        #trip-ramp-status { font-size: 11px; color: #666; margin-top: 4px; }
        .trip-time-row { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
        .trip-time-row label { width: 70px; font-size: 12px; color: #aaa; }
        .trip-time-row input, .trip-time-row select { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 4px 8px; border-radius: 6px; font-size: 12px; }
        .trip-time-row input[type=number] { width: 60px; }
        #trip-hint { position: fixed; bottom: 20px; right: 20px; z-index: 99998; background: rgba(10,10,25,0.7); border: 1px solid rgba(255,215,0,0.2); border-radius: 8px; padding: 8px 14px; font-size: 11px; color: #666; pointer-events: none; }
      </style>
      <h3>🍄 Trip Mode</h3>

      <div class="trip-row">
        <label style="color:#FFD700;font-weight:700">MASTER</label>
        <input type="range" min="0" max="100" value="${Math.round(S.master*100)}" id="trip-s-master">
        <span class="trip-val" id="trip-v-master">${(S.master*100).toFixed(0)}%</span>
      </div>

      <div class="trip-section">
        <h4>Effects</h4>
        ${makeSlider('hueRotate', 'Hue Cycle')}
        ${makeSlider('kaleidoscope', 'Lens Warp')}
      </div>

      <div class="trip-section">
        <h4>⏱ Timeline Scheduler</h4>
        <div class="trip-time-row">
          <label>Duration</label>
          <input type="number" id="trip-ramp-dur" value="${S.rampDuration}" min="1" max="480" step="1"> min
        </div>
        <div class="trip-time-row">
          <label>Target</label>
          <input type="range" min="0" max="100" value="${Math.round(S.rampTarget*100)}" id="trip-ramp-target" style="flex:1;accent-color:#a855f7">
          <span class="trip-val" id="trip-v-ramp-target">${(S.rampTarget*100).toFixed(0)}%</span>
        </div>
        <div id="trip-ramp-bar"><div id="trip-ramp-fill"></div></div>
        <div id="trip-ramp-status">Not active</div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="trip-btn" id="trip-ramp-start">▶ Start Ramp</button>
          <button class="trip-btn" id="trip-ramp-stop" style="display:none">⏹ Stop</button>
        </div>
      </div>

      <div class="trip-section" style="display:flex;gap:8px;justify-content:space-between">
        <button class="trip-btn-danger trip-btn" id="trip-kill">⚡ Kill All</button>
        <button class="trip-btn" id="trip-preset-mild">Mild</button>
        <button class="trip-btn" id="trip-preset-medium">Medium</button>
        <button class="trip-btn" id="trip-preset-full">Full Send</button>
      </div>
    `;
    document.body.appendChild(panel);

    // Hint when panel is closed
    const hint = document.createElement('div');
    hint.id = 'trip-hint';
    hint.textContent = 'Press T for trip controls';
    hint.style.display = S.panelOpen ? 'none' : 'block';
    document.body.appendChild(hint);

    if (!S.panelOpen) panel.classList.add('hidden');

    // Wire up sliders
    wireSlider('master');
    wireSlider('hueRotate');
    wireSlider('kaleidoscope');

    // Ramp target slider
    const rampTargetSlider = document.getElementById('trip-ramp-target');
    const rampTargetVal = document.getElementById('trip-v-ramp-target');
    rampTargetSlider.addEventListener('input', () => {
      S.rampTarget = parseInt(rampTargetSlider.value) / 100;
      rampTargetVal.textContent = rampTargetSlider.value + '%';
      save();
    });

    // Duration input
    document.getElementById('trip-ramp-dur').addEventListener('change', (e) => {
      S.rampDuration = Math.max(1, parseInt(e.target.value) || 60);
      save();
    });

    // Ramp start/stop
    document.getElementById('trip-ramp-start').addEventListener('click', () => {
      S.rampStart = Date.now();
      S.rampActive = true;
      save();
      updateRampUI();
    });
    document.getElementById('trip-ramp-stop').addEventListener('click', () => {
      S.rampActive = false;
      S.rampStart = null;
      save();
      updateRampUI();
    });

    // Kill all
    document.getElementById('trip-kill').addEventListener('click', () => {
      S.master = 0;
      S.hueRotate = 0;
      S.kaleidoscope = 0;
      S.rampActive = false;
      S.rampStart = null;
      save();
      syncSlidersFromState();
      updateRampUI();
    });

    // Presets
    document.getElementById('trip-preset-mild').addEventListener('click', () => {
      S.hueRotate = 0.3;
      S.kaleidoscope = 0.15;
      S.master = 0.4;
      save(); syncSlidersFromState();
    });
    document.getElementById('trip-preset-medium').addEventListener('click', () => {
      S.hueRotate = 0.6;
      S.kaleidoscope = 0.4;
      S.master = 0.7;
      save(); syncSlidersFromState();
    });
    document.getElementById('trip-preset-full').addEventListener('click', () => {
      S.hueRotate = 1;
      S.kaleidoscope = 0.8;
      S.master = 1;
      save(); syncSlidersFromState();
    });

    // Toggle with T key
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === 't' || e.key === 'T') {
        S.panelOpen = !S.panelOpen;
        panel.classList.toggle('hidden', !S.panelOpen);
        hint.style.display = S.panelOpen ? 'none' : 'block';
        save();
      }
    });
  }

  function makeSlider(key, label) {
    const v = Math.round(S[key] * 100);
    return `<div class="trip-row">
      <label>${label}</label>
      <input type="range" min="0" max="100" value="${v}" id="trip-s-${key}">
      <span class="trip-val" id="trip-v-${key}">${v}%</span>
    </div>`;
  }

  function wireSlider(key) {
    const slider = document.getElementById('trip-s-' + key);
    const val = document.getElementById('trip-v-' + key);
    if (!slider) return;
    slider.addEventListener('input', () => {
      S[key] = parseInt(slider.value) / 100;
      val.textContent = slider.value + '%';
      save();
    });
  }

  function syncSlidersFromState() {
    ['master','hueRotate','kaleidoscope'].forEach(key => {
      const slider = document.getElementById('trip-s-' + key);
      const val = document.getElementById('trip-v-' + key);
      if (slider) slider.value = Math.round(S[key] * 100);
      if (val) val.textContent = Math.round(S[key] * 100) + '%';
    });
  }

  function updateRampUI() {
    const startBtn = document.getElementById('trip-ramp-start');
    const stopBtn = document.getElementById('trip-ramp-stop');
    const status = document.getElementById('trip-ramp-status');
    const fill = document.getElementById('trip-ramp-fill');
    if (!startBtn) return; // display mode — no UI
    if (S.rampActive) {
      startBtn.style.display = 'none';
      stopBtn.style.display = '';
      const elapsed = (Date.now() - S.rampStart) / 1000 / 60;
      const progress = Math.min(1, elapsed / S.rampDuration);
      fill.style.width = (progress * 100) + '%';
      const remaining = Math.max(0, S.rampDuration - elapsed);
      if (remaining > 0) {
        status.textContent = `${Math.floor(remaining)}m ${Math.floor((remaining%1)*60)}s remaining → ${Math.round(S.rampTarget*100)}%`;
      } else {
        status.textContent = 'Ramp complete!';
      }
    } else {
      startBtn.style.display = '';
      stopBtn.style.display = 'none';
      fill.style.width = '0%';
      status.textContent = 'Not active';
    }
  }

  // ─── Animation Loop ───────────────────────────────────────
  let t = 0;
  let lastTime = performance.now();
  const target = document.documentElement;

  // For smooth lens morph we track the current turbulence seed as a float
  let lensSeed = 3.0;

  function animate(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1); // cap delta to avoid jumps
    lastTime = now;
    t += dt;

    // Timeline ramp — auto-adjust master (only in control mode)
    if (!isDisplayMode && S.rampActive && S.rampStart) {
      const elapsed = (Date.now() - S.rampStart) / 1000 / 60;
      const progress = Math.min(1, elapsed / S.rampDuration);
      S.master = progress * S.rampTarget;
      const ms = document.getElementById('trip-s-master');
      const mv = document.getElementById('trip-v-master');
      if (ms) ms.value = Math.round(S.master * 100);
      if (mv) mv.textContent = Math.round(S.master * 100) + '%';
      if (progress >= 1) {
        S.rampActive = false;
        save();
      }
      updateRampUI();
    }

    const m = S.master;
    if (m < 0.001) {
      target.style.filter = '';
      requestAnimationFrame(animate);
      return;
    }

    const eHue = S.hueRotate * m;
    const eKaleid = S.kaleidoscope * m;

    const filters = [];

    // 1. Hue Rotate — cycles continuously, speed based on value
    if (eHue > 0.001) {
      const hueSpeed = eHue * 120; // degrees per second
      const hueDeg = (t * hueSpeed) % 360;
      filters.push(`hue-rotate(${hueDeg.toFixed(1)}deg)`);
    }

    // 2. Kaleidoscope / Bumpy Lens — SVG displacement with slowly morphing turbulence
    //    At low values: very subtle waviness, like looking through old glass
    //    At high values: strong liquid distortion, the whole screen warps and breathes
    if (eKaleid > 0.001) {
      const turbEl = document.getElementById('trip-lens-turb');
      const dispEl = document.getElementById('trip-lens-disp');
      if (turbEl && dispEl) {
        // Base frequency controls how "bumpy" the lens is
        // Low kaleid = large smooth bumps, high = tighter more chaotic bumps
        const freqBase = 0.003 + eKaleid * 0.015;
        // Add slow breathing oscillation to frequency
        const freqBreath = Math.sin(t * 0.3) * eKaleid * 0.004;
        const freq = freqBase + freqBreath;
        turbEl.setAttribute('baseFrequency', freq.toFixed(5) + ' ' + (freq * 0.8).toFixed(5));

        // Slowly morph the noise pattern by incrementing seed
        // This creates the "living lens" feeling — the bumps slowly shift
        lensSeed += dt * (0.3 + eKaleid * 0.7); // faster morph at higher intensity
        turbEl.setAttribute('seed', Math.floor(lensSeed) % 1000);

        // Displacement scale: how much the bumps distort
        // Starts very subtle (2-3px), ramps up to strong (50px+)
        const baseScale = eKaleid * eKaleid * 60; // quadratic — gentle at low, strong at high
        // Add slow pulsing to the displacement for "breathing" effect
        const scalePulse = Math.sin(t * 0.5) * eKaleid * 8;
        const scale = baseScale + scalePulse;
        dispEl.setAttribute('scale', Math.max(0, scale).toFixed(1));

        filters.push('url(#trip-lens)');
      }
    } else {
      const dispEl = document.getElementById('trip-lens-disp');
      if (dispEl) dispEl.setAttribute('scale', '0');
    }

    target.style.filter = filters.length ? filters.join(' ') : '';

    requestAnimationFrame(animate);
  }

  // ─── Init ─────────────────────────────────────────────────
  function init() {
    injectSVGFilters();
    if (!isDisplayMode) {
      createPanel();
    }
    requestAnimationFrame(animate);

    // Periodically save state for ramp progress (control mode only)
    if (!isDisplayMode) {
      setInterval(() => { if (S.rampActive) save(); }, 5000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
