// Report generation: PDF (pages drawn on canvas, wrapped in a minimal PDF file,
// so Chinese text works without embedding fonts) and Word (.docx via the docx library).
import * as db from './db.js';
import { renderPhoto, renderPlanWithPins, drawPins } from './annotate.js';
import { STATUS, sortDefects, fmtDate, loadImage, canvasToBlob, makeCanvas } from './util.js';
import { getDocx } from './libs.js';

const FONT = '-apple-system, "Segoe UI", Arial, "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
const SCOPE_LABEL = {
  all: 'All items',
  open: 'Outstanding and rectified items (closed items excluded)',
  outstanding: 'Outstanding items only',
};

// ---------- gather data ----------
export async function collectReport(projectId, opts) {
  const { project, plans, defects } = await db.projectData(projectId);
  const settings = await db.getSettings();
  const inArea = (d) => !opts.area || (d.area || '') === opts.area;
  const scoped = defects.filter(inArea);
  const list = sortDefects(
    scoped.filter((d) => (opts.scope === 'all' ? true : opts.scope === 'open' ? d.status !== 'closed' : d.status === 'outstanding')),
  );
  const ids = new Set(list.flatMap((d) => [...(d.before || []).slice(0, 2), ...(d.after || []).slice(0, 2)]));
  const photos = {};
  for (const id of ids) {
    const p = await db.get('photos', id);
    if (p) photos[id] = p;
  }
  const usedPlans = opts.plans ? plans.filter((p) => list.some((d) => d.planId === p.id)) : [];
  const logoImg = settings.logo ? await loadImage(settings.logo).catch(() => null) : null;
  return { project, settings, logoImg, defects: list, scoped, photos, plans: usedPlans, opts };
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
  const t = R.project.title || 'Outstanding / Defect List';
  return R.project.dates ? `${t} (as per site checking on ${R.project.dates})` : t;
};
const projectLine = (R) => [R.project.code, R.project.name].filter(Boolean).join(' - ');
function statusLines(d) {
  const out = [];
  if (d.status === 'rectified' && d.rectifiedAt) out.push(`Rectified on ${fmtDate(d.rectifiedAt)}`);
  if (d.status === 'closed' && d.closedAt) out.push(`Closed on ${fmtDate(d.closedAt)}`);
  if (d.dueDate && d.status === 'outstanding') out.push(`To be completed before ${fmtDate(d.dueDate)}`);
  if (d.category) out.push(d.category);
  if (d.remarks) out.push(d.remarks);
  return out;
}

// ======================= PDF =======================
const K = 7; // canvas pixels per mm (~178 dpi)
const PW = 297, PH = 210, M = 10;
const TOP = 28, THEAD = 8, ROW = 52, FOOT = 7;
const ROWS_PER_PAGE = Math.floor((PH - M - FOOT - TOP - THEAD) / ROW);
const COLS = [
  ['Item', 12], ['Area', 14], ['Location', 26], ['Before Photo', 70],
  ['Description', 52], ['After Photo (Reply)', 70], ['Status / Remarks', 33],
];

