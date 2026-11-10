// Report generation for all report types.
// PDF: pages are drawn on a canvas and wrapped in a minimal PDF file (so Chinese text
// works without embedding fonts). Word: built with the docx library.
import * as db from './db.js';
import { renderPhoto, renderPlanWithPins, drawPins } from './annotate.js';
import { STATUS, sortDefects, fmtDate, loadImage, canvasToBlob, makeCanvas } from './util.js';
import { getDocx } from './libs.js';
import { TYPES, typeOf, DEFECT_TYPES, REPAIR_METHODS, dimCalc, fmtNum, sizeText } from './types.js';

const FONT = '-apple-system, "Segoe UI", Arial, "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
const SCOPE_LABEL = {
  all: 'All items',
  open: 'Outstanding and rectified items (closed items excluded)',
  outstanding: 'Outstanding items only',
};

// ======================= data =======================
export async function collectReport(projectId, opts) {
  const { project, plans, defects } = await db.projectData(projectId);
  const settings = await db.getSettings();
  const type = typeOf(project);
  let scoped = defects, list;
  if (type === 'defect') {
    scoped = defects.filter((d) => !opts.area || (d.area || '') === opts.area);
    list = scoped.filter((d) => (opts.scope === 'all' ? true : opts.scope === 'open' ? d.status !== 'closed' : d.status === 'outstanding'));
  } else list = [...defects];
  sortDefects(list);
  const ids = new Set(list.flatMap((d) => (type === 'defect'
    ? [...(d.before || []).slice(0, 2), ...(d.after || []).slice(0, 2)]
    : Object.values(d.photos || {}).filter(Boolean))));
  const photos = {};
  for (const id of ids) {
    const p = await db.get('photos', id);
    if (p) photos[id] = p;
  }
  const usedPlans = opts.plans ? plans.sort((a, b) => a.createdAt - b.createdAt).filter((p) => list.some((d) => d.planId === p.id)) : [];
  const logoImg = settings.logo ? await loadImage(settings.logo).catch(() => null) : null;
  return { type, project, settings, logoImg, defects: list, scoped, photos, plans: usedPlans, opts };
}

