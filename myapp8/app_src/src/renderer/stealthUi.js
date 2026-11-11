// stealthUi.js — keep hover feedback inside the content-protected window.
//
// setContentProtection(true) hides our window's pixels from capture, but two
// things are drawn by the OS outside those pixels and still show up in a
// screen share / recording:
//   1. Native `title` tooltips — Chromium renders them in a separate popup
//      window that is NOT content-protected.
//   2. The mouse cursor — composited by the OS, so a pointer/I-beam/not-allowed
//      shape appearing over "empty" desktop gives the window away.
//
// Fix: strip every `title` attribute (moving the text to data-stealth-tip) and
// draw the tooltip ourselves as a DOM element, and force the default arrow
// cursor everywhere. Required from both preloads (main window + interview
// BrowserView); runs in the isolated world but only touches the shared DOM.

const { ipcRenderer } = require('electron');

const TIP_ATTR = 'data-stealth-tip';
const EDGE_PX = 6;
const CORNER_PX = 12;
const NEAR_PX = 30; // how close the cursor must be for an edge's grip to show

function install(edges) {
  const style = document.createElement('style');
  style.id = 'stealth-ui-style';
  style.textContent = `
    *, *::before, *::after { cursor: default !important; }
    #stealth-tip {
      position: fixed; z-index: 2147483647; pointer-events: none;
      max-width: 280px; padding: 5px 8px; border-radius: 6px;
      background: rgba(20, 22, 30, 0.95); color: #f0f0f5;
      border: 1px solid rgba(255, 255, 255, 0.12);
      font: 500 12px/1.35 'Inter', system-ui, sans-serif;
      white-space: pre-wrap; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      opacity: 0; transition: opacity 0.1s;
    }
    #stealth-tip.visible { opacity: 1; }
    .stealth-resize-edge {
      position: fixed; z-index: 2147483646; background: transparent;
      -webkit-app-region: no-drag;
    }
    .stealth-resize-edge.left   { left: 0;   top: 0; bottom: 0; width: ${EDGE_PX}px; }
    .stealth-resize-edge.right  { right: 0;  top: 0; bottom: 0; width: ${EDGE_PX}px; }
    .stealth-resize-edge.top    { top: 0;    left: 0; right: 0; height: ${EDGE_PX}px; }
    .stealth-resize-edge.bottom { bottom: 0; left: 0; right: 0; height: ${EDGE_PX}px; }
    .stealth-resize-edge.corner { width: ${CORNER_PX}px; height: ${CORNER_PX}px; z-index: 2147483647; }
    .stealth-resize-edge.top-left     { top: 0;    left: 0; }
    .stealth-resize-edge.top-right    { top: 0;    right: 0; }
    .stealth-resize-edge.bottom-left  { bottom: 0; left: 0; }
    .stealth-resize-edge.bottom-right { bottom: 0; right: 0; }
    /* Grip: a short theme-coloured line centred on each side. Hidden until the
       cursor comes near that edge (.near, set in installResizeEdges) or it is
       being dragged. Theme variables come from the main window's stylesheet;
       the interview view doesn't define them and uses the dark fallbacks. */
    .stealth-resize-edge:not(.corner)::after {
      content: ''; position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%); pointer-events: none;
      border-radius: 1px;
      background: var(--border-strong, rgba(255, 255, 255, 0.18));
      opacity: 0; transition: opacity 0.2s, background 0.15s;
    }
    .stealth-resize-edge.left::after, .stealth-resize-edge.right::after { width: 2px; height: 32px; }
    .stealth-resize-edge.top::after, .stealth-resize-edge.bottom::after { width: 32px; height: 2px; }
    .stealth-resize-edge.near::after,
    .stealth-resize-edge:hover::after,
    .stealth-resize-edge.dragging::after { opacity: 1; }
    .stealth-resize-edge:hover::after,
    .stealth-resize-edge.dragging::after {
      background: var(--text-tertiary, rgba(240, 240, 245, 0.4));
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  const tip = document.createElement('div');
  tip.id = 'stealth-tip';
  document.body.appendChild(tip);

  let hoverEl = null;
  let timer = null;
  let lastX = 0;
  let lastY = 0;

  // --- Move title -> data-stealth-tip, now and for anything added later ---
  const convert = (el) => {
    const t = el.getAttribute('title');
    if (t === null) return;
    el.removeAttribute('title');
    if (t) el.setAttribute(TIP_ATTR, t);
    else el.removeAttribute(TIP_ATTR);
    if (el === hoverEl) show(el); // text changed while hovered (e.g. mode switch)
  };
  const convertTree = (root) => {
    if (root.nodeType !== 1) return;
    if (root.hasAttribute('title')) convert(root);
    root.querySelectorAll('[title]').forEach(convert);
  };

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') convert(m.target);
      else m.addedNodes.forEach(convertTree);
    }
  }).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['title'],
  });
  convertTree(document.documentElement);

  // --- In-window tooltip ---

  function show(el) {
    const text = el.getAttribute(TIP_ATTR);
    if (!text) return hide();
    tip.textContent = text;
    tip.classList.add('visible');
    position();
  }
  function hide() {
    clearTimeout(timer);
    tip.classList.remove('visible');
  }
  function position() {
    const pad = 6;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = lastX + 12;
    let y = lastY + 18;
    if (x + w > window.innerWidth - pad) x = window.innerWidth - w - pad;
    if (y + h > window.innerHeight - pad) y = lastY - h - 10;
    tip.style.left = `${Math.max(pad, x)}px`;
    tip.style.top = `${Math.max(pad, y)}px`;
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest(`[${TIP_ATTR}]`);
    if (el === hoverEl) return;
    hoverEl = el;
    hide();
    if (el) timer = setTimeout(() => hoverEl === el && show(el), 500);
  }, true);
  document.addEventListener('mousemove', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (tip.classList.contains('visible')) position();
  }, true);
  document.addEventListener('mousedown', () => { hoverEl = null; hide(); }, true);
  document.addEventListener('mouseleave', () => { hoverEl = null; hide(); });
  window.addEventListener('blur', () => { hoverEl = null; hide(); });

  installResizeEdges(edges);
}

// --- Edge resizing ---
// The window is resizable:false (so Windows never shows its own resize cursor),
// so these invisible strips replace the native borders. The cursor stays the
// default arrow via the rule above, a faint grip + in-window tooltip tell the
// user the edge is draggable, and main.js does the actual resizing from the OS
// cursor position, which keeps working when the mouse leaves the window.
function installResizeEdges(edges) {
  // Side strips (not corners) keyed by edge, for the proximity reveal below.
  const sideStrips = {};

  for (const edge of edges) {
    const strip = document.createElement('div');
    strip.className = `stealth-resize-edge ${edge}${edge.includes('-') ? ' corner' : ''}`;
    strip.setAttribute(TIP_ATTR, 'Drag to resize');
    document.body.appendChild(strip);
    if (!edge.includes('-')) sideStrips[edge] = strip;

    let pending = false;
    const onMove = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        ipcRenderer.send('stealth-resize-move');
      });
    };
    const onUp = (e) => {
      strip.releasePointerCapture(e.pointerId);
      strip.classList.remove('dragging');
      strip.removeEventListener('pointermove', onMove);
      strip.removeEventListener('pointerup', onUp);
      strip.removeEventListener('pointercancel', onUp);
      ipcRenderer.send('stealth-resize-end');
    };

    strip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      strip.setPointerCapture(e.pointerId);
      strip.classList.add('dragging');
      ipcRenderer.send('stealth-resize-start', edge);
      strip.addEventListener('pointermove', onMove);
      strip.addEventListener('pointerup', onUp);
      strip.addEventListener('pointercancel', onUp);
    });
  }

  // Show an edge's grip only while the cursor is within NEAR_PX of it.
  // (Drag regions like the title bar swallow mouse events, so over those the
  // grip only appears once the cursor is on the strip itself, via :hover.)
  const setNear = (x, y) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dist = { left: x, right: w - x, top: y, bottom: h - y };
    for (const [edge, strip] of Object.entries(sideStrips)) {
      strip.classList.toggle('near', x >= 0 && y >= 0 && dist[edge] <= NEAR_PX);
    }
  };
  document.addEventListener('mousemove', (e) => setNear(e.clientX, e.clientY), true);
  document.addEventListener('mouseleave', () => setNear(-1, -1));
  window.addEventListener('blur', () => setNear(-1, -1));
}

// `edges`: which resize handles this view gets. Each view only covers part of
// the window (the interview BrowserView sits below the top bar), so the preload
// picks the edges that line up with the window's real edges.
function installStealthUi({ edges = [] } = {}) {
  const run = () => install(edges);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}

module.exports = { installStealthUi };
