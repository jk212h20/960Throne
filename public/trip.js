/**
 * 960 Throne — Psychedelic Party Mode
 * Pure client-side CSS/SVG filter effects with control panel & timeline scheduler.
 * Each effect has an independent 0–1 slider, multiplied by a master intensity.
 * All state persisted to localStorage so it survives page reloads (throne reloads on game transitions).
 *
 * Usage: Include this script on any page. Press 'T' to toggle control panel.
 */
(function() {
  'use strict';

  // ─── State ────────────────────────────────────────────────
  const STORAGE_KEY = '_trip';
  const defaults = {
    master: 0,
    hueRotate: 0,     // rainbow color cycling speed
    colorPulse: 0,     // saturation/brightness throb
    warp: 0,           // SVG displacement warp
    kaleidoscope: 0,   // contrast + invert cycling
    glow: 0,           // bloom/glow overlay
    rgbSplit: 0,       // chromatic aberration
    // Timeline
    rampStart: null,    // timestamp ms
    rampDuration: 60,   // minutes
    rampTarget: 1,      // target master value
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

  // ─── SVG Filter Definitions ───────────────────────────────
  function injectSVGFilters() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = `
      <defs>
        <filter id="trip-warp" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence id="trip-turbulence" type="fractalNoise" baseFrequency="0.015" numOctaves="3" seed="1" result="noise"/>
          <feDisplacementMap id="trip-displacement" in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
        <filter id="trip-rgb" x="-5%" y="-5%" width="110%" height="110%">
          <feOffset id="trip-r-offset" in="SourceGraphic" dx="0" dy="0" result="r"/>
          <feOffset id="trip-b-offset" in="SourceGraphic" dx="0" dy="0" result="b"/>
          <feColorMatrix in="r" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red"/>
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green"/>
          <feColorMatrix in="b" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue"/>
          <feBlend in="red" in2="green" mode="screen" result="rg"/>
          <feBlend in="rg" in2="blue" mode="screen"/>
        </filter>
      </defs>
    `;
    document.body.appendChild(svg);
  }

  // ─── Glow Overlay ─────────────────────────────────────────
  let glowEl = null;
  function createGlowOverlay() {
    glowEl = document.createElement('div');
    glowEl.id = 'trip-glow';
    glowEl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9998;mix-blend-mode:screen;opacity:0;backdrop-filter:blur(0px);';
    document.body.appendChild(glowEl);
  }

  // ─── Control Panel ────────────────────────────────────────
  function createPanel() {
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
        ${makeSlider('colorPulse', 'Color Pulse')}
        ${makeSlider('warp', 'Warp')}
        ${makeSlider('kaleidoscope', 'Kaleidoscope')}
        ${makeSlider('glow', 'Glow/Bloom')}
        ${makeSlider('rgbSplit', 'RGB Split')}
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
    ['hueRotate','colorPulse','warp','kaleidoscope','glow','rgbSplit'].forEach(wireSlider);

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
      S.hueRotate = 0; S.colorPulse = 0; S.warp = 0;
      S.kaleidoscope = 0; S.glow = 0; S.rgbSplit = 0;
      S.rampActive = false; S.rampStart = null;
      save();
      syncSlidersFromState();
      updateRampUI();
    });

    // Presets
    document.getElementById('trip-preset-mild').addEventListener('click', () => {
      S.hueRotate = 0.3; S.colorPulse = 0.2; S.warp = 0.1;
      S.kaleidoscope = 0; S.glow = 0.2; S.rgbSplit = 0.1;
      S.master = 0.4;
      save(); syncSlidersFromState();
    });
    document.getElementById('trip-preset-medium').addEventListener('click', () => {
      S.hueRotate = 0.6; S.colorPulse = 0.5; S.warp = 0.3;
      S.kaleidoscope = 0.2; S.glow = 0.4; S.rgbSplit = 0.3;
      S.master = 0.7;
      save(); syncSlidersFromState();
    });
    document.getElementById('trip-preset-full').addEventListener('click', () => {
      S.hueRotate = 1; S.colorPulse = 0.8; S.warp = 0.7;
      S.kaleidoscope = 0.5; S.glow = 0.7; S.rgbSplit = 0.6;
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
    ['master','hueRotate','colorPulse','warp','kaleidoscope','glow','rgbSplit'].forEach(key => {
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
    if (S.rampActive) {
      startBtn.style.display = 'none';
      stopBtn.style.display = '';
      const elapsed = (Date.now() - S.rampStart) / 1000 / 60; // minutes
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
  const target = document.documentElement; // apply filters to <html> so everything is affected

  function animate() {
    t += 0.016; // ~60fps time step

    // Timeline ramp — auto-adjust master
    if (S.rampActive && S.rampStart) {
      const elapsed = (Date.now() - S.rampStart) / 1000 / 60;
      const progress = Math.min(1, elapsed / S.rampDuration);
      S.master = progress * S.rampTarget;
      // Update master slider
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
      // No effects — clear everything
      target.style.filter = '';
      if (glowEl) glowEl.style.opacity = '0';
      requestAnimationFrame(animate);
      return;
    }

    // Effective values (each * master)
    const eHue = S.hueRotate * m;
    const ePulse = S.colorPulse * m;
    const eWarp = S.warp * m;
    const eKaleid = S.kaleidoscope * m;
    const eGlow = S.glow * m;
    const eRgb = S.rgbSplit * m;

    // Build CSS filter chain
    const filters = [];

    // 1. Hue Rotate — cycles continuously, speed based on value
    if (eHue > 0.001) {
      const hueSpeed = eHue * 120; // degrees per second
      const hueDeg = (t * hueSpeed) % 360;
      filters.push(`hue-rotate(${hueDeg.toFixed(1)}deg)`);
    }

    // 2. Color Pulse — oscillating saturation + brightness
    if (ePulse > 0.001) {
      const pulsePhase = Math.sin(t * 2.5) * 0.5 + 0.5; // 0-1 oscillation
      const sat = 1 + ePulse * pulsePhase * 2; // 1x to 3x
      const bright = 1 + ePulse * Math.sin(t * 1.8) * 0.3; // subtle brightness
      filters.push(`saturate(${sat.toFixed(2)}) brightness(${bright.toFixed(2)})`);
    }

    // 3. Warp — SVG displacement map
    if (eWarp > 0.001) {
      const turbEl = document.getElementById('trip-turbulence');
      const dispEl = document.getElementById('trip-displacement');
      if (turbEl && dispEl) {
        // Animate turbulence seed for movement
        const freq = 0.008 + eWarp * 0.02;
        turbEl.setAttribute('baseFrequency', freq.toFixed(4));
        // Animate seed slowly for morphing
        turbEl.setAttribute('seed', Math.floor(t * 2) % 100);
        dispEl.setAttribute('scale', (eWarp * 40).toFixed(1));
        filters.push('url(#trip-warp)');
      }
    } else {
      const dispEl = document.getElementById('trip-displacement');
      if (dispEl) dispEl.setAttribute('scale', '0');
    }

    // 4. Kaleidoscope — contrast + periodic invert
    if (eKaleid > 0.001) {
      const contrast = 1 + eKaleid * Math.sin(t * 1.5) * 0.8;
      filters.push(`contrast(${contrast.toFixed(2)})`);
      // Periodic brief invert flashes at higher intensity
      if (eKaleid > 0.3) {
        const invertPhase = Math.pow(Math.sin(t * 3), 20); // sharp spikes
        const invertAmt = invertPhase * eKaleid * 0.6;
        if (invertAmt > 0.01) filters.push(`invert(${invertAmt.toFixed(2)})`);
      }
    }

    // 5. RGB Split — SVG channel offset
    if (eRgb > 0.001) {
      const rOff = document.getElementById('trip-r-offset');
      const bOff = document.getElementById('trip-b-offset');
      if (rOff && bOff) {
        const dx = Math.sin(t * 2) * eRgb * 8;
        const dy = Math.cos(t * 1.7) * eRgb * 4;
        rOff.setAttribute('dx', dx.toFixed(1));
        rOff.setAttribute('dy', (-dy).toFixed(1));
        bOff.setAttribute('dx', (-dx).toFixed(1));
        bOff.setAttribute('dy', dy.toFixed(1));
        filters.push('url(#trip-rgb)');
      }
    } else {
      const rOff = document.getElementById('trip-r-offset');
      const bOff = document.getElementById('trip-b-offset');
      if (rOff) { rOff.setAttribute('dx', '0'); rOff.setAttribute('dy', '0'); }
      if (bOff) { bOff.setAttribute('dx', '0'); bOff.setAttribute('dy', '0'); }
    }

    // Apply combined filter
    target.style.filter = filters.length ? filters.join(' ') : '';

    // 6. Glow overlay — separate from main filter chain
    if (glowEl) {
      if (eGlow > 0.001) {
        const blurPx = eGlow * 20 + Math.sin(t * 1.2) * eGlow * 8;
        glowEl.style.opacity = (eGlow * 0.4).toFixed(2);
        glowEl.style.backdropFilter = `blur(${blurPx.toFixed(1)}px) brightness(${(1 + eGlow * 0.5).toFixed(2)})`;
      } else {
        glowEl.style.opacity = '0';
      }
    }

    requestAnimationFrame(animate);
  }

  // ─── Init ─────────────────────────────────────────────────
  function init() {
    injectSVGFilters();
    createGlowOverlay();
    createPanel();
    requestAnimationFrame(animate);

    // Periodically save state (for ramp progress)
    setInterval(() => { if (S.rampActive) save(); }, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
