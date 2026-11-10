// Photo annotation (arrows, circles, boxes, pen, text) stored as vector shapes
// in coordinates normalised to the image (0..1), so the original photo is kept
// and marks can be edited later. Shapes are flattened only for thumbnails/export.
import { loadImage, makeCanvas, canvasToBlob, esc, STATUS } from './util.js';

const FONT = '-apple-system, "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
export const COLORS = ['#e53935', '#fdd835', '#1e88e5', '#ffffff', '#111111'];
export const WIDTHS = { thin: 0.004, mid: 0.007, thick: 0.012 };

export function drawShapes(ctx, shapes, W, H) {
  const L = Math.max(W, H);
  for (const s of shapes || []) {
    ctx.save();
    ctx.strokeStyle = s.c;
    ctx.fillStyle = s.c;
    const lw = Math.max(1, s.w * L);
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const P = (p) => [p[0] * W, p[1] * H];
    if (s.t === 'pen') {
      ctx.beginPath();
      s.pts.forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      if (s.pts.length === 1) { const [x, y] = P(s.pts[0]); ctx.lineTo(x + 0.1, y); }
      ctx.stroke();
    } else if (s.t === 'rect') {
      const [x1, y1] = P(s.a), [x2, y2] = P(s.b);
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (s.t === 'ellipse') {
      const [x1, y1] = P(s.a), [x2, y2] = P(s.b);
      ctx.beginPath();
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.max(Math.abs(x2 - x1) / 2, 1), Math.max(Math.abs(y2 - y1) / 2, 1), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.t === 'arrow') {
      const [x1, y1] = P(s.a), [x2, y2] = P(s.b);
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(lw * 4, L * 0.025);
      const bx = x2 - Math.cos(ang) * head * 0.8, by = y2 - Math.sin(ang) * head * 0.8;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(bx, by); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
      ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fill();
    } else if (s.t === 'text') {
      const fs = s.size * L;
      const [x, y] = P(s.a);
      ctx.font = `bold ${fs}px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = fs * 0.2;
      ctx.strokeStyle = s.c === '#ffffff' || s.c === '#fdd835' ? '#000' : '#fff';
      ctx.strokeText(s.text, x, y);
      ctx.fillText(s.text, x, y);
    }
    ctx.restore();
  }
}

// Render a photo with its annotations onto a canvas (long side <= maxSide).
export async function renderPhoto(photo, maxSide = 1600) {
  const img = await loadImage(photo.blob);
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  drawShapes(ctx, photo.annotations, c.width, c.height);
  return c;
}
export async function makeThumb(photo) {
  return canvasToBlob(await renderPhoto(photo, 400), 'image/jpeg', 0.75);
}

// Draw numbered pins on a plan. box = {x,y,w,h} where the plan image is drawn; r = pin radius.
export function drawPins(ctx, defects, box, r) {
  for (const d of defects) {
    if (d.x == null || d.y == null) continue;
    const x = box.x + d.x * box.w, y = box.y + d.y * box.h;
    const label = String(d.itemNo ?? '');
    ctx.save();
    ctx.font = `bold ${r * (label.length > 2 ? 0.85 : 1.05)}px ${FONT}`;
    const tw = Math.max(r * 2, ctx.measureText(label).width + r * 0.8);
    ctx.fillStyle = STATUS[d.status]?.color || STATUS.outstanding.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = r * 0.22;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - tw / 2, y - r, tw, r * 2, r); else ctx.rect(x - tw / 2, y - r, tw, r * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + r * 0.06);
    ctx.restore();
  }
}

export async function renderPlanWithPins(plan, defects, maxSide = 2400) {
  const img = await loadImage(plan.blob);
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  drawPins(ctx, defects, { x: 0, y: 0, w: c.width, h: c.height }, Math.max(c.width, c.height) * 0.011);
  return c;
}

// ---------- editor ----------
const TOOLS = [
  ['arrow', '➚', '箭頭'],
  ['ellipse', '◯', '圓圈'],
  ['rect', '▢', '方框'],
  ['pen', '✎', '畫筆'],
  ['text', 'T', '文字'],
];

function pref(key, fallback) {
  try { return localStorage.getItem('annot.' + key) || fallback; } catch { return fallback; }
}
function setPref(key, v) {
  try { localStorage.setItem('annot.' + key, v); } catch { /* ignore */ }
}

// Opens the full-screen editor. Resolves with the new shapes array, or null if cancelled.
export async function openAnnotator(photo) {
  const img = await loadImage(photo.blob);
  const shapes = JSON.parse(JSON.stringify(photo.annotations || []));
  let tool = pref('tool', 'arrow');
  let color = pref('color', COLORS[0]);
  let width = pref('width', 'mid');

  const root = document.createElement('div');
  root.className = 'annot';
  root.innerHTML = `
    <div class="annot-top">
      <button class="btn ghost light" data-a="cancel">取消</button>
      <div class="annot-actions">
        <button class="btn ghost light" data-a="undo" title="撤銷">↶ 撤銷</button>
        <button class="btn ghost light" data-a="clear">清除</button>
      </div>
      <button class="btn primary" data-a="done">完成</button>
    </div>
    <div class="annot-stage"><canvas></canvas></div>
    <div class="annot-bar">
      <div class="annot-row">
        ${TOOLS.map(([k, icon, label]) => `<button class="tool" data-tool="${k}"><span>${icon}</span><small>${label}</small></button>`).join('')}
      </div>
      <div class="annot-row">
        ${COLORS.map((c) => `<button class="swatch" data-color="${c}" style="background:${c}" aria-label="顏色 ${c}"></button>`).join('')}
        <span class="sep"></span>
        ${Object.keys(WIDTHS).map((k) => `<button class="wbtn" data-width="${k}"><i style="height:${{ thin: 2, mid: 4, thick: 7 }[k]}px"></i></button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add('noscroll');

  const stage = root.querySelector('.annot-stage');
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  let dispW = 0, dispH = 0, dpr = 1;
  let current = null;

  function layout() {
    const sw = stage.clientWidth - 16, sh = stage.clientHeight - 16;
    const s = Math.min(sw / img.naturalWidth, sh / img.naturalHeight);
    dispW = Math.floor(img.naturalWidth * s);
    dispH = Math.floor(img.naturalHeight * s);
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.style.width = dispW + 'px';
    canvas.style.height = dispH + 'px';
    canvas.width = Math.round(dispW * dpr);
    canvas.height = Math.round(dispH * dpr);
    draw();
  }
  function draw() {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawShapes(ctx, current ? [...shapes, current] : shapes, canvas.width, canvas.height);
  }
  function syncUI() {
    root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    root.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
    root.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('on', b.dataset.width === width));
  }
  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  let activePointer = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (activePointer !== null) return;
    e.preventDefault();
    const p = pt(e);
    if (tool === 'text') {
      setTimeout(() => {
        const text = prompt('輸入文字');
        if (text && text.trim()) { shapes.push({ t: 'text', c: color, w: WIDTHS[width], size: WIDTHS[width] * 6, a: p, text: text.trim() }); draw(); }
      }, 0);
      return;
    }
    activePointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    current = tool === 'pen' ? { t: 'pen', c: color, w: WIDTHS[width], pts: [p] } : { t: tool, c: color, w: WIDTHS[width], a: p, b: p };
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointer || !current) return;
    const p = pt(e);
    if (current.t === 'pen') current.pts.push(p); else current.b = p;
    draw();
  });
  const finish = (e) => {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    if (current) {
      const tiny = current.t !== 'pen' && Math.hypot(current.b[0] - current.a[0], current.b[1] - current.a[1]) < 0.01;
      if (tiny && current.t === 'ellipse') {
        // Tap = default-size circle
        current.a = [current.a[0] - 0.06, current.a[1] - 0.06 * (dispW / dispH)];
        current.b = [current.a[0] + 0.12, current.a[1] + 0.12 * (dispW / dispH)];
        shapes.push(current);
      } else if (!tiny) shapes.push(current);
      current = null;
      draw();
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  const onResize = () => layout();
  window.addEventListener('resize', onResize);

  return new Promise((resolve) => {
    const close = (val) => {
      window.removeEventListener('resize', onResize);
      document.body.classList.remove('noscroll');
      root.remove();
      resolve(val);
    };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) { tool = b.dataset.tool; setPref('tool', tool); }
      else if (b.dataset.color) { color = b.dataset.color; setPref('color', color); }
      else if (b.dataset.width) { width = b.dataset.width; setPref('width', width); }
      else if (b.dataset.a === 'undo') { shapes.pop(); draw(); }
      else if (b.dataset.a === 'clear') { if (shapes.length && confirm('清除所有標註？')) { shapes.length = 0; draw(); } }
      else if (b.dataset.a === 'cancel') close(null);
      else if (b.dataset.a === 'done') close(shapes);
      syncUI();
    });
    syncUI();
    requestAnimationFrame(layout);
  });
}

export function photoViewer(url, caption = '') {
  const w = document.createElement('div');
  w.className = 'viewer';
  w.innerHTML = `<img src="${url}" alt=""><div class="viewer-cap">${esc(caption)}</div><button class="btn light ghost viewer-x">關閉</button>`;
  w.addEventListener('click', () => w.remove());
  document.body.appendChild(w);
}
