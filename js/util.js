export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const STATUS = {
  outstanding: { zh: '未完成', en: 'Outstanding', color: '#d93025' },
  rectified: { zh: '已修復', en: 'Rectified', color: '#188038' },
  closed: { zh: '已關閉', en: 'Closed', color: '#6b7280' },
};

export const naturalCompare = (a, b) =>
  String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });

export const sortDefects = (list) => list.sort((a, b) => naturalCompare(a.itemNo, b.itemNo));

export function nextItemNo(defects) {
  let max = 0;
  for (const d of defects) {
    const n = parseInt(d.itemNo, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return String(max + 1);
}

export function fmtDate(v) {
  if (!v) return '';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00') : new Date(v);
  if (isNaN(d)) return String(v);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
export const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};
export const safeName = (s) => String(s || 'project').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60);

// ---------- images ----------
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = src instanceof Blob ? URL.createObjectURL(src) : src;
    img.onload = () => { if (src instanceof Blob) URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { if (src instanceof Blob) URL.revokeObjectURL(url); reject(new Error('無法讀取圖片')); };
    img.src = url;
  });
}
export const canvasToBlob = (c, type = 'image/jpeg', q = 0.85) =>
  new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('圖片轉換失敗'))), type, q));

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Resize a photo/image file to maxSide (EXIF rotation is applied by the browser).
export async function compressImage(file, maxSide = 1600, quality = 0.82) {
  const img = await loadImage(file);
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { blob: await canvasToBlob(c, 'image/jpeg', quality), w: c.width, h: c.height };
}

export const blobToDataURL = (b) =>
  new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); });
export async function dataURLToBlob(d) {
  const [head, body] = d.split(',');
  const mime = head.match(/data:([^;]+)/)?.[1] || 'application/octet-stream';
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Object URLs created for the current screen; revoked on navigation.
const urls = new Set();
export function objURL(blob) {
  if (!blob) return '';
  const u = URL.createObjectURL(blob);
  urls.add(u);
  return u;
}
export function revokeAll() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls.clear();
}

// ---------- UI helpers ----------
export function toast(msg, ms = 2200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

export function pickFiles({ accept = 'image/*', capture = false, multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (capture) input.setAttribute('capture', 'environment');
    if (multiple) input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); }, { once: true });
    input.click();
  });
}

export function modal(innerHtml, cls = '') {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${cls}">${innerHtml}</div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  return { el: wrap.firstElementChild, close };
}

export function busy(msg) {
  const w = document.createElement('div');
  w.className = 'busy';
  w.innerHTML = `<div class="busy-box"><div class="spinner"></div><div class="busy-msg">${esc(msg)}</div></div>`;
  document.body.appendChild(w);
  return {
    set: (m) => { w.querySelector('.busy-msg').textContent = m; },
    close: () => w.remove(),
  };
}

// Offer Share (phones) and Download for a generated file.
export function deliverFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const sizeMB = (blob.size / 1048576).toFixed(1);
  const m = modal(`
    <h3>檔案已準備好</h3>
    <p class="muted">${esc(filename)}（${sizeMB} MB）</p>
    <div class="stack">
      ${canShare ? '<button class="btn primary" data-a="share">分享 / 儲存到檔案</button>' : ''}
      <button class="btn ${canShare ? '' : 'primary'}" data-a="dl">下載</button>
      <button class="btn ghost" data-a="close">關閉</button>
    </div>`);
  m.el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'share') {
      try { await navigator.share({ files: [file], title: filename }); m.close(); } catch (err) { if (err.name !== 'AbortError') toast('分享失敗，請改用下載'); }
    } else if (a === 'dl') {
      const u = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = u; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
    } else if (a === 'close') m.close();
  });
}

export function parseQuery(hash) {
  const q = hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}
