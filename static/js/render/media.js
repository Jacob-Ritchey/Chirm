// render/media.js — File upload and image viewer

import App from '../state.js';
import { toast, esc, escInline, formatSize } from '../utils.js';

export async function handleFileUpload(file) {
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  const toast_el = document.createElement('div');
  toast_el.className = 'toast info';
  toast_el.textContent = `Uploading ${file.name}…`;
  document.getElementById('toast-container').appendChild(toast_el);

  try {
    const res = await fetch('/api/v1/upload', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    toast_el.remove();
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error?.message || data.error);
    }
    const json = await res.json();
    const att = json.data ?? json;
    App.pendingUpload = att;
    showUploadPreview(att, file);
  } catch (e) {
    toast_el.remove();
    toast(e.message, 'error');
  }
}

export function showUploadPreview(att, file) {
  const preview = document.getElementById('upload-preview');
  preview.style.display = 'flex';
  if (att.mime_type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.innerHTML = `
        <img src="${e.target.result}" style="max-height:80px;border-radius:6px">
        <span style="font-size:13px;color:var(--text-secondary)">${esc(file.name)}</span>
        <button onclick="clearUploadPreview()" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:18px">✕</button>
      `;
    };
    reader.readAsDataURL(file);
  } else {
    preview.innerHTML = `
      <span>📎</span>
      <span style="font-size:13px;color:var(--text-secondary)">${esc(file.name)} (${formatSize(att.size)})</span>
      <button onclick="clearUploadPreview()" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:18px">✕</button>
    `;
  }
}

export function clearUploadPreview() {
  App.pendingUpload = null;
  const preview = document.getElementById('upload-preview');
  preview.style.display = 'none';
  preview.innerHTML = '';
}