function counts(list) {
  const c = { outstanding: 0, rectified: 0, closed: 0 };
  list.forEach((d) => { c[d.status] = (c[d.status] || 0) + 1; });
  return c;
}
function areaCounts(list) {
  const m = new Map();
  for (const d of list) {
    const k = d.area || '(no area)';
    if (!m.has(k)) m.set(k, { outstanding: 0, rectified: 0, closed: 0 });
    m.get(k)[d.status]++;
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}
const reportTitle = (R) => {
  const t = R.project.title || TYPES[R.type].title;
  return R.type === 'defect' && R.project.dates ? `${t} (as per site checking on ${R.project.dates})` : t;
};
const projectLine = (R) => [R.project.code, R.project.name].filter(Boolean).join(' - ');
function statusLines(d) {
  const out = [];
  if (d.ref) out.push(`Ref: ${d.ref}`);
  if (d.status === 'rectified' && d.rectifiedAt) out.push(`Rectified on ${fmtDate(d.rectifiedAt)}`);
  if (d.status === 'closed' && d.closedAt) out.push(`Closed on ${fmtDate(d.closedAt)}`);
  if (d.dueDate && d.status === 'outstanding') out.push(`To be completed before ${fmtDate(d.dueDate)}`);
  if (d.category) out.push(d.category);
  if (d.remarks) out.push(d.remarks);
  return out;
}
const slotPhoto = (R, d, key) => R.photos[d.photos?.[key]];
const mainPhoto = (R, d) => slotPhoto(R, d, 'main');
const conditionHeading = (R, d) => [d.section, R.project.dates ? `Site Photo as of ${R.project.dates}` : ''].filter(Boolean).join('  —  ');
const recCaption = (R, d) => {
  if (R.type === 'condition') return [`${String(d.no).padStart(2, '0')}  ${d.caption || ''}`.trim(), d.location ? `Location: ${d.location}` : ''];
  const dims = sizeText(d) ? `${sizeText(d)} mm` : '';
  return [`No. ${d.no}${d.ref ? `  ${d.ref}` : ''}`, [d.location, dims].filter(Boolean).join('  ·  ')];
};
const totalArea = (R) => R.defects.reduce((s, d) => s + dimCalc(d).area, 0);

// ======================= PDF: canvas page helpers =======================
const K = 7; // canvas pixels per mm (~178 dpi)
let PW = 297, PH = 210;
const M = 10, TOP = 28, FOOT = 7;
const setOrientation = (landscape) => { PW = landscape ? 297 : 210; PH = landscape ? 210 : 297; };

function newPage() {
  const c = makeCanvas(PW * K, PH * K);
  const ctx = c.getContext('2d');
  ctx.scale(K, K);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PW, PH);
  ctx.lineWidth = 0.25;
  ctx.strokeStyle = '#888';
  return { c, ctx };
}
function setFont(ctx, size, bold) { ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`; }
function txt(ctx, s, x, y, { size = 2.9, bold = false, color = '#111', align = 'left', maxW } = {}) {
  setFont(ctx, size, bold);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  let str = String(s ?? '');
  if (maxW && ctx.measureText(str).width > maxW) {
    while (str.length > 1 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1);
    str += '…';
  }
  ctx.fillText(str, x, y);
  ctx.textAlign = 'left';
}
function wrap(ctx, s, maxW) {
  const lines = [];
  for (const para of String(s ?? '').split(/\n/)) {
    let line = '';
    const tokens = para.match(/[⺀-鿿豈-﫿＀-￯]|[^\s⺀-鿿豈-﫿＀-￯]+|\s+/g) || [''];
    for (const tok of tokens) {
      const test = line + tok;
      if (ctx.measureText(test).width <= maxW || !line.trim()) {
        if (ctx.measureText(test).width > maxW && !line.trim()) {
          let piece = '';
          for (const ch of tok) {
            if (ctx.measureText(piece + ch).width > maxW && piece) { lines.push(piece); piece = ''; }
            piece += ch;
          }
          line = piece;
        } else line = test;
      } else {
        lines.push(line.trimEnd());
        line = tok.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
function para(ctx, s, x, y, w, maxH, { size = 2.9, bold = false, color = '#111', lh = 1.32 } = {}) {
  setFont(ctx, size, bold);
  const lines = wrap(ctx, s, w);
  const step = size * lh;
  const max = Math.max(1, Math.floor(maxH / step));
  const shown = lines.slice(0, max);
  if (lines.length > max) shown[max - 1] = shown[max - 1].replace(/.{0,2}$/, '') + '…';
  ctx.fillStyle = color;
  shown.forEach((l, i) => ctx.fillText(l, x, y + size + i * step));
  return shown.length * step;
}
function drawContain(ctx, src, x, y, w, h) {
  const s = Math.min(w / src.width, h / src.height);
  const dw = src.width * s, dh = src.height * s;
  ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh };
}
async function photoBox(ctx, photo, x, y, w, h, cache) {
  if (!photo) {
    const ph = Math.min(h, w * 0.75), py = y + (h - ph) / 2;
    ctx.fillStyle = '#f3f4f6'; ctx.fillRect(x, py, w, ph);
    txt(ctx, 'No photo', x + w / 2, py + ph / 2 + 1, { size: 2.8, color: '#999', align: 'center' });
    return { x, y: py, w, h: ph };
  }
  if (!cache.has(photo.id)) cache.set(photo.id, await renderPhoto(photo, 1000));
  const b = drawContain(ctx, cache.get(photo.id), x, y, w, h);
  ctx.strokeStyle = '#bbb'; ctx.lineWidth = 0.2;
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  return b;
}

function drawHeader(ctx, R, pageNo, total) {
  let right = PW - M;
  if (R.logoImg) {
    const h = 12, w = Math.min(45, (h * R.logoImg.width) / R.logoImg.height);
    ctx.drawImage(R.logoImg, right - w, M - 1, w, h);
    right -= w + 3;
  }
  const company = R.settings.companyName;
  if (company) txt(ctx, company, right, M + 4, { size: 3, color: '#444', align: 'right', maxW: 60 });
  txt(ctx, projectLine(R), M, M + 4, { size: 4, bold: true, maxW: right - M - (company ? 64 : 0) });
  txt(ctx, reportTitle(R), M, M + 10, { size: 3.3, color: '#333', maxW: PW - 2 * M });
  ctx.strokeStyle = '#999'; ctx.lineWidth = 0.3;
  ctx.beginPath(); ctx.moveTo(M, M + 13.5); ctx.lineTo(PW - M, M + 13.5); ctx.stroke();
  txt(ctx, `Generated on ${fmtDate(Date.now())}`, M, PH - 5, { size: 2.4, color: '#777' });
  txt(ctx, `Page ${pageNo} of ${total}`, PW - M, PH - 5, { size: 2.4, color: '#777', align: 'right' });
}

async function drawPlanPage(ctx, R, plan) {
  txt(ctx, `Location Plan - ${plan.name || ''}`, M, TOP + 2, { size: 4, bold: true });
  const img = await loadImage(plan.blob);
  const box = drawContain(ctx, img, M, TOP + 5, PW - 2 * M, PH - TOP - 5 - M - FOOT - 4);
  ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.2;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  drawPins(ctx, R.defects.filter((d) => d.planId === plan.id), box, 2.4);
  if (R.type === 'defect') {
    let lx = M;
    const ly = PH - M - FOOT + 2;
    for (const k of ['outstanding', 'rectified', 'closed']) {
      ctx.fillStyle = STATUS[k].color;
      ctx.beginPath(); ctx.arc(lx + 1.5, ly - 1, 1.5, 0, Math.PI * 2); ctx.fill();
      txt(ctx, STATUS[k].en, lx + 4.5, ly, { size: 2.6, color: '#444' });
      lx += 28;
    }
  }
}

function buildPdf(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  let len = 0;
  const offsets = [];
  const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); len += b.length; };
  const obj = (num, body) => { offsets[num] = len; push(`${num} 0 obj\n`); body(); push('\nendobj\n'); };
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const n = pages.length;
  const total = 2 + 3 * n;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${n} >>`));
  pages.forEach((p, i) => {
    const pn = 3 + 3 * i, cn = pn + 1, im = pn + 2;
    obj(pn, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.wPt} ${p.hPt}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${cn} 0 R >>`));
    const cs = `q ${p.wPt} 0 0 ${p.hPt} 0 0 cm /Im0 Do Q`;
    obj(cn, () => { push(`<< /Length ${cs.length} >>\nstream\n`); push(cs); push('\nendstream'); });
    obj(im, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push('\nendstream');
    });
  });
  const xref = len;
  push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let k = 1; k <= total; k++) push(`${String(offsets[k]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(chunks, { type: 'application/pdf' });
}

// Renders a list of page painters into a PDF. painter(ctx, pageNo, total) draws one page.
async function renderPages(R, painters, progress) {
  const out = [];
  const total = painters.length;
  for (let i = 0; i < total; i++) {
    progress(`製作第 ${i + 1}/${total} 頁`);
    const { c, ctx } = newPage();
    drawHeader(ctx, R, i + 1, total);
    await painters[i](ctx);
    const blob = await canvasToBlob(c, 'image/jpeg', 0.85);
    out.push({
      jpeg: new Uint8Array(await blob.arrayBuffer()), pxW: c.width, pxH: c.height,
      wPt: +(PW * 2.83465).toFixed(2), hPt: +(PH * 2.83465).toFixed(2),
    });
    c.width = c.height = 1; // free memory (iOS)
  }
  return buildPdf(out);
}

export async function exportPdf(R, progress = () => {}) {
  setOrientation(R.type === 'defect');
  const painters = R.type === 'defect' ? defectPainters(R)
    : R.type === 'condition' ? conditionPainters(R)
      : formPainters(R);
  return renderPages(R, painters, progress);
}

// ---------- PDF: Defect List (landscape) ----------
const THEAD = 8, ROW = 52;
const COLS = [
  ['Item', 12], ['Area', 14], ['Location', 26], ['Before Photo', 70],
  ['Description', 52], ['After Photo (Reply)', 70], ['Status / Remarks', 33],
];

function drawSummary(ctx, R) {
  txt(ctx, 'Summary', M, TOP + 2, { size: 4.5, bold: true });
  const info = [
    ['Project No.', R.project.code], ['Project', R.project.name], ['Client', R.project.client],
    ['Inspection date(s)', R.project.dates], ['Report scope', SCOPE_LABEL[R.opts.scope]],
    ['Area', R.opts.area || 'All areas'], ['Items in this report', String(R.defects.length)],
  ].filter(([, v]) => v);
  let y = TOP + 9;
  for (const [k, v] of info) {
    txt(ctx, k, M, y, { size: 3, color: '#555' });
    const h = para(ctx, v, M + 34, y - 3, 95, 12, { size: 3 });
    y += Math.max(5.2, h + 1.5);
  }
  y += 4;
  const c = counts(R.scoped);
  txt(ctx, 'Status of all recorded items' + (R.opts.area ? ` (${R.opts.area})` : ''), M, y, { size: 3.2, bold: true });
  y += 3;
  const rows = [
    ['Outstanding', c.outstanding, STATUS.outstanding.color], ['Rectified', c.rectified, STATUS.rectified.color],
    ['Closed', c.closed, STATUS.closed.color], ['Total', R.scoped.length, '#111'],
  ];
  ctx.lineWidth = 0.25; ctx.strokeStyle = '#999';
  for (const [lab, n, color] of rows) {
    ctx.strokeRect(M, y, 60, 7); ctx.strokeRect(M + 60, y, 25, 7);
    txt(ctx, lab, M + 2, y + 4.8, { size: 3, bold: lab === 'Total', color });
    txt(ctx, String(n), M + 83, y + 4.8, { size: 3, bold: true, align: 'right' });
    y += 7;
  }
  const ax = 150, colW = [50, 22, 22, 22, 22];
  let ay = TOP + 2;
  txt(ctx, 'Items by area', ax, ay, { size: 3.2, bold: true });
  ay += 3;
  const rowA = (cells, bold, fill) => {
    let x = ax;
    cells.forEach((v, i) => {
      if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, ay, colW[i], 6.5); }
      ctx.strokeRect(x, ay, colW[i], 6.5);
      txt(ctx, v, i ? x + colW[i] - 2 : x + 2, ay + 4.5, { size: 2.8, bold, align: i ? 'right' : 'left', maxW: colW[i] - 3 });
      x += colW[i];
    });
    ay += 6.5;
  };
  rowA(['Area', 'Outstanding', 'Rectified', 'Closed', 'Total'], true, '#eef0f3');
  const areas = areaCounts(R.scoped);
  const maxRows = Math.floor((PH - M - FOOT - ay) / 6.5) - 1;
  areas.slice(0, maxRows).forEach(([a, v]) => rowA([a, v.outstanding, v.rectified, v.closed, v.outstanding + v.rectified + v.closed].map(String), false));
  if (areas.length > maxRows) txt(ctx, `+ ${areas.length - maxRows} more areas`, ax, ay + 4, { size: 2.6, color: '#777' });
}

async function defectPhotoCell(ctx, R, ids, x, y, w, h, cache, emptyText, captionPrefix) {
  const list = (ids || []).map((id) => R.photos[id]).filter(Boolean).slice(0, 2);
  const pad = 1.5, capH = 3.6;
  if (!list.length) {
    txt(ctx, emptyText, x + w / 2, y + h / 2 + 1, { size: 2.7, color: '#999', align: 'center' });
    return;
  }
  const tileW = (w - pad * (list.length + 1)) / list.length;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!cache.has(p.id)) cache.set(p.id, await renderPhoto(p, 900));
    drawContain(ctx, cache.get(p.id), x + pad + i * (tileW + pad), y + pad, tileW, h - pad * 2 - capH);
  }
  const extra = (ids || []).length - list.length;
  const cap = `${captionPrefix}${fmtDate(list[0].takenAt)}${extra > 0 ? `  (+${extra} more photo${extra > 1 ? 's' : ''})` : ''}`;
  txt(ctx, cap, x + w / 2, y + h - 1.6, { size: 2.4, color: '#666', align: 'center', maxW: w - 2 });
}

