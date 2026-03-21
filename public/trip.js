/**
 * 960 Throne — Psychedelic Party Mode
 * CSS/SVG filter effects with control panel & timeline scheduler.
 * Performance: 20fps setInterval, 2-octave turbulence, seed updates every 4s.
 * QR protection: lens warp is reduced on the left panel (QR area).
 * Hue rotation applies everywhere (doesn't affect QR scannability).
 *
 * Display mode: <script src="/trip.js" data-display></script>
 * Press 'T' to toggle control panel (control mode only).
 */
(function() {
  'use strict';

  const scriptTag = document.currentScript;
  const isDisplayMode = scriptTag && scriptTag.hasAttribute('data-display');

  // ─── State ────────────────────────────────────────────────
  const STORAGE_KEY = '_trip';
  const defaults = {
    master: 0,
    hueRotate: 0,
    kaleidoscope: 0,
    rampStart: null,
    rampDuration: 60,
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

  if (isDisplayMode) {
    setInterval(() => {
      try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (s) Object.assign(S, s); } catch(e) {}
    }, 250);
  }

  // ─── SVG Filters ──────────────────────────────────────────
  // Two filters: full strength for main content, reduced for QR area
  function injectSVGFilters() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = `
      <defs>
        <filter id="trip-lens" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence id="trip-turb" type="fractalNoise" baseFrequency="0.004" numOctaves="2" seed="3" result="noise"/>
          <feDisplacementMap id="trip-disp" in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
        <filter id="trip-lens-soft" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence id="trip-turb-soft" type="fractalNoise" baseFrequency="0.004" numOctaves="2" seed="3" result="noise"/>
          <feDisplacementMap id="trip-disp-soft" in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
    `;
    document.body.appendChild(svg);
  }

  // ─── Control Panel ────────────────────────────────────────
  function createPanel() {
    if (isDisplayMode) return;
    const panel = document.createElement('div');
    panel.id = 'trip-panel';
    panel.innerHTML = `
      <style>
        #trip-panel{position:fixed;bottom:20px;right:20px;z-index:99999;background:rgba(10,10,25,0.92);border:1px solid rgba(255,215,0,0.3);border-radius:16px;padding:20px;width:340px;font-family:system-ui,sans-serif;color:#fff;font-size:13px;backdrop-filter:blur(12px);box-shadow:0 8px 32px rgba(0,0,0,0.6);transition:transform 0.3s,opacity 0.3s;max-height:90vh;overflow-y:auto}
        #trip-panel.hidden{transform:translateX(400px);opacity:0;pointer-events:none}
        #trip-panel h3{margin:0 0 12px;color:#FFD700;font-size:16px}
        .trip-row{display:flex;align-items:center;gap:8px;margin:6px 0}
        .trip-row label{width:90px;font-size:12px;color:#aaa;flex-shrink:0}
        .trip-row input[type=range]{flex:1;accent-color:#FFD700;height:6px}
        .trip-row .trip-val{width:36px;text-align:right;font-family:monospace;font-size:12px;color:#FFD700}
        .trip-section{border-top:1px solid rgba(255,255,255,0.1);margin-top:12px;padding-top:10px}
        .trip-section h4{margin:0 0 8px;font-size:13px;color:#888}
        .trip-btn{background:rgba(255,215,0,0.15);border:1px solid rgba(255,215,0,0.3);color:#FFD700;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600}
        .trip-btn:hover{background:rgba(255,215,0,0.25)}
        .trip-btn-danger{background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.3);color:#ef4444}
        #trip-ramp-bar{width:100%;height:8px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden;margin:6px 0}
        #trip-ramp-fill{height:100%;background:linear-gradient(90deg,#FFD700,#ff6b6b,#a855f7);width:0%;transition:width 1s linear;border-radius:4px}
        #trip-ramp-status{font-size:11px;color:#666;margin-top:4px}
        .trip-time-row{display:flex;gap:8px;align-items:center;margin:6px 0}
        .trip-time-row label{width:70px;font-size:12px;color:#aaa}
        .trip-time-row input{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:4px 8px;border-radius:6px;font-size:12px}
        .trip-time-row input[type=number]{width:60px}
        #trip-hint{position:fixed;bottom:20px;right:20px;z-index:99998;background:rgba(10,10,25,0.7);border:1px solid rgba(255,215,0,0.2);border-radius:8px;padding:8px 14px;font-size:11px;color:#666;pointer-events:none}
      </style>
      <h3>🍄 Trip Mode</h3>
      <div class="trip-row">
        <label style="color:#FFD700;font-weight:700">MASTER</label>
        <input type="range" min="0" max="100" value="${Math.round(S.master*100)}" id="trip-s-master">
        <span class="trip-val" id="trip-v-master">${Math.round(S.master*100)}%</span>
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
          <span class="trip-val" id="trip-v-ramp-target">${Math.round(S.rampTarget*100)}%</span>
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

    const hint = document.createElement('div');
    hint.id = 'trip-hint';
    hint.textContent = 'Press T for trip controls';
    hint.style.display = S.panelOpen ? 'none' : 'block';
    document.body.appendChild(hint);
    if (!S.panelOpen) panel.classList.add('hidden');

    wireSlider('master'); wireSlider('hueRotate'); wireSlider('kaleidoscope');

    const rts = document.getElementById('trip-ramp-target');
    const rtv = document.getElementById('trip-v-ramp-target');
    rts.addEventListener('input', () => { S.rampTarget = parseInt(rts.value)/100; rtv.textContent = rts.value+'%'; save(); });
    document.getElementById('trip-ramp-dur').addEventListener('change', (e) => { S.rampDuration = Math.max(1, parseInt(e.target.value)||60); save(); });
    document.getElementById('trip-ramp-start').addEventListener('click', () => { S.rampStart = Date.now(); S.rampActive = true; save(); });
    document.getElementById('trip-ramp-stop').addEventListener('click', () => { S.rampActive = false; S.rampStart = null; save(); });
    document.getElementById('trip-kill').addEventListener('click', () => {
      S.master=0; S.hueRotate=0; S.kaleidoscope=0; S.rampActive=false; S.rampStart=null;
      save(); syncSliders();
    });
    document.getElementById('trip-preset-mild').addEventListener('click', () => { S.hueRotate=0.3; S.kaleidoscope=0.15; S.master=0.4; save(); syncSliders(); });
    document.getElementById('trip-preset-medium').addEventListener('click', () => { S.hueRotate=0.6; S.kaleidoscope=0.4; S.master=0.7; save(); syncSliders(); });
    document.getElementById('trip-preset-full').addEventListener('click', () => { S.hueRotate=1; S.kaleidoscope=0.8; S.master=1; save(); syncSliders(); });

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
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
    return `<div class="trip-row"><label>${label}</label><input type="range" min="0" max="100" value="${v}" id="trip-s-${key}"><span class="trip-val" id="trip-v-${key}">${v}%</span></div>`;
  }
  function wireSlider(key) {
    const sl = document.getElementById('trip-s-'+key), vl = document.getElementById('trip-v-'+key);
    if (!sl) return;
    sl.addEventListener('input', () => { S[key]=parseInt(sl.value)/100; vl.textContent=sl.value+'%'; save(); });
  }
  function syncSliders() {
    ['master','hueRotate','kaleidoscope'].forEach(k => {
      const sl = document.getElementById('trip-s-'+k), vl = document.getElementById('trip-v-'+k);
      if (sl) sl.value = Math.round(S[k]*100);
      if (vl) vl.textContent = Math.round(S[k]*100)+'%';
    });
  }

  // ─── Animation ────────────────────────────────────────────
  let hueAngle = 0;
  let lastTick = Date.now();
  let turbSeed = 3;
  let lastTurbUpdate = 0;
  let lastScale = -1;
  let lastScaleSoft = -1;
  let lastFreq = -1;

  // Find the left panel (QR area) and right panel (game area)
  // In the throne layout: body > ... > div.flex-1.flex > [flex-[3], flex-[7]]
  let leftPanel = null;
  let rightPanel = null;

  function findPanels() {
    // The main content area is a flex container with two children
    // Left: flex-[3] (QR + queue), Right: flex-[7] (game)
    const mainFlex = document.querySelector('.flex-1.flex');
    if (mainFlex && mainFlex.children.length >= 2) {
      leftPanel = mainFlex.children[0]; // flex-[3]
      rightPanel = mainFlex.children[1]; // flex-[7]
    }
  }

  function tick() {
    const body = document.body;
    if (!body) return;

    const now = Date.now();
    const dt = Math.min((now - lastTick) / 1000, 0.2);
    lastTick = now;

    // Ramp
    if (!isDisplayMode && S.rampActive && S.rampStart) {
      const elapsed = (now - S.rampStart) / 60000;
      const progress = Math.min(1, elapsed / S.rampDuration);
      S.master = progress * S.rampTarget;
      syncSliders();
      if (progress >= 1) { S.rampActive = false; save(); }
      const fill = document.getElementById('trip-ramp-fill');
      const status = document.getElementById('trip-ramp-status');
      const startBtn = document.getElementById('trip-ramp-start');
      const stopBtn = document.getElementById('trip-ramp-stop');
      if (fill) fill.style.width = (progress*100)+'%';
      if (startBtn) startBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = '';
      if (status) {
        const rem = Math.max(0, S.rampDuration - elapsed);
        status.textContent = rem > 0 ? Math.floor(rem)+'m '+Math.floor((rem%1)*60)+'s → '+Math.round(S.rampTarget*100)+'%' : 'Ramp complete!';
      }
    }

    const m = S.master;
    if (m < 0.001) {
      body.style.filter = '';
      if (rightPanel) rightPanel.style.filter = '';
      if (leftPanel) leftPanel.style.filter = '';
      return;
    }

    const eHue = S.hueRotate * m;
    const eKaleid = S.kaleidoscope * m;

    // ── Hue rotation: apply to body (affects everything uniformly, QR-safe) ──
    if (eHue > 0.001) {
      hueAngle = (hueAngle + eHue * 120 * dt) % 360;
      body.style.filter = 'hue-rotate(' + Math.round(hueAngle) + 'deg)';
    } else {
      body.style.filter = '';
    }

    // ── Lens warp: apply to panels separately ──
    // Right panel (game): full distortion
    // Left panel (QR): ~25% distortion for subtle inclusion without breaking scannability
    if (eKaleid > 0.001) {
      const turbEl = document.getElementById('trip-turb');
      const dispEl = document.getElementById('trip-disp');
      const turbSoftEl = document.getElementById('trip-turb-soft');
      const dispSoftEl = document.getElementById('trip-disp-soft');

      if (turbEl && dispEl) {
        // Full distortion scale — smoother, larger waves (0.004 base freq = big smooth warps)
        // Increased max scale from 60 to 90 for more dramatic effect
        const scale = Math.round(eKaleid * eKaleid * 90);
        if (scale !== lastScale) {
          dispEl.setAttribute('scale', scale);
          lastScale = scale;
        }

        // Soft version for left panel — 25% of full strength
        const scaleSoft = Math.round(scale * 0.25);
        if (dispSoftEl && scaleSoft !== lastScaleSoft) {
          dispSoftEl.setAttribute('scale', scaleSoft);
          lastScaleSoft = scaleSoft;
        }

        // Base frequency — lower = smoother, bigger waves
        const freq = Math.round((0.002 + eKaleid * 0.008) * 100000);
        if (freq !== lastFreq) {
          const f = freq / 100000;
          const fStr = f.toFixed(5) + ' ' + (f * 0.7).toFixed(5);
          turbEl.setAttribute('baseFrequency', fStr);
          if (turbSoftEl) turbSoftEl.setAttribute('baseFrequency', fStr);
          lastFreq = freq;
        }

        // Morph turbulence seed every 4 seconds
        if (now - lastTurbUpdate > 4000) {
          turbSeed = (turbSeed + 1) % 1000;
          turbEl.setAttribute('seed', turbSeed);
          if (turbSoftEl) turbSoftEl.setAttribute('seed', turbSeed);
          lastTurbUpdate = now;
        }

        // Apply filters to panels
        if (rightPanel) rightPanel.style.filter = 'url(#trip-lens)';
        if (leftPanel) leftPanel.style.filter = 'url(#trip-lens-soft)';
      }
    } else {
      if (lastScale !== 0) {
        const dispEl = document.getElementById('trip-disp');
        const dispSoftEl = document.getElementById('trip-disp-soft');
        if (dispEl) dispEl.setAttribute('scale', '0');
        if (dispSoftEl) dispSoftEl.setAttribute('scale', '0');
        lastScale = 0;
        lastScaleSoft = 0;
      }
      if (rightPanel) rightPanel.style.filter = '';
      if (leftPanel) leftPanel.style.filter = '';
    }
  }

  // ─── Init ─────────────────────────────────────────────────
  function init() {
    injectSVGFilters();
    findPanels();
    if (!isDisplayMode) createPanel();
    setInterval(tick, 50); // ~20fps
    if (!isDisplayMode) setInterval(() => { if (S.rampActive) save(); }, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