export function openImageViewer(src) {
  // Close any open sidebars first so their overlay doesn't conflict
  if (typeof window.closeAllPanels === 'function') window.closeAllPanels();

  const viewer = document.createElement('div');
  viewer.id = 'img-viewer';
  viewer.innerHTML = `
    <div id="img-viewer-bg"></div>
    <div id="img-viewer-toolbar">
      <button id="img-viewer-close" title="Close">✕</button>
      <a id="img-viewer-download" href="${src}" download title="Download" target="_blank">⬇</a>
    </div>
    <div id="img-viewer-stage">
      <img id="img-viewer-img" src="${src}" draggable="false">
    </div>
  `;
  document.body.appendChild(viewer);

  const stage  = viewer.querySelector('#img-viewer-stage');
  const img    = viewer.querySelector('#img-viewer-img');
  const bg     = viewer.querySelector('#img-viewer-bg');

  // Disable browser pinch-zoom while viewer is open
  const vpMeta = document.querySelector('meta[name=viewport]');
  if (vpMeta) vpMeta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';

  // ── State ──
  let scale = 1, minScale = 1, maxScale = 8;
  let tx = 0, ty = 0;
  let startTx = 0, startTy = 0;
  let isDragging = false;
  let didMove = false;

  // Pinch state
  let lastDist = 0, startScale = 1;
  let pinchOriginX = 0, pinchOriginY = 0;
  let isPinching = false;

  function clampTranslate(x, y, s) {
    const iw = img.naturalWidth  * s;
    const ih = img.naturalHeight * s;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const maxX = Math.max(0, (iw - sw) / 2);
    const maxY = Math.max(0, (ih - sh) / 2);
    return [
      Math.min(maxX, Math.max(-maxX, x)),
      Math.min(maxY, Math.max(-maxY, y)),
    ];
  }

  function applyTransform(s, x, y, animate = false) {
    scale = Math.min(maxScale, Math.max(minScale, s));
    [tx, ty] = clampTranslate(x, y, scale);
    img.style.transition = animate ? 'transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none';
    img.style.transform  = `translate(${tx}px, ${ty}px) scale(${scale})`;
    stage.style.cursor   = scale > minScale + 0.01 ? 'grab' : 'zoom-in';
  }

  function snapToFit(animate = true) {
    applyTransform(minScale, 0, 0, animate);
  }

  function dist(t) {
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }
  function mid(t) {
    return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
  }

  // ── Touch ──
  stage.addEventListener('touchstart', (e) => {
    didMove = false;
    if (e.touches.length === 2) {
      isPinching = true;
      isDragging = false;
      e.preventDefault();
      lastDist   = dist(e.touches);
      startScale = scale;
      const m    = mid(e.touches);
      const rect = stage.getBoundingClientRect();
      pinchOriginX = m.x - rect.left - rect.width  / 2 - tx;
      pinchOriginY = m.y - rect.top  - rect.height / 2 - ty;
      startTx = tx; startTy = ty;
    } else if (e.touches.length === 1 && !isPinching) {
      isDragging = true;
      startTx = tx - e.touches[0].clientX;
      startTy = ty - e.touches[0].clientY;
    }
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    e.preventDefault();
    didMove = true;
    if (e.touches.length === 2 && isPinching) {
      const newDist  = dist(e.touches);
      const newScale = startScale * (newDist / lastDist);
      const ratio    = newScale / startScale;
      applyTransform(newScale,
        startTx - pinchOriginX * (ratio - 1),
        startTy - pinchOriginY * (ratio - 1)
      );
    } else if (e.touches.length === 1 && isDragging) {
      applyTransform(scale,
        e.touches[0].clientX + startTx,
        e.touches[0].clientY + startTy
      );
    }
  }, { passive: false });

  stage.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) isPinching = false;
    if (e.touches.length < 2)  isDragging = false;
    if (scale < minScale + 0.02) snapToFit(true);
  });

  // Double-tap: toggle between fit and 3×
  let lastTap = 0;
  stage.addEventListener('touchend', (e) => {
    if (e.touches.length > 0 || didMove) return;
    const now = Date.now();
    if (now - lastTap < 280) {
      if (scale > minScale + 0.5) {
        snapToFit(true);
      } else {
        const t    = e.changedTouches[0];
        const rect = stage.getBoundingClientRect();
        applyTransform(3,
          -(t.clientX - rect.left - rect.width  / 2),
          -(t.clientY - rect.top  - rect.height / 2),
          true
        );
      }
    }
    lastTap = now;
  });

  stage.addEventListener('click', (e) => {
    if (didMove) return;
    if (e.target === stage) closeViewer();
  });
  bg.addEventListener('click', closeViewer);

  // ── Mouse wheel zoom ──
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect  = stage.getBoundingClientRect();
    const ox    = e.clientX - rect.left - rect.width  / 2 - tx;
    const oy    = e.clientY - rect.top  - rect.height / 2 - ty;
    const delta = e.deltaY < 0 ? 1.15 : 0.87;
    const ns    = scale * delta;
    const ratio = ns / scale;
    if (ns <= minScale + 0.02) { snapToFit(true); return; }
    applyTransform(ns, tx - ox * (ratio - 1), ty - oy * (ratio - 1));
  }, { passive: false });

  // ── Mouse drag ──
  let mouseDown = false;
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    didMove    = false;
    mouseDown  = true;
    isDragging = scale > minScale + 0.01;
    startTx = tx - e.clientX;
    startTy = ty - e.clientY;
    if (isDragging) { stage.style.cursor = 'grabbing'; e.preventDefault(); }
  });
  window.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) didMove = true;
    if (isDragging) applyTransform(scale, e.clientX + startTx, e.clientY + startTy);
  });
  window.addEventListener('mouseup', (e) => {
    if (!mouseDown) return;
    mouseDown = false;
    if (!isDragging && !didMove && e.target === stage) closeViewer();
    isDragging = false;
    stage.style.cursor = scale > minScale + 0.01 ? 'grab' : 'zoom-in';
  });

  // ── Close ──
  viewer.querySelector('#img-viewer-close').onclick = closeViewer;
  document.addEventListener('keydown', onKey);

  function onKey(e) { if (e.key === 'Escape') closeViewer(); }
  function closeViewer() {
    viewer.remove();
    document.removeEventListener('keydown', onKey);
    if (vpMeta) vpMeta.content = 'width=device-width, initial-scale=1.0';
  }

  // ── Init: compute fit scale after image loads ──
  function initScale() {
    const sw  = stage.clientWidth  || window.innerWidth;
    const sh  = stage.clientHeight || (window.innerHeight - 56);
    const fit = Math.min(sw / img.naturalWidth, sh / img.naturalHeight, 1);
    minScale  = fit;
    applyTransform(fit, 0, 0, false);
  }
  if (img.complete && img.naturalWidth) {
    initScale();
  } else {
    img.addEventListener('load', initScale);
  }
}