async function drawDefectRow(ctx, R, d, y, cache) {
  let x = M;
  const cell = COLS.map(([, w]) => { const c = { x, w }; x += w; return c; });
  ctx.lineWidth = 0.25; ctx.strokeStyle = '#888';
  cell.forEach((c) => ctx.strokeRect(c.x, y, c.w, ROW));
  const p = 1.5;
  txt(ctx, d.no, cell[0].x + p, y + 5, { size: 3.4, bold: true, maxW: cell[0].w - 2 * p });
  para(ctx, d.area, cell[1].x + p, y + p, cell[1].w - 2 * p, ROW - 3, { size: 2.8 });
  para(ctx, d.location, cell[2].x + p, y + p, cell[2].w - 2 * p, ROW - 3, { size: 2.8 });
  await defectPhotoCell(ctx, R, d.before, cell[3].x, y, cell[3].w, ROW, cache, 'No photo', '');
  para(ctx, d.description, cell[4].x + p, y + p, cell[4].w - 2 * p, ROW - 3, { size: 3 });
  await defectPhotoCell(ctx, R, d.after, cell[5].x, y, cell[5].w, ROW, cache,
    d.status === 'outstanding' ? 'Pending rectification' : 'No photo', 'Reply: ');
  const s = STATUS[d.status] || STATUS.outstanding;
  txt(ctx, s.en, cell[6].x + p, y + 5, { size: 3.1, bold: true, color: s.color });
  para(ctx, statusLines(d).join('\n'), cell[6].x + p, y + 6.5, cell[6].w - 2 * p, ROW - 8, { size: 2.6, color: '#333' });
}

function defectPainters(R) {
  const perPage = Math.floor((PH - M - FOOT - TOP - THEAD) / ROW);
  const painters = [];
  if (R.opts.summary) painters.push(async (ctx) => drawSummary(ctx, R));
  for (const plan of R.plans) painters.push((ctx) => drawPlanPage(ctx, R, plan));
  const pages = Math.max(1, Math.ceil(R.defects.length / perPage));
  for (let i = 0; i < pages; i++) {
    const rows = R.defects.slice(i * perPage, (i + 1) * perPage);
    painters.push(async (ctx) => {
      let x = M;
      for (const [lab, w] of COLS) {
        ctx.fillStyle = '#eef0f3'; ctx.fillRect(x, TOP, w, THEAD);
        ctx.strokeStyle = '#888'; ctx.strokeRect(x, TOP, w, THEAD);
        txt(ctx, lab, x + 1.5, TOP + 5.3, { size: 2.9, bold: true, maxW: w - 3 });
        x += w;
      }
      if (!rows.length) txt(ctx, 'No items in this report.', M + 2, TOP + THEAD + 8, { size: 3.2, color: '#777' });
      const cache = new Map();
      for (let r = 0; r < rows.length; r++) await drawDefectRow(ctx, R, rows[r], TOP + THEAD + r * ROW, cache);
      cache.forEach((cv) => { cv.width = cv.height = 1; });
    });
  }
  return painters;
}

