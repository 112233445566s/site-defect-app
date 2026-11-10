// Floor plans: import (image or PDF), viewer with pins, and a pin picker.
import * as db from './db.js';
import { esc, uid, objURL, compressImage, canvasToBlob, makeCanvas, modal, busy, toast, STATUS, pickFiles } from './util.js';
import { getPdfjs } from './libs.js';

export async function importPlans(projectId) {
  const files = await pickFiles({ accept: 'image/*,application/pdf', multiple: true });
  if (!files.length) return [];
  const b = busy('匯入平面圖…');
  const added = [];
  try {
    for (const f of files) {
      const base = f.name.replace(/\.[^.]+$/, '');
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        const pdfjs = await getPdfjs();
        const doc = await pdfjs.getDocument({ data: await f.arrayBuffer() }).promise;
        const n = Math.min(doc.numPages, 20);
        for (let i = 1; i <= n; i++) {
          b.set(`轉換 PDF 第 ${i}/${n} 頁…`);
          const page = await doc.getPage(i);
          const v1 = page.getViewport({ scale: 1 });
          const scale = 2600 / Math.max(v1.width, v1.height);
          const vp = page.getViewport({ scale });
          const c = makeCanvas(vp.width, vp.height);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const blob = await canvasToBlob(c, 'image/jpeg', 0.88);
          added.push({ id: uid(), projectId, name: n > 1 ? `${base} p${i}` : base, blob, w: c.width, h: c.height, createdAt: Date.now() });
          c.width = c.height = 1;
        }
      } else {
        const { blob, w, h } = await compressImage(f, 2600, 0.88);
        added.push({ id: uid(), projectId, name: base, blob, w, h, createdAt: Date.now() });
      }
    }
    await db.putMany('plans', added);
    toast(`已匯入 ${added.length} 張平面圖`);
  } catch (e) {
    alert('匯入失敗：' + e.message);
  } finally {
    b.close();
  }
  return added;
}

// Builds a zoomable plan element with pins. onTap(x,y) gets normalised coords; onPin(defect).
export function planCanvas(plan, defects, { onTap, onPin, marker } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'plan-scroll';
  wrap.innerHTML = `<div class="plan-inner"><img src="${objURL(plan.blob)}" alt="" draggable="false"></div>`;
  const inner = wrap.firstElementChild;
  let zoom = 1;
  const pins = () => {
    inner.querySelectorAll('.pin').forEach((p) => p.remove());
    for (const d of defects) {
      if (d.planId !== plan.id || d.x == null) continue;
      const el = document.createElement('button');
      el.className = 'pin';
      el.style.left = d.x * 100 + '%';
      el.style.top = d.y * 100 + '%';
      el.style.background = STATUS[d.status]?.color || STATUS.outstanding.color;
      el.textContent = d.no;
      el.addEventListener('click', (e) => { e.stopPropagation(); onPin?.(d); });
      inner.appendChild(el);
    }
    if (marker) {
      const m = document.createElement('div');
      m.className = 'pin marker';
      m.style.left = marker.x * 100 + '%';
      m.style.top = marker.y * 100 + '%';
      m.textContent = '★';
      inner.appendChild(m);
    }
  };
  inner.addEventListener('click', (e) => {
    if (!onTap) return;
    const r = inner.getBoundingClientRect();
    onTap((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });
  const setZoom = (z, keepCenter = true) => {
    const cx = (wrap.scrollLeft + wrap.clientWidth / 2) / inner.offsetWidth;
    const cy = (wrap.scrollTop + wrap.clientHeight / 2) / inner.offsetHeight;
    zoom = Math.min(6, Math.max(1, z));
    inner.style.width = zoom * 100 + '%';
    if (keepCenter) {
      wrap.scrollLeft = cx * inner.offsetWidth - wrap.clientWidth / 2;
      wrap.scrollTop = cy * inner.offsetHeight - wrap.clientHeight / 2;
    }
  };
  // two-finger pinch zoom
  let pinch = null;
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: zoom };
    }
  }, { passive: true });
  wrap.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      setZoom(pinch.z * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d);
    }
  }, { passive: false });
  wrap.addEventListener('touchend', () => { pinch = null; });
  pins();
  return {
    el: wrap,
    zoomIn: () => setZoom(zoom * 1.5),
    zoomOut: () => setZoom(zoom / 1.5),
    refresh: (list, mk) => { defects = list; if (mk !== undefined) marker = mk; pins(); },
  };
}

