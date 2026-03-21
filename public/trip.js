/**
 * 960 Throne — Psychedelic Party Mode
 * Pure GPU-accelerated CSS effects. Zero SVG filters = zero CPU cost.
 *
 * Effects:
 * - Hue Cycle: CSS hue-rotate on body (GPU-composited)
 * - Lens Warp: CSS perspective + rotate transforms (GPU-composited)
 *   Creates a slow "swaying through a lens" effect — the whole page
 *   gently tilts and warps in 3D perspective. Smooth, organic, zero CPU.
 *
 * QR protection: left panel gets 25% of the warp amplitude.
 * All state in localStorage. Display mode syncs every 250ms.
 * Press T to toggle control panel.
 */
(function() {
  'use strict';

  const scriptTag = document.currentScript;
  const isDisplayMode = scriptTag && scriptTag.hasAttribute('data-display');

  const STORAGE_KEY = '_trip';
  const defaults = {
    master: 0, hueRotate: 0, kaleidoscope: 0,
    rampStart: null, rampDuration: 60, rampTarget: 1, rampActive: false,
    panelOpen: true,
  };

  let S = Object.assign({}, defaults);
  try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (s) Object.assign(S, s); } catch(e) {}
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S)); } catch(e) {} }

  if (isDisplayMode) {
    setInterval(() => {
      try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (s) Object.assign(S, s); } catch(e) {}
    }, 250);
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
      <div class="trip-section"><h4>Effects</h4>
        ${makeSlider('hueRotate', 'Hue Cycle')}
        ${makeSlider('kaleidoscope', 'Lens Warp')}
      </div>
      <div class="trip-section"><h4>⏱ Timeline Scheduler</h4>
        <div class="trip-time-row"><label>Duration</label><input type="number" id="trip-ramp-dur" value="${S.rampDuration}" min="1" max="480" step="1"> min</div>
        <div class="trip-time-row"><label>Target</label><input type="range" min="0" max="100" value="${Math.round(S.rampTarget*100)}" id="trip-ramp-target" style="flex:1;accent-color:#a855f7"><span class="trip-val" id="trip-v-ramp-target">${Math.round(S.rampTarget*100)}%</span></div>
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
    const rts = document.getElementById('trip-ramp-target'), rtv = document.getElementById('trip-v-ramp-target');
    rts.addEventListener('input', () => { S.rampTarget=parseInt(rts.value)/100; rtv.textContent=rts.value+'%'; save(); });
    document.getElementById('trip-ramp-dur').addEventListener('change', e => { S.rampDuration=Math.max(1,parseInt(e.target.value)||60); save(); });
    document.getElementById('trip-ramp-start').addEventListener('click', () => { S.rampStart=Date.now(); S.rampActive=true; save(); });
    document.getElementById('trip-ramp-stop').addEventListener('click', () => { S.rampActive=false; S.rampStart=null; save(); });
    document.getElementById('trip-kill').addEventListener('click', () => { S.master=0;S.hueRotate=0;S.kaleidoscope=0;S.rampActive=false;S.rampStart=null; save();syncSliders(); });
    document.getElementById('trip-preset-mild').addEventListener('click', () => { S.hueRotate=0.3;S.kaleidoscope=0.15;S.master=0.4; save();syncSliders(); });
    document.getElementById('trip-preset-medium').addEventListener('click', () => { S.hueRotate=0.6;S.kaleidoscope=0.4;S.master=0.7; save();syncSliders(); });
    document.getElementById('trip-preset-full').addEventListener('click', () => { S.hueRotate=1;S.kaleidoscope=0.8;S.master=1; save();syncSliders(); });
    document.addEventListener('keydown', e => {
      if (e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
      if (e.key==='t'||e.key==='T') { S.panelOpen=!S.panelOpen; panel.classList.toggle('hidden',!S.panelOpen); hint.style.display=S.panelOpen?'none':'block'; save(); }
    });
  }

  function makeSlider(key, label) {
    const v = Math.round(S[key]*100);
    return `<div class="trip-row"><label>${label}</label><input type="range" min="0" max="100" value="${v}" id="trip-s-${key}"><span class="trip-val" id="trip-v-${key}">${v}%</span></div>`;
  }
  function wireSlider(key) {
    const sl=document.getElementById('trip-s-'+key), vl=document.getElementById('trip-v-'+key);
    if (!sl) return;
    sl.addEventListener('input', () => { S[key]=parseInt(sl.value)/100; vl.textContent=sl.value+'%'; save(); });
  }
  function syncSliders() {
    ['master','hueRotate','kaleidoscope'].forEach(k => {
      const sl=document.getElementById('trip-s-'+k), vl=document.getElementById('trip-v-'+k);
      if (sl) sl.value=Math.round(S[k]*100);
      if (vl) vl.textContent=Math.round(S[k]*100)+'%';
    });
  }

  // ─── SVG Displacement Filter ──────────────────────────────
  // Static turbulence (generated ONCE, never recalculated).
  // Only the displacement `scale` changes — that's a cheap attribute swap.
  // Two filters: full (right panel) and soft (left panel/QR).
  function injectSVGFilters() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = `<defs>
      <filter id="trip-lens" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.006 0.004" numOctaves="1" seed="7" result="n"/>
        <feDisplacementMap id="trip-disp" in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
      <filter id="trip-lens-soft" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.006 0.004" numOctaves="1" seed="7" result="n"/>
        <feDisplacementMap id="trip-disp-soft" in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
    </defs>`;
    document.body.appendChild(svg);
  }

  // ─── Animation ────────────────────────────────────────────
  // Hybrid approach:
  // - SVG displacement for actual pixel-level distortion (static noise, only scale changes)
  // - CSS perspective transforms for gentle 3D sway (GPU-composited)
  // - Hue rotation on body
  // JS runs every 100ms; CSS transition smooths the transforms.

  let hueAngle = 0;
  let hueWasActive = false; // track on/off transitions to reset angle
  let lastTick = Date.now();
  let leftPanel = null;
  let rightPanel = null;
  let topBar = null;
  let lastDispScale = -1;
  let lastDispScaleSoft = -1;

  function findPanels() {
    const mainFlex = document.querySelector('.flex-1.flex');
    if (mainFlex && mainFlex.children.length >= 2) {
      leftPanel = mainFlex.children[0];
      rightPanel = mainFlex.children[1];
    }
    topBar = document.querySelector('.bg-throne-dark.border-b');
  }

  function setupTransitions() {
    const ts = 'transform 3s cubic-bezier(0.4,0,0.2,1)';
    [rightPanel, leftPanel, topBar].forEach(el => {
      if (!el) return;
      el.style.transition = ts;
      el.style.transformOrigin = 'center center';
      el.style.willChange = 'transform';
    });
  }

  function wave(t, s1, s2, s3) {
    return Math.sin(t*s1)*0.5 + Math.sin(t*s2)*0.3 + Math.sin(t*s3)*0.2;
  }

  function tick() {
    const body = document.body;
    if (!body) return;
    const now = Date.now();
    const dt = Math.min((now - lastTick) / 1000, 0.5);
    lastTick = now;

    // Ramp
    if (!isDisplayMode && S.rampActive && S.rampStart) {
      const elapsed = (now - S.rampStart) / 60000;
      const progress = Math.min(1, elapsed / S.rampDuration);
      S.master = progress * S.rampTarget;
      syncSliders();
      if (progress >= 1) { S.rampActive = false; save(); }
      const fill=document.getElementById('trip-ramp-fill'), status=document.getElementById('trip-ramp-status');
      const startBtn=document.getElementById('trip-ramp-start'), stopBtn=document.getElementById('trip-ramp-stop');
      if (fill) fill.style.width=(progress*100)+'%';
      if (startBtn) startBtn.style.display='none';
      if (stopBtn) stopBtn.style.display='';
      if (status) { const rem=Math.max(0,S.rampDuration-elapsed); status.textContent=rem>0?Math.floor(rem)+'m '+Math.floor((rem%1)*60)+'s → '+Math.round(S.rampTarget*100)+'%':'Ramp complete!'; }
    }

    const m = S.master;
    if (m < 0.001) {
      body.style.filter = '';
      if (rightPanel) { rightPanel.style.filter = ''; rightPanel.style.transform = ''; }
      if (leftPanel) { leftPanel.style.filter = ''; leftPanel.style.transform = ''; }
      if (topBar) topBar.style.transform = '';
      return;
    }

    const eHue = S.hueRotate * m;
    const eKaleid = S.kaleidoscope * m;
    const t = now / 1000;

    // ── Hue rotation ──
    // Reset angle to 0 when transitioning from off→on so it starts from current colors
    if (eHue > 0.001) {
      if (!hueWasActive) { hueAngle = 0; hueWasActive = true; }
      hueAngle = (hueAngle + eHue * 120 * dt) % 360;
      body.style.filter = 'hue-rotate(' + Math.round(hueAngle) + 'deg)';
    } else {
      if (hueWasActive) { hueAngle = 0; hueWasActive = false; }
      body.style.filter = '';
    }

    // ── Lens Warp: SVG displacement + CSS perspective ──
    if (eKaleid > 0.001) {
      // SVG displacement scale — smooth sine breathing
      // Only write to DOM when the rounded value changes
      const breath = wave(t, 0.15, 0.31, 0.07);
      const baseScale = eKaleid * eKaleid * 70;
      const scale = Math.round(baseScale + breath * baseScale * 0.3);
      if (scale !== lastDispScale) {
        const d = document.getElementById('trip-disp');
        if (d) d.setAttribute('scale', scale);
        lastDispScale = scale;
      }
      // Soft version: 25%
      const scaleSoft = Math.round(scale * 0.25);
      if (scaleSoft !== lastDispScaleSoft) {
        const ds = document.getElementById('trip-disp-soft');
        if (ds) ds.setAttribute('scale', scaleSoft);
        lastDispScaleSoft = scaleSoft;
      }

      // Apply SVG filter to panels
      if (rightPanel && !rightPanel.style.filter.includes('trip-lens')) rightPanel.style.filter = 'url(#trip-lens)';
      if (leftPanel && !leftPanel.style.filter.includes('trip-lens-soft')) leftPanel.style.filter = 'url(#trip-lens-soft)';

      // CSS perspective sway on top (lightweight addition)
      const maxTilt = eKaleid * 3;
      const rx = wave(t, 0.13, 0.29, 0.07) * maxTilt;
      const ry = wave(t, 0.11, 0.23, 0.05) * maxTilt;
      if (rightPanel) rightPanel.style.transform = `perspective(800px) rotateX(${rx.toFixed(1)}deg) rotateY(${ry.toFixed(1)}deg)`;
      if (leftPanel) leftPanel.style.transform = `perspective(1200px) rotateX(${(rx*0.25).toFixed(1)}deg) rotateY(${(ry*0.25).toFixed(1)}deg)`;
      if (topBar) topBar.style.transform = `perspective(1600px) rotateX(${(rx*0.1).toFixed(1)}deg) rotateY(${(ry*0.1).toFixed(1)}deg)`;
    } else {
      if (lastDispScale !== 0) {
        const d = document.getElementById('trip-disp');
        const ds = document.getElementById('trip-disp-soft');
        if (d) d.setAttribute('scale', '0');
        if (ds) ds.setAttribute('scale', '0');
        lastDispScale = 0; lastDispScaleSoft = 0;
      }
      if (rightPanel) { rightPanel.style.filter = ''; rightPanel.style.transform = ''; }
      if (leftPanel) { leftPanel.style.filter = ''; leftPanel.style.transform = ''; }
      if (topBar) topBar.style.transform = '';
    }
  }

  // ─── Init ─────────────────────────────────────────────────
  function init() {
    injectSVGFilters();
    findPanels();
    setupTransitions();
    if (!isDisplayMode) createPanel();
    setInterval(tick, 100);
    if (!isDisplayMode) setInterval(() => { if (S.rampActive) save(); }, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