// ---------- PDF: photo grids (Condition Survey, Hidden Work Record) ----------
function chunkBySection(R, perPage) {
  const pages = [];
  let cur = null;
  for (const d of R.defects) {
    const head = R.type === 'condition' ? conditionHeading(R, d) : '';
    if (!cur || cur.items.length >= perPage || cur.head !== head) { cur = { head, items: [] }; pages.push(cur); }
    cur.items.push(d);
  }
  return pages;
}

function gridPainters(R, perPage, title) {
  return chunkBySection(R, perPage).map((pg) => async (ctx) => {
    let y0 = TOP;
    const head = pg.head || title;
    if (head) { txt(ctx, head, PW / 2, TOP + 3, { size: 3.8, bold: true, align: 'center', maxW: PW - 2 * M }); y0 += 8; }
    const cache = new Map();
    const avail = PH - M - FOOT - y0;
    if (perPage === 6) {
      const gap = 6, cw = (PW - 2 * M - gap) / 2, rh = avail / 3, capH = 10;
      for (let i = 0; i < pg.items.length; i++) {
        const d = pg.items[i];
        const x = M + (i % 2) * (cw + gap), y = y0 + Math.floor(i / 2) * rh;
        await photoBox(ctx, mainPhoto(R, d), x, y, cw, rh - capH - 2, cache);
        const [c1, c2] = recCaption(R, d);
        txt(ctx, c1, x + cw / 2, y + rh - capH + 2.5, { size: 3.1, bold: true, align: 'center', maxW: cw });
        if (c2) txt(ctx, c2, x + cw / 2, y + rh - capH + 6.7, { size: 2.6, color: '#555', align: 'center', maxW: cw });
      }
    } else {
      const rh = avail / 3, pw = 118, tx = M + pw + 6, tw = PW - M - tx;
      for (let i = 0; i < pg.items.length; i++) {
        const d = pg.items[i];
        const y = y0 + i * rh;
        await photoBox(ctx, mainPhoto(R, d), M, y + 2, pw, rh - 6, cache);
        const no = R.type === 'condition' ? `Photo No.${String(d.no).padStart(2, '0')}` : `No. ${d.no}`;
        txt(ctx, no, tx, y + rh / 2 - 6, { size: 3.6, bold: true });
        let yy = y + rh / 2 - 2;
        const text = [R.type === 'condition' ? d.caption : d.ref, d.location ? `Location: ${d.location}` : '', d.remarks].filter(Boolean).join('\n');
        yy += para(ctx, text, tx, yy, tw, rh / 2, { size: 3 });
      }
    }
    cache.forEach((cv) => { cv.width = cv.height = 1; });
  });
}

function conditionPainters(R) {
  const painters = R.plans.map((plan) => (ctx) => drawPlanPage(ctx, R, plan));
  painters.push(...gridPainters(R, R.opts.perPage === 3 ? 3 : 6, ''));
  if (!R.defects.length) painters.push(async (ctx) => txt(ctx, 'No photos in this report.', M, TOP + 6, { size: 3.2, color: '#777' }));
  return painters;
}

// ---------- PDF: Hidden Work Record / Spalling Record (portrait form) ----------
const FCOLS = [
  ['No.', 10], ['Defect No. / Photo No.', 38], ['Location', 36], ['Type', 11], ['Method', 13],
  ['Length (mm)', 17], ['Width (mm)', 17], ['Area (m²)', 17], ['Girth (m)', 16], ['Thick. (mm)', 15],
];
const FROW = 7;

function drawFormInfo(ctx, R, y) {
  const p = R.project;
  const left = [['Hospital / Client', p.client], ['W.O. No.', p.woNo], ['Location', p.siteLocation]];
  const right = [['Ref.', p.refNo], ['Date', p.signDate || p.dates]];
  left.forEach(([k, v], i) => {
    txt(ctx, `${k} :`, M, y + i * 5.5, { size: 3, color: '#555' });
    txt(ctx, v || '', M + 30, y + i * 5.5, { size: 3, bold: true, maxW: 95 });
  });
  right.forEach(([k, v], i) => {
    txt(ctx, `${k} :`, 140, y + i * 5.5, { size: 3, color: '#555' });
    txt(ctx, v || '', 152, y + i * 5.5, { size: 3, bold: true, maxW: PW - M - 152 });
  });
  y += left.length * 5.5 + 1;
  txt(ctx, 'Defect Type :', M, y, { size: 2.8, color: '#555' });
  txt(ctx, DEFECT_TYPES.map(([k, l]) => `(${k}) ${l}`).join('    '), M + 30, y, { size: 2.8, maxW: PW - 2 * M - 30 });
  y += 5;
  txt(ctx, 'Repair Method :', M, y, { size: 2.8, color: '#555' });
  txt(ctx, REPAIR_METHODS.map(([k, l]) => `(${k}) ${l}`).join('   '), M + 30, y, { size: 2.6, maxW: PW - 2 * M - 30 });
  return y + 4;
}