// Modal to choose a plan and tap a location. Resolves {planId,x,y}, 'remove', or null.
export async function pickPin(projectId, current) {
  const plans = (await db.byProject('plans', projectId)).sort((a, b) => a.createdAt - b.createdAt);
  if (!plans.length) { alert('此項目未有平面圖。請先在「平面圖」分頁匯入。'); return null; }
  const defects = await db.byProject('defects', projectId);
  let plan = plans.find((p) => p.id === current?.planId) || plans[0];
  let marker = current?.planId === plan.id ? { x: current.x, y: current.y } : null;
  return new Promise((resolve) => {
    const m = modal(`
      <div class="pick-head">
        <select class="input" data-plan>${plans.map((p) => `<option value="${p.id}" ${p.id === plan.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <button class="btn sm" data-a="out">−</button><button class="btn sm" data-a="in">＋</button>
      </div>
      <p class="muted small">點擊平面圖設定位置（★）。可用兩指或 ＋／− 放大。</p>
      <div class="pick-body"></div>
      <div class="row gap">
        ${current?.planId ? '<button class="btn danger ghost" data-a="remove">移除位置</button>' : ''}
        <span class="grow"></span>
        <button class="btn" data-a="cancel">取消</button>
        <button class="btn primary" data-a="ok">確定</button>
      </div>`, 'wide');
    let pc;
    const mount = () => {
      pc = planCanvas(plan, defects.filter((d) => d.id !== current?.defectId), {
        marker,
        onTap: (x, y) => { marker = { x, y }; pc.refresh(defects.filter((d) => d.id !== current?.defectId), marker); },
      });
      const body = m.el.querySelector('.pick-body');
      body.innerHTML = '';
      body.appendChild(pc.el);
    };
    mount();
    m.el.querySelector('[data-plan]').addEventListener('change', (e) => {
      plan = plans.find((p) => p.id === e.target.value);
      marker = current?.planId === plan.id ? { x: current.x, y: current.y } : null;
      mount();
    });
    m.el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'in') pc.zoomIn();
      else if (a === 'out') pc.zoomOut();
      else if (a === 'cancel') { m.close(); resolve(null); }
      else if (a === 'remove') { m.close(); resolve('remove'); }
      else if (a === 'ok') {
        if (!marker) { toast('請先點擊平面圖'); return; }
        m.close(); resolve({ planId: plan.id, x: marker.x, y: marker.y });
      }
    });
  });
}

export async function viewPlan(app, projectId, planId, shell) {
  const plan = await db.get('plans', planId);
  if (!plan) { location.hash = `#/p/${projectId}/plans`; return; }
  const defects = await db.byProject('defects', projectId);
  let addMode = false;
  app.innerHTML = shell({
    title: plan.name,
    back: `#/p/${projectId}/plans`,
    actions: '<button class="btn ghost light sm" data-a="menu">⋯</button>',
    body: `
      <div class="plan-tools">
        <button class="btn sm" data-a="out">−</button>
        <button class="btn sm" data-a="in">＋</button>
        <span class="grow"></span>
        <button class="btn sm" data-a="add">＋ 在圖上新增記錄</button>
      </div>
      <div class="plan-hint muted small" hidden>點擊平面圖上的位置以新增記錄</div>
      <div class="plan-host"></div>
      ${defects.some((d) => d.status) ? `<div class="legend">${Object.values(STATUS).map((s) => `<span><i style="background:${s.color}"></i>${s.zh}</span>`).join('')}</div>` : ''}`,
  });
  const pc = planCanvas(plan, defects, {
    onPin: (d) => { location.hash = `#/p/${projectId}/d/${d.id}`; },
    onTap: (x, y) => {
      if (!addMode) return;
      location.hash = `#/p/${projectId}/d/new?plan=${plan.id}&x=${x.toFixed(4)}&y=${y.toFixed(4)}`;
    },
  });
  app.querySelector('.plan-host').appendChild(pc.el);
  app.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'in') pc.zoomIn();
    else if (a === 'out') pc.zoomOut();
    else if (a === 'add') {
      addMode = !addMode;
      e.target.closest('button').classList.toggle('primary', addMode);
      app.querySelector('.plan-hint').hidden = !addMode;
    } else if (a === 'menu') {
      const m = modal(`<h3>${esc(plan.name)}</h3><div class="stack">
        <button class="btn" data-m="rename">重新命名</button>
        <button class="btn danger" data-m="delete">刪除平面圖</button>
        <button class="btn ghost" data-m="close">取消</button></div>`);
      m.el.addEventListener('click', async (ev) => {
        const k = ev.target.closest('[data-m]')?.dataset.m;
        if (k === 'rename') {
          const n = prompt('平面圖名稱', plan.name);
          if (n && n.trim()) { plan.name = n.trim(); await db.put('plans', plan); m.close(); app.querySelector('.topbar h1').textContent = plan.name; }
        } else if (k === 'delete') {
          const used = defects.filter((d) => d.planId === plan.id);
          if (!confirm(`刪除平面圖「${plan.name}」？${used.length ? `\n${used.length} 個 defect 的位置會被移除（defect 本身會保留）。` : ''}`)) return;
          for (const d of used) { d.planId = null; d.x = d.y = null; }
          await db.putMany('defects', used);
          await db.del('plans', plan.id);
          m.close();
          location.hash = `#/p/${projectId}/plans`;
        } else if (k === 'close') m.close();
      });
    }
  });
}