function newPage() {
  const c = makeCanvas(PW * K, PH * K);
  const ctx = c.getContext('2d');
  ctx.scale(K, K);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PW, PH);
  ctx.textBaseline = 'alphabetic';
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
    // tokens: words, spaces, or single CJK characters
    const tokens = para.match(/[⺀-鿿豈-﫿＀-￯]|[^\s⺀-鿿豈-﫿＀-￯]+|\s+/g) || [''];
    for (const tok of tokens) {
      const test = line + tok;
      if (ctx.measureText(test).width <= maxW || !line.trim()) {
        if (ctx.measureText(test).width > maxW && !line.trim()) {
          // single long word: hard break
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

function drawHeader(ctx, R, pageNo, total) {
  let right = PW - M;
  if (R.logoImg) {
    const h = 12, w = Math.min(45, (h * R.logoImg.width) / R.logoImg.height);
    ctx.drawImage(R.logoImg, right - w, M - 1, w, h);
    right -= w + 3;
  }
  if (R.settings.companyName) txt(ctx, R.settings.companyName, right, M + 4, { size: 3, color: '#444', align: 'right', maxW: 70 });
  const nameW = right - M - (R.settings.companyName ? 75 : 0);
  txt(ctx, projectLine(R), M, M + 4, { size: 4, bold: true, maxW: nameW });
  txt(ctx, reportTitle(R), M, M + 10, { size: 3.3, color: '#333', maxW: PW - 2 * M });
  ctx.strokeStyle = '#999';
  ctx.lineWidth = 0.3;
  ctx.beginPath(); ctx.moveTo(M, M + 13.5); ctx.lineTo(PW - M, M + 13.5); ctx.stroke();
  txt(ctx, `Generated on ${fmtDate(Date.now())}`, M, PH - 5, { size: 2.4, color: '#777' });
  txt(ctx, `Page ${pageNo} of ${total}`, PW - M, PH - 5, { size: 2.4, color: '#777', align: 'right' });
}

function drawSummary(ctx, R) {
  txt(ctx, 'Summary', M, TOP + 2, { size: 4.5, bold: true });
  const info = [
    ['Project No.', R.project.code],
    ['Project', R.project.name],
    ['Client', R.project.client],
    ['Inspection date(s)', R.project.dates],
    ['Report scope', SCOPE_LABEL[R.opts.scope]],
    ['Area', R.opts.area || 'All areas'],
    ['Items in this report', String(R.defects.length)],
  ].filter(([, v]) => v);
  let y = TOP + 9;
  for (const [k, v] of info) {
    txt(ctx, k, M, y, { size: 3, color: '#555' });
    const h = para(ctx, v, M + 34, y - 3, 95, 12, { size: 3 });
    y += Math.max(5.2, h + 1.5);
  }

  // status table
  y += 4;
  const c = counts(R.scoped);
  const total = R.scoped.length;
  txt(ctx, 'Status of all recorded items' + (R.opts.area ? ` (${R.opts.area})` : ''), M, y, { size: 3.2, bold: true });
  y += 3;
  const rows = [
    ['Outstanding', c.outstanding, STATUS.outstanding.color],
    ['Rectified', c.rectified, STATUS.rectified.color],
    ['Closed', c.closed, STATUS.closed.color],
    ['Total', total, '#111'],
  ];
  ctx.lineWidth = 0.25; ctx.strokeStyle = '#999';
  for (const [label, n, color] of rows) {
    ctx.strokeRect(M, y, 60, 7); ctx.strokeRect(M + 60, y, 25, 7);
    txt(ctx, label, M + 2, y + 4.8, { size: 3, bold: label === 'Total', color });
    txt(ctx, String(n), M + 83, y + 4.8, { size: 3, bold: true, align: 'right' });
    y += 7;
  }

  // area table
  const ax = 150, colW = [50, 22, 22, 22, 22];
  let ay = TOP + 2;
  txt(ctx, 'Items by area', ax, ay, { size: 3.2, bold: true });
  ay += 3;
  const head = ['Area', 'Outstanding', 'Rectified', 'Closed', 'Total'];
  const drawRowA = (cells, bold, fill) => {
    let x = ax;
    cells.forEach((v, i) => {
      if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, ay, colW[i], 6.5); }
      ctx.strokeRect(x, ay, colW[i], 6.5);
      txt(ctx, v, i ? x + colW[i] - 2 : x + 2, ay + 4.5, { size: 2.8, bold, align: i ? 'right' : 'left', maxW: colW[i] - 3 });
      x += colW[i];
    });
    ay += 6.5;
  };
  drawRowA(head, true, '#eef0f3');
  const areas = areaCounts(R.scoped);
  const maxRows = Math.floor((PH - M - FOOT - ay) / 6.5) - 1;
  areas.slice(0, maxRows).forEach(([a, v]) => drawRowA([a, v.outstanding, v.rectified, v.closed, v.outstanding + v.rectified + v.closed].map(String), false));
  if (areas.length > maxRows) txt(ctx, `+ ${areas.length - maxRows} more areas`, ax, ay + 4, { size: 2.6, color: '#777' });
}

async function drawPlanPage(ctx, R, plan) {
  txt(ctx, `Location Plan - ${plan.name || ''}`, M, TOP + 2, { size: 4, bold: true });
  const img = await loadImage(plan.blob);
  const box = drawContain(ctx, img, M, TOP + 5, PW - 2 * M, PH - TOP - 5 - M - FOOT - 4);
  ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.2;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  drawPins(ctx, R.defects.filter((d) => d.planId === plan.id), box, 2.4);
  // legend
  let lx = M;
  const ly = PH - M - FOOT + 2;
  for (const k of ['outstanding', 'rectified', 'closed']) {
    ctx.fillStyle = STATUS[k].color;
    ctx.beginPath(); ctx.arc(lx + 1.5, ly - 1, 1.5, 0, Math.PI * 2); ctx.fill();
    txt(ctx, STATUS[k].en, lx + 4.5, ly, { size: 2.6, color: '#444' });
    lx += 28;
  }
}

function drawTableHead(ctx) {
  let x = M;
  ctx.lineWidth = 0.25; ctx.strokeStyle = '#888';
  for (const [label, w] of COLS) {
    ctx.fillStyle = '#eef0f3';
    ctx.fillRect(x, TOP, w, THEAD);
    ctx.strokeRect(x, TOP, w, THEAD);
    txt(ctx, label, x + 1.5, TOP + 5.3, { size: 2.9, bold: true, maxW: w - 3 });
    x += w;
  }
}

async function drawPhotoCell(ctx, R, ids, x, y, w, h, cache, emptyText, captionPrefix) {
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

async function drawRow(ctx, R, d, y, cache) {
  let x = M;
  const cell = COLS.map(([, w]) => { const c = { x, w }; x += w; return c; });
  ctx.lineWidth = 0.25; ctx.strokeStyle = '#888';
  cell.forEach((c) => ctx.strokeRect(c.x, y, c.w, ROW));
  const p = 1.5;
  txt(ctx, d.itemNo, cell[0].x + p, y + 5, { size: 3.2, bold: true, maxW: cell[0].w - 2 * p });
  para(ctx, d.area, cell[1].x + p, y + p, cell[1].w - 2 * p, ROW - 3, { size: 2.8 });
  para(ctx, d.location, cell[2].x + p, y + p, cell[2].w - 2 * p, ROW - 3, { size: 2.8 });
  await drawPhotoCell(ctx, R, d.before, cell[3].x, y, cell[3].w, ROW, cache, 'No photo', '');
  para(ctx, d.description, cell[4].x + p, y + p, cell[4].w - 2 * p, ROW - 3, { size: 3 });
  await drawPhotoCell(ctx, R, d.after, cell[5].x, y, cell[5].w, ROW, cache,
    d.status === 'outstanding' ? 'Pending rectification' : 'No photo', 'Reply: ');
  const s = STATUS[d.status] || STATUS.outstanding;
  txt(ctx, s.en, cell[6].x + p, y + 5, { size: 3.1, bold: true, color: s.color });
  para(ctx, statusLines(d).join('\n'), cell[6].x + p, y + 6.5, cell[6].w - 2 * p, ROW - 8, { size: 2.6, color: '#333' });
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

export async function exportPdf(R, progress = () => {}) {
  const rowPages = Math.max(1, Math.ceil(R.defects.length / ROWS_PER_PAGE));
  const total = (R.opts.summary ? 1 : 0) + R.plans.length + rowPages;
  const out = [];
  let pageNo = 0;
  const finish = async (c) => {
    const blob = await canvasToBlob(c, 'image/jpeg', 0.85);
    out.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), pxW: c.width, pxH: c.height, wPt: 841.89, hPt: 595.28 });
    c.width = c.height = 1; // free memory (iOS)
  };
  if (R.opts.summary) {
    const { c, ctx } = newPage();
    drawHeader(ctx, R, ++pageNo, total);
    drawSummary(ctx, R);
    await finish(c);
  }
  for (const plan of R.plans) {
    progress(`平面圖 ${pageNo + 1}/${total}`);
    const { c, ctx } = newPage();
    drawHeader(ctx, R, ++pageNo, total);
    await drawPlanPage(ctx, R, plan);
    await finish(c);
  }
  for (let i = 0; i < rowPages; i++) {
    progress(`製作第 ${pageNo + 1}/${total} 頁`);
    const { c, ctx } = newPage();
    drawHeader(ctx, R, ++pageNo, total);
    drawTableHead(ctx);
    const rows = R.defects.slice(i * ROWS_PER_PAGE, (i + 1) * ROWS_PER_PAGE);
    if (!rows.length) txt(ctx, 'No items in this report.', M + 2, TOP + THEAD + 8, { size: 3.2, color: '#777' });
    const cache = new Map();
    for (let r = 0; r < rows.length; r++) await drawRow(ctx, R, rows[r], TOP + THEAD + r * ROW, cache);
    cache.forEach((cv) => { cv.width = cv.height = 1; });
    await finish(c);
  }
  return buildPdf(out);
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

export async function exportDocx(R, progress = () => {}) {
  progress('載入 Word 元件…');
  const D = await getDocx();
  const {
    Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType,
    PageOrientation, Header, Footer, PageNumber, ShadingType, VerticalAlign, BorderStyle, PageBreak,
  } = D;

  const T = (text, o = {}) => new TextRun({ text: String(text ?? ''), size: o.size ?? 17, bold: o.bold, color: o.color, font: 'Arial' });
  const P = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { after: o.after ?? 40 }, alignment: o.align });
  const lines = (s, o) => String(s ?? '').split('\n').map((l) => P(T(l, o)));
  const border = { style: BorderStyle.SINGLE, size: 4, color: '888888' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (children, wMm, o = {}) => new TableCell({
    children: children.length ? children : [P(T(''))],
    width: { size: Math.round(wMm * MM), type: WidthType.DXA },
    borders,
    verticalAlign: o.valign ?? VerticalAlign.TOP,
    shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });

  const contentW = 277; // mm (A4 landscape minus 10 mm margins)
  const children = [];

  // Summary
  if (R.opts.summary) {
    children.push(P(T('Summary', { size: 26, bold: true }), { after: 120 }));
    const info = [
      ['Project No.', R.project.code], ['Project', R.project.name], ['Client', R.project.client],
      ['Inspection date(s)', R.project.dates], ['Report scope', SCOPE_LABEL[R.opts.scope]],
      ['Area', R.opts.area || 'All areas'], ['Items in this report', String(R.defects.length)],
    ].filter(([, v]) => v);
    info.forEach(([k, v]) => children.push(P([T(`${k}: `, { bold: true }), T(v)])));
    const c = counts(R.scoped);
    const srow = (a, b, bold, fill) => new TableRow({ children: [cell([P(T(a, { bold }))], 60, { fill }), cell([P(T(b, { bold }), { align: AlignmentType.RIGHT })], 25, { fill })] });
    children.push(P(T(''), { after: 80 }));
    children.push(P(T('Status of all recorded items' + (R.opts.area ? ` (${R.opts.area})` : ''), { bold: true, size: 19 })));
    children.push(new Table({
      width: { size: Math.round(85 * MM), type: WidthType.DXA },
      columnWidths: [60 * MM, 25 * MM].map(Math.round),
      rows: [
        srow('Status', 'No. of items', true, 'EEF0F3'),
        srow('Outstanding', c.outstanding), srow('Rectified', c.rectified), srow('Closed', c.closed),
        srow('Total', R.scoped.length, true),
      ],
    }));
    const areas = areaCounts(R.scoped);
    if (areas.length) {
      children.push(P(T(''), { after: 80 }));
      children.push(P(T('Items by area', { bold: true, size: 19 })));
      const w = [60, 25, 25, 25, 25];
      const arow = (cells, bold, fill) => new TableRow({
        children: cells.map((v, i) => cell([P(T(v, { bold }), { align: i ? AlignmentType.RIGHT : undefined })], w[i], { fill })),
      });
      children.push(new Table({
        width: { size: Math.round(160 * MM), type: WidthType.DXA },
        columnWidths: w.map((x) => Math.round(x * MM)),
        rows: [
          arow(['Area', 'Outstanding', 'Rectified', 'Closed', 'Total'], true, 'EEF0F3'),
          ...areas.map(([a, v]) => arow([a, v.outstanding, v.rectified, v.closed, v.outstanding + v.rectified + v.closed].map(String))),
        ],
      }));
    }
  }

  // Plans
  for (const plan of R.plans) {
    progress(`平面圖：${plan.name || ''}`);
    if (children.length) children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(P(T(`Location Plan - ${plan.name || ''}`, { size: 22, bold: true }), { after: 100 }));
    const cv = await renderPlanWithPins(plan, R.defects.filter((d) => d.planId === plan.id), 2200);
    const size = fit(cv.width, cv.height, contentW * PX, 150 * PX);
    children.push(P(new ImageRun({ data: await jpegData(cv, 0.85), transformation: size }), { align: AlignmentType.CENTER }));
    children.push(P(['outstanding', 'rectified', 'closed'].map((k) => T(`●  ${STATUS[k].en}      `, { color: STATUS[k].color.slice(1), size: 16 }))));
    cv.width = cv.height = 1;
  }

  // Defect table
  if (children.length) children.push(new Paragraph({ children: [new PageBreak()] }));
  const widths = COLS.map(([, w]) => w);
  const photoBox = { w: 66, h: 46 };
  const photoParas = async (ids, emptyText, prefix) => {
    const list = (ids || []).map((id) => R.photos[id]).filter(Boolean).slice(0, 2);
    if (!list.length) return [P(T(emptyText, { color: '999999' }), { align: AlignmentType.CENTER })];
    const runs = [];
    const each = (photoBox.w - (list.length - 1) * 2) / list.length;
    for (const p of list) {
      const cv = await renderPhoto(p, 1000);
      runs.push(new ImageRun({ data: await jpegData(cv), transformation: fit(cv.width, cv.height, each * PX, photoBox.h * PX) }));
      runs.push(T('  '));
      cv.width = cv.height = 1;
    }
    const extra = (ids || []).length - list.length;
    return [
      P(runs, { align: AlignmentType.CENTER }),
      P(T(`${prefix}${fmtDate(list[0].takenAt)}${extra > 0 ? `  (+${extra} more)` : ''}`, { size: 14, color: '666666' }), { align: AlignmentType.CENTER }),
    ];
  };

  const rows = [
    new TableRow({
      tableHeader: true,
      children: COLS.map(([label, w]) => cell([P(T(label, { bold: true }))], w, { fill: 'EEF0F3' })),
    }),
  ];
  for (let i = 0; i < R.defects.length; i++) {
    const d = R.defects[i];
    progress(`製作第 ${i + 1}/${R.defects.length} 項`);
    const s = STATUS[d.status] || STATUS.outstanding;
    rows.push(new TableRow({
      cantSplit: true,
      children: [
        cell([P(T(d.itemNo, { bold: true }))], widths[0]),
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
  else children.push(new Table({ width: { size: Math.round(contentW * MM), type: WidthType.DXA }, columnWidths: widths.map((w) => Math.round(w * MM)), rows }));

  const headerChildren = [
    P([T(projectLine(R), { bold: true, size: 22 }), ...(R.settings.companyName ? [T(`    ${R.settings.companyName}`, { size: 16, color: '555555' })] : [])], { after: 20 }),
    P(T(reportTitle(R), { size: 18, color: '333333' }), { after: 80 }),
  ];
  if (R.logoImg) {
    const lc = makeCanvas(R.logoImg.width, R.logoImg.height);
    lc.getContext('2d').drawImage(R.logoImg, 0, 0);
    const pngBlob = await canvasToBlob(lc, 'image/png');
    headerChildren.unshift(P(new ImageRun({ data: new Uint8Array(await pngBlob.arrayBuffer()), transformation: fit(lc.width, lc.height, 45 * PX, 12 * PX) }), { align: AlignmentType.RIGHT, after: 0 }));
  }

  progress('打包 Word 檔…');
  const doc = new Document({
    creator: R.settings.companyName || 'Site Defect App',
    title: reportTitle(R),
    styles: { default: { document: { run: { font: 'Arial', size: 17 } } } },
    sections: [{
      properties: {
        page: {
          size: { orientation: PageOrientation.LANDSCAPE, width: 11906, height: 16838 },
          margin: { top: Math.round(10 * MM), bottom: Math.round(10 * MM), left: Math.round(10 * MM), right: Math.round(10 * MM), header: Math.round(6 * MM), footer: Math.round(5 * MM) },
        },
      },
      headers: { default: new Header({ children: headerChildren }) },
      footers: {
        default: new Footer({
          children: [P([
            T(`Generated on ${fmtDate(Date.now())}        Page `, { size: 14, color: '777777' }),
            new TextRun({ children: [PageNumber.CURRENT], size: 14, color: '777777' }),
            T(' of ', { size: 14, color: '777777' }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14, color: '777777' }),
          ], { align: AlignmentType.RIGHT })],
        }),
      },
      children,
    }],
  });
  return Packer.toBlob(doc);
}