function drawFormHead(ctx, y) {
  let x = M;
  for (const [lab, w] of FCOLS) {
    ctx.fillStyle = '#eef0f3'; ctx.fillRect(x, y, w, FROW + 3);
    ctx.strokeStyle = '#888'; ctx.lineWidth = 0.25; ctx.strokeRect(x, y, w, FROW + 3);
    para(ctx, lab, x + 1, y + 0.4, w - 2, FROW + 2.6, { size: 2.4, bold: true, lh: 1.15 });
    x += w;
  }
  return y + FROW + 3;
}
function drawFormRow(ctx, d, y) {
  const c = dimCalc(d);
  const cells = [d.no, d.ref || '', d.location || '', d.defectType || '', d.repairMethod || '',
    d.length || '', d.width || '', fmtNum(c.area, 3), fmtNum(c.girth, 2), d.thickness || ''];
  let x = M;
  cells.forEach((v, i) => {
    const w = FCOLS[i][1];
    ctx.strokeStyle = '#888'; ctx.lineWidth = 0.25; ctx.strokeRect(x, y, w, FROW);
    const num = i >= 3;
    txt(ctx, v, num ? x + w / 2 : x + 1.2, y + 4.8, { size: 2.8, align: num ? 'center' : 'left', maxW: w - 2, bold: i === 0 });
    x += w;
  });
}
function drawSignatures(ctx, R, y) {
  const p = R.project;
  txt(ctx, 'Remarks :', M, y, { size: 3, color: '#555' });
  ctx.strokeStyle = '#999'; ctx.lineWidth = 0.2;
  ctx.beginPath(); ctx.moveTo(M + 18, y + 0.8); ctx.lineTo(PW - M, y + 0.8); ctx.stroke();
  y += 12;
  const block = (label, name, title) => {
    txt(ctx, label, M, y, { size: 3, color: '#555' });
    ctx.beginPath(); ctx.moveTo(M + 50, y + 0.8); ctx.lineTo(M + 115, y + 0.8); ctx.stroke();
    txt(ctx, '(Signature)', M + 117, y, { size: 2.8, color: '#555' });
    txt(ctx, 'Date :', M + 140, y, { size: 2.8, color: '#555' });
    txt(ctx, p.signDate || '', M + 150, y, { size: 2.9 });
    ctx.beginPath(); ctx.moveTo(M + 149, y + 0.8); ctx.lineTo(PW - M, y + 0.8); ctx.stroke();
    txt(ctx, `${name || 'name'} (${title || ''})`, M + 82, y + 5, { size: 2.8, align: 'center' });
    y += 16;
  };
  block('Attended and Prepared By :', p.preparedBy, p.preparedTitle || 'TMC - PM / Site Agent');
  block('Inspected By :', p.inspectedBy, p.inspectedTitle || "TMS's Representative");
  if (R.type === 'spalling') {
    txt(ctx, 'Hereby I confirm that the above all are acceptable.', M, y, { size: 2.8, color: '#555' });
    y += 8;
    block('', p.preparedBy, p.preparedTitle || 'TMC - PM / Site Agent');
  }
  return y;
}

function formPainters(R) {
  const painters = [];
  // table pages
  const SIG_H = R.type === 'spalling' ? 78 : 54;
  const rows = [...R.defects];
  const bottom = PH - M - FOOT - 2;
  let first = true;
  const formTitle = TYPES[R.type].title;
  const pages = [];
  while (first || rows.length) {
    const head = first ? 32 + 4 : 4;
    const avail = bottom - (TOP + head) - (FROW + 3) - FROW; // minus header row and total row
    const n = Math.max(0, Math.floor(avail / FROW));
    pages.push({ first, items: rows.splice(0, n) });
    first = false;
  }
  // signature block on the last table page if it fits, else its own page
  const last = pages[pages.length - 1];
  const lastStart = (last.first ? TOP + 36 : TOP + 4) + FROW + 3 + last.items.length * FROW + FROW + 6;
  const sigOwnPage = lastStart + SIG_H > bottom;
  for (const pg of pages) {
    const isLast = pg === last;
    painters.push(async (ctx) => {
      let y = TOP;
      if (pg.first) {
        txt(ctx, formTitle, PW / 2, y + 3, { size: 3.8, bold: true, align: 'center' });
        y = drawFormInfo(ctx, R, y + 10);
      }
      y = drawFormHead(ctx, y + 2);
      for (const d of pg.items) { drawFormRow(ctx, d, y); y += FROW; }
      if (isLast) {
        const wBefore = FCOLS.slice(0, 7).reduce((s, c) => s + c[1], 0);
        txt(ctx, 'Total area', M + wBefore - 2, y + 4.8, { size: 2.9, bold: true, align: 'right' });
        ctx.strokeStyle = '#888'; ctx.strokeRect(M + wBefore, y, FCOLS[7][1], FROW);
        txt(ctx, fmtNum(totalArea(R), 3) || '0', M + wBefore + FCOLS[7][1] / 2, y + 4.8, { size: 2.9, bold: true, align: 'center' });
        y += FROW + 8;
        if (!sigOwnPage) drawSignatures(ctx, R, y);
      } else {
        txt(ctx, 'Continued on next page', PW - M, y + 5, { size: 2.6, color: '#777', align: 'right' });
      }
    });
  }
  if (sigOwnPage) painters.push(async (ctx) => drawSignatures(ctx, R, TOP + 6));
  for (const plan of R.plans) painters.push((ctx) => drawPlanPage(ctx, R, plan));

  if (R.type === 'hwr') {
    painters.push(...gridPainters(R, 6, 'Photo Record'));
  } else if (R.opts.photoPages !== false) {
    for (const d of R.defects) {
      painters.push(async (ctx) => {
        txt(ctx, 'Inspection Record for Spalled Concrete', PW / 2, TOP + 3, { size: 4, bold: true, align: 'center' });
        txt(ctx, `WO No.: ${R.project.woNo || ''}`, M, TOP + 11, { size: 3.2 });
        txt(ctx, `Spalling No.: ${d.no}${d.ref ? ` (${d.ref})` : ''}`, PW - M, TOP + 11, { size: 3.2, bold: true, align: 'right' });
        if (d.location) txt(ctx, `Location: ${d.location}`, M, TOP + 16.5, { size: 3, color: '#444' });
        const y0 = TOP + 21, gap = 6, cw = (PW - 2 * M - gap) / 2;
        const rh = (PH - M - FOOT - y0 - 4) / 2;
        const cache = new Map();
        const slots = TYPES.spalling.slots;
        for (let i = 0; i < 4; i++) {
          const [key, en] = slots[i];
          const x = M + (i % 2) * (cw + gap), y = y0 + Math.floor(i / 2) * rh;
          const b = await photoBox(ctx, slotPhoto(R, d, key), x, y + 7, cw, rh - 20, cache);
          txt(ctx, en, x + cw / 2, b.y - 2.5, { size: 3.4, bold: true, align: 'center' });
          if (sizeText(d)) txt(ctx, `Size: ${sizeText(d)}`, x + cw / 2, b.y + b.h + 5, { size: 3, align: 'center' });
        }
        if (d.remarks) txt(ctx, `Remarks: ${d.remarks}`, M, PH - M - FOOT, { size: 2.8, color: '#444', maxW: PW - 2 * M });
        cache.forEach((cv) => { cv.width = cv.height = 1; });
      });
    }
  }
  return painters;
}

// ======================= WORD =======================
const MM = 56.7; // twips per mm
const PX = 3.7795; // px (96 dpi) per mm

async function jpegData(canvas, q = 0.82) {
  const b = await canvasToBlob(canvas, 'image/jpeg', q);
  return new Uint8Array(await b.arrayBuffer());
}
function fit(w, h, maxW, maxH) {
  const s = Math.min(maxW / w, maxH / h);
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

function kit(D) {
  const { Paragraph, TextRun, TableCell, WidthType, BorderStyle, ShadingType, VerticalAlign } = D;
  const T = (text, o = {}) => new TextRun({ text: String(text ?? ''), size: o.size ?? 17, bold: o.bold, color: o.color, font: 'Arial' });
  const P = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { after: o.after ?? 40, before: o.before }, alignment: o.align });
  const lines = (s, o) => String(s ?? '').split('\n').map((l) => P(T(l, o)));
  const line = { style: BorderStyle.SINGLE, size: 4, color: '888888' };
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const cell = (children, wMm, o = {}) => {
    const b = o.noBorder ? none : line;
    return new TableCell({
      children: children.length ? children : [P(T(''))],
      width: { size: Math.round(wMm * MM), type: WidthType.DXA },
      borders: { top: b, bottom: b, left: b, right: b },
      verticalAlign: o.valign ?? VerticalAlign.TOP,
      shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      columnSpan: o.span,
    });
  };
  const table = (widths, rows) => new D.Table({
    width: { size: Math.round(widths.reduce((a, b) => a + b, 0) * MM), type: WidthType.DXA },
    columnWidths: widths.map((w) => Math.round(w * MM)),
    rows,
  });
  const img = async (photo, maxW, maxH, maxSide = 1000) => {
    const cv = await renderPhoto(photo, maxSide);
    const run = new D.ImageRun({ data: await jpegData(cv), transformation: fit(cv.width, cv.height, maxW * PX, maxH * PX) });
    cv.width = cv.height = 1;
    return run;
  };
  const pageBreak = () => new Paragraph({ children: [new D.PageBreak()] });
  return { T, P, lines, cell, table, img, pageBreak };
}

export async function exportDocx(R, progress = () => {}) {
  progress('載入 Word 元件…');
  const D = await getDocx();
  const { Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, PageOrientation, Header, Footer, PageNumber } = D;
  const k = kit(D);
  const { T, P } = k;
  const landscape = R.type === 'defect';
  const contentW = landscape ? 277 : 190;

  const children = [];
  const plansDocx = async () => {
    for (const plan of R.plans) {
      progress(`平面圖：${plan.name || ''}`);
      if (children.length) children.push(k.pageBreak());
      children.push(P(T(`Location Plan - ${plan.name || ''}`, { size: 22, bold: true }), { after: 100 }));
      const cv = await renderPlanWithPins(plan, R.defects.filter((d) => d.planId === plan.id), 2200);
      const size = fit(cv.width, cv.height, contentW * PX, (landscape ? 150 : 230) * PX);
      children.push(P(new ImageRun({ data: await jpegData(cv, 0.85), transformation: size }), { align: AlignmentType.CENTER }));
      if (R.type === 'defect') children.push(P(['outstanding', 'rectified', 'closed'].map((s) => T(`●  ${STATUS[s].en}      `, { color: STATUS[s].color.slice(1), size: 16 }))));
      cv.width = cv.height = 1;
    }
  };

  if (R.type === 'defect') await defectDocx(R, D, k, children, plansDocx, progress);
  else if (R.type === 'condition') {
    await plansDocx();
    await gridDocx(R, D, k, children, progress, R.opts.perPage === 3 ? 3 : 6, '');
  } else await formDocx(R, D, k, children, plansDocx, progress);

  const headerChildren = [
    P([T(projectLine(R), { bold: true, size: 22 }), ...(R.settings.companyName ? [T(`    ${R.settings.companyName}`, { size: 16, color: '555555' })] : [])], { after: 20 }),
    P(T(reportTitle(R), { size: 18, color: '333333' }), { after: 80 }),
  ];
  if (R.logoImg) {
    const lc = makeCanvas(R.logoImg.width, R.logoImg.height);
    lc.getContext('2d').drawImage(R.logoImg, 0, 0);
    const png = await canvasToBlob(lc, 'image/png');
    headerChildren.unshift(P(new ImageRun({ data: new Uint8Array(await png.arrayBuffer()), transformation: fit(lc.width, lc.height, 45 * PX, 12 * PX) }), { align: AlignmentType.RIGHT, after: 0 }));
  }

  progress('打包 Word 檔…');
  const grey = { size: 14, color: '777777' };
  const doc = new Document({
    creator: R.settings.companyName || 'Site Records App',
    title: reportTitle(R),
    styles: { default: { document: { run: { font: 'Arial', size: 17 } } } },
    sections: [{
      properties: {
        page: {
          size: { orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT, width: 11906, height: 16838 },
          margin: { top: Math.round(10 * MM), bottom: Math.round(10 * MM), left: Math.round(10 * MM), right: Math.round(10 * MM), header: Math.round(6 * MM), footer: Math.round(5 * MM) },
        },
      },
      headers: { default: new Header({ children: headerChildren }) },
      footers: {
        default: new Footer({
          children: [P([
            T(`Generated on ${fmtDate(Date.now())}        Page `, grey),
            new TextRun({ children: [PageNumber.CURRENT], ...grey }),
            T(' of ', grey),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], ...grey }),
          ], { align: AlignmentType.RIGHT })],
        }),
      },
      children,
    }],
  });
  return Packer.toBlob(doc);
}

// ---------- Word: Defect List ----------
async function defectDocx(R, D, k, children, plansDocx, progress) {
  const { TableRow, AlignmentType, VerticalAlign } = D;
  const { T, P, lines, cell, table } = k;
  if (R.opts.summary) {
    children.push(P(T('Summary', { size: 26, bold: true }), { after: 120 }));
    [
      ['Project No.', R.project.code], ['Project', R.project.name], ['Client', R.project.client],
      ['Inspection date(s)', R.project.dates], ['Report scope', SCOPE_LABEL[R.opts.scope]],
      ['Area', R.opts.area || 'All areas'], ['Items in this report', String(R.defects.length)],
    ].filter(([, v]) => v).forEach(([a, v]) => children.push(P([T(`${a}: `, { bold: true }), T(v)])));
    const c = counts(R.scoped);
    const srow = (a, b, bold, fill) => new TableRow({ children: [cell([P(T(a, { bold }))], 60, { fill }), cell([P(T(b, { bold }), { align: AlignmentType.RIGHT })], 25, { fill })] });
    children.push(P(T(''), { after: 80 }));
    children.push(P(T('Status of all recorded items' + (R.opts.area ? ` (${R.opts.area})` : ''), { bold: true, size: 19 })));
    children.push(table([60, 25], [
      srow('Status', 'No. of items', true, 'EEF0F3'), srow('Outstanding', c.outstanding), srow('Rectified', c.rectified),
      srow('Closed', c.closed), srow('Total', R.scoped.length, true),
    ]));
    const areas = areaCounts(R.scoped);
    if (areas.length) {
      const w = [60, 25, 25, 25, 25];
      const arow = (cells, bold, fill) => new TableRow({ children: cells.map((v, i) => cell([P(T(v, { bold }), { align: i ? AlignmentType.RIGHT : undefined })], w[i], { fill })) });
      children.push(P(T(''), { after: 80 }));
      children.push(P(T('Items by area', { bold: true, size: 19 })));
      children.push(table(w, [
        arow(['Area', 'Outstanding', 'Rectified', 'Closed', 'Total'], true, 'EEF0F3'),
        ...areas.map(([a, v]) => arow([a, v.outstanding, v.rectified, v.closed, v.outstanding + v.rectified + v.closed].map(String))),
      ]));
    }
  }
  await plansDocx();
  if (children.length) children.push(k.pageBreak());
  const widths = COLS.map(([, w]) => w);
  const photoParas = async (ids, emptyText, prefix) => {
    const list = (ids || []).map((id) => R.photos[id]).filter(Boolean).slice(0, 2);
    if (!list.length) return [P(T(emptyText, { color: '999999' }), { align: AlignmentType.CENTER })];
    const each = (66 - (list.length - 1) * 2) / list.length;
    const runs = [];
    for (const p of list) { runs.push(await k.img(p, each, 46)); runs.push(T('  ')); }
    const extra = (ids || []).length - list.length;
    return [
      P(runs, { align: AlignmentType.CENTER }),
      P(T(`${prefix}${fmtDate(list[0].takenAt)}${extra > 0 ? `  (+${extra} more)` : ''}`, { size: 14, color: '666666' }), { align: AlignmentType.CENTER }),
    ];
  };
  const rows = [new TableRow({ tableHeader: true, children: COLS.map(([lab, w]) => cell([P(T(lab, { bold: true }))], w, { fill: 'EEF0F3' })) })];
  for (let i = 0; i < R.defects.length; i++) {
    const d = R.defects[i];
    progress(`製作第 ${i + 1}/${R.defects.length} 項`);
    const s = STATUS[d.status] || STATUS.outstanding;
    rows.push(new TableRow({
      cantSplit: true,
      children: [
        cell([P(T(d.no, { bold: true, size: 20 }))], widths[0]),
        cell(lines(d.area), widths[1]),
        cell(lines(d.location), widths[2]),
        cell(await photoParas(d.before, 'No photo', ''), widths[3], { valign: VerticalAlign.CENTER }),
        cell(lines(d.description, { size: 18 }), widths[4]),
        cell(await photoParas(d.after, d.status === 'outstanding' ? 'Pending rectification' : 'No photo', 'Reply: '), widths[5], { valign: VerticalAlign.CENTER }),
        cell([P(T(s.en, { bold: true, color: s.color.slice(1) })), ...statusLines(d).flatMap((l) => lines(l, { size: 15, color: '333333' }))], widths[6]),
      ],
    }));
  }
  if (!R.defects.length) children.push(P(T('No items in this report.', { color: '777777' })));
  else children.push(table(widths, rows));
}

// ---------- Word: photo grid (Condition Survey / HWR photos) ----------
async function gridDocx(R, D, k, children, progress, perPage, title) {
  const { TableRow, AlignmentType, VerticalAlign } = D;
  const { T, P, cell, table } = k;
  const pages = chunkBySection(R, perPage);
  let i = 0;
  for (const pg of pages) {
    if (children.length) children.push(k.pageBreak());
    const head = pg.head || title;
    if (head) children.push(P(T(head, { bold: true, size: 22 }), { align: AlignmentType.CENTER, after: 120 }));
    const rows = [];
    if (perPage === 6) {
      for (let r = 0; r < pg.items.length; r += 2) {
        const cells = [];
        for (const d of [pg.items[r], pg.items[r + 1]]) {
          if (!d) { cells.push(cell([P(T(''))], 95, { noBorder: true })); continue; }
          progress(`相片 ${++i}/${R.defects.length}`);
          const ph = mainPhoto(R, d);
          const [c1, c2] = recCaption(R, d);
          cells.push(cell([
            P(ph ? await k.img(ph, 88, 64) : T('No photo', { color: '999999' }), { align: AlignmentType.CENTER }),
            P(T(c1, { bold: true, size: 18 }), { align: AlignmentType.CENTER, after: 0 }),
            ...(c2 ? [P(T(c2, { size: 15, color: '555555' }), { align: AlignmentType.CENTER })] : []),
          ], 95, { noBorder: true }));
        }
        rows.push(new TableRow({ cantSplit: true, children: cells }));
      }
      children.push(table([95, 95], rows));
    } else {
      for (const d of pg.items) {
        progress(`相片 ${++i}/${R.defects.length}`);
        const ph = mainPhoto(R, d);
        const no = R.type === 'condition' ? `Photo No.${String(d.no).padStart(2, '0')}` : `No. ${d.no}`;
        const text = [R.type === 'condition' ? d.caption : d.ref, d.location ? `Location: ${d.location}` : '', d.remarks].filter(Boolean).join('\n');
        rows.push(new TableRow({
          cantSplit: true,
          children: [
            cell([P(ph ? await k.img(ph, 115, 80) : T('No photo', { color: '999999' }), { align: AlignmentType.CENTER })], 120, { noBorder: true }),
            cell([P(T(no, { bold: true, size: 22 })), ...k.lines(text, { size: 18 })], 70, { noBorder: true, valign: VerticalAlign.CENTER }),
          ],
        }));
      }
      children.push(table([120, 70], rows));
    }
  }
}

// ---------- Word: Hidden Work Record / Spalling Record ----------
async function formDocx(R, D, k, children, plansDocx, progress) {
  const { TableRow, AlignmentType, VerticalAlign } = D;
  const { T, P, cell, table } = k;
  const p = R.project;
  children.push(P(T(TYPES[R.type].title, { bold: true, size: 24 }), { align: AlignmentType.CENTER, after: 160 }));
  const info = (a, b, c, d2) => new TableRow({
    children: [
      cell([P(T(a, { color: '555555' }))], 30, { noBorder: true }), cell([P(T(b, { bold: true }))], 80, { noBorder: true }),
      cell([P(T(c, { color: '555555' }))], 20, { noBorder: true }), cell([P(T(d2, { bold: true }))], 60, { noBorder: true }),
    ],
  });
  children.push(table([30, 80, 20, 60], [
    info('Hospital / Client :', p.client, 'Ref. :', p.refNo),
    info('W.O. No. :', p.woNo, 'Date :', p.signDate || p.dates),
    info('Location :', p.siteLocation, '', ''),
  ]));
  children.push(P([T('Defect Type :  ', { color: '555555', size: 16 }), T(DEFECT_TYPES.map(([a, l]) => `(${a}) ${l}`).join('    '), { size: 16 })], { before: 80 }));
  children.push(P([T('Repair Method :  ', { color: '555555', size: 16 }), T(REPAIR_METHODS.map(([a, l]) => `(${a}) ${l}`).join('   '), { size: 16 })], { after: 120 }));

  const widths = FCOLS.map(([, w]) => w);
  const ctr = AlignmentType.CENTER;
  const rows = [new TableRow({ tableHeader: true, children: FCOLS.map(([lab, w]) => cell([P(T(lab, { bold: true, size: 15 }))], w, { fill: 'EEF0F3' })) })];
  for (const d of R.defects) {
    const c = dimCalc(d);
    const vals = [d.no, d.ref || '', d.location || '', d.defectType || '', d.repairMethod || '', d.length || '', d.width || '', fmtNum(c.area, 3), fmtNum(c.girth, 2), d.thickness || ''];
    rows.push(new TableRow({ cantSplit: true, children: vals.map((v, i) => cell([P(T(v, { size: 16, bold: i === 0 }), { align: i >= 3 ? ctr : undefined, after: 0 })], widths[i])) }));
  }
  const before = widths.slice(0, 7).reduce((a, b) => a + b, 0);
  rows.push(new TableRow({
    children: [
      cell([P(T('Total area', { bold: true }), { align: AlignmentType.RIGHT, after: 0 })], before, { span: 7 }),
      cell([P(T(fmtNum(totalArea(R), 3) || '0', { bold: true }), { align: ctr, after: 0 })], widths[7]),
      cell([P(T(''))], widths[8]), cell([P(T(''))], widths[9]),
    ],
  }));
  children.push(table(widths, rows));

  const sig = (label, name, title) => [
    P([T(`${label}  `, { color: '555555' }), T('______________________________   (Signature)      Date: '), T(p.signDate || '__________')], { before: 360, after: 0 }),
    P(T(`${name || 'name'} (${title})`), { align: AlignmentType.CENTER }),
  ];
  children.push(P([T('Remarks : ', { color: '555555' }), T('_'.repeat(90), { color: '999999' })], { before: 240 }));
  children.push(...sig('Attended and Prepared By :', p.preparedBy, p.preparedTitle || 'TMC - PM / Site Agent'));
  children.push(...sig('Inspected By :', p.inspectedBy, p.inspectedTitle || "TMS's Representative"));
  if (R.type === 'spalling') {
    children.push(P(T('Hereby I confirm that the above all are acceptable.', { color: '555555' }), { before: 240 }));
    children.push(...sig('', p.preparedBy, p.preparedTitle || 'TMC - PM / Site Agent'));
  }

  await plansDocx();

  if (R.type === 'hwr') {
    await gridDocx(R, D, k, children, progress, 6, 'Photo Record');
  } else if (R.opts.photoPages !== false) {
    let i = 0;
    for (const d of R.defects) {
      progress(`Spalling ${++i}/${R.defects.length}`);
      children.push(k.pageBreak());
      children.push(P(T('Inspection Record for Spalled Concrete', { bold: true, size: 24 }), { align: ctr, after: 80 }));
      children.push(P([T(`WO No.: ${p.woNo || ''}`), T(`        Spalling No.: ${d.no}${d.ref ? ` (${d.ref})` : ''}`, { bold: true })], { after: 40 }));
      if (d.location) children.push(P(T(`Location: ${d.location}`, { color: '444444' }), { after: 120 }));
      const slots = TYPES.spalling.slots;
      const rowsS = [];
      for (let r = 0; r < 4; r += 2) {
        const cells = [];
        for (const [key, en] of [slots[r], slots[r + 1]]) {
          const ph = slotPhoto(R, d, key);
          cells.push(cell([
            P(T(en, { bold: true, size: 20 }), { align: ctr }),
            P(ph ? await k.img(ph, 88, 95) : T('No photo', { color: '999999' }), { align: ctr }),
            ...(sizeText(d) ? [P(T(`Size: ${sizeText(d)}`, { size: 18 }), { align: ctr })] : []),
          ], 95, { noBorder: true, valign: VerticalAlign.TOP }));
        }
        rowsS.push(new TableRow({ cantSplit: true, children: cells }));
      }
      children.push(table([95, 95], rowsS));
      if (d.remarks) children.push(P(T(`Remarks: ${d.remarks}`, { color: '444444' })));
    }
  }
}
