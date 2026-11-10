// Defect form: photos (before / after) with annotation, location pin, description, status.
import * as db from './db.js';
import { esc, uid, objURL, compressImage, busy, toast, modal, pickFiles, nextItemNo, STATUS, fmtDate } from './util.js';
import { openAnnotator, makeThumb, renderPhoto, photoViewer } from './annotate.js';
import { pickPin } from './plan.js';

// Files captured from the list screen's quick-capture button, handed to the new form.
export const pending = { files: null };

function lastUsed(projectId) {
  try { return JSON.parse(localStorage.getItem('last.' + projectId)) || {}; } catch { return {}; }
}
function rememberLast(projectId, d) {
  try { localStorage.setItem('last.' + projectId, JSON.stringify({ area: d.area, location: d.location, category: d.category, dueDate: d.dueDate })); } catch { /* ignore */ }
}

export async function viewDefect(view, projectId, defectId, q, { shell, go }) {
  const { project, plans, defects } = await db.projectData(projectId);
  if (!project) { go('#/'); return; }
  const settings = await db.getSettings();
  const isNew = defectId === 'new';
  let saved = !isNew;
  let d;
  if (isNew) {
    const last = lastUsed(projectId);
    d = {
      id: uid(), projectId, itemNo: nextItemNo(defects), area: last.area || '', location: last.location || '',
      planId: q.plan || null, x: q.x != null ? +q.x : null, y: q.y != null ? +q.y : null,
      description: '', category: last.category || '', dueDate: last.dueDate || '', status: 'outstanding',
      before: [], after: [], remarks: '', createdAt: Date.now(), updatedAt: Date.now(),
    };
  } else {
    d = defects.find((x) => x.id === defectId);
    if (!d) { go(`#/p/${projectId}`); return; }
  }
  const photos = {};
  for (const id of [...d.before, ...d.after]) { const p = await db.get('photos', id); if (p) photos[id] = p; }
  d.before = d.before.filter((id) => photos[id]);
  d.after = d.after.filter((id) => photos[id]);

  const others = defects.filter((x) => x.id !== d.id);
  const areas = [...new Set(others.map((x) => x.area).filter(Boolean))];
  const locs = [...new Set(others.map((x) => x.location).filter(Boolean))];

  view.innerHTML = shell({
    title: isNew ? '新增 Defect' : `Defect #${d.itemNo}`,
    back: `#/p/${projectId}`,
    body: `
    <form class="form defect-form" autocomplete="off" onsubmit="return false">
      <div class="grid3">
        <label>Item No.<input class="input" name="itemNo" value="${esc(d.itemNo)}" inputmode="text"></label>
        <label>Area<input class="input" name="area" list="dl-area" value="${esc(d.area)}"></label>
        <label>Location<input class="input" name="location" list="dl-loc" value="${esc(d.location)}" placeholder="例如 Pantry"></label>
      </div>
      <datalist id="dl-area">${areas.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
      <datalist id="dl-loc">${locs.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>

      <section class="card">
        <div class="card-head"><h3>修復前相片 Before</h3></div>
        <div class="photos" data-kind="before"></div>
        <div class="row gap">
          <button type="button" class="btn primary grow" data-cam="before">📷 影相</button>
          <button type="button" class="btn grow" data-gal="before">🖼 相簿</button>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h3>位置 Pin</h3></div>
        <div class="pin-info"></div>
      </section>

      <section class="card">
        <div class="card-head"><h3>Description</h3></div>
        <textarea class="input" name="description" rows="3" placeholder="輸入或點選下面的常用描述">${esc(d.description)}</textarea>
        <input class="input phrase-filter" placeholder="🔍 搜尋常用描述">
        <div class="chips phrases"></div>
      </section>

      <section class="card">
        <div class="grid2">
          <label>分類<select class="input" name="category"><option value="">—</option>${settings.categories
            .map((c) => `<option ${c === d.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}${d.category && !settings.categories.includes(d.category) ? `<option selected>${esc(d.category)}</option>` : ''}</select></label>
          <label>完成期限<input class="input" type="date" name="dueDate" value="${esc(d.dueDate)}"></label>
        </div>
        <label>狀態</label>
        <div class="seg" data-status>
          ${Object.entries(STATUS).map(([k, s]) => `<button type="button" data-st="${k}" style="--c:${s.color}">${s.zh}</button>`).join('')}
        </div>
        <p class="muted small status-note"></p>
      </section>

      <section class="card">
        <div class="card-head"><h3>修復後相片 After / Reply</h3></div>
        <div class="photos" data-kind="after"></div>
        <div class="row gap">
          <button type="button" class="btn grow" data-cam="after">📷 影修復後</button>
          <button type="button" class="btn grow" data-gal="after">🖼 相簿</button>
        </div>
      </section>

      <section class="card">
        <label>Remarks<textarea class="input" name="remarks" rows="2">${esc(d.remarks)}</textarea></label>
      </section>

      ${!isNew ? '<button type="button" class="btn danger ghost block" data-a="delete">刪除此 Defect</button>' : ''}
      <div class="spacer"></div>
    </form>
    <div class="bottombar">
      <button type="button" class="btn grow" data-a="done">完成</button>
      <button type="button" class="btn primary grow" data-a="next">完成並新增下一項 ›</button>
    </div>`,
  });

  const form = view.querySelector('form');

  // ---------- persistence ----------
  let timer = null;
  async function persist(force = false) {
    clearTimeout(timer);
    const hasContent = d.before.length || d.after.length || d.description.trim() || d.planId;
    if (!saved && !force && !hasContent) return;
    d.updatedAt = Date.now();
    await db.put('defects', d);
    rememberLast(projectId, d);
    if (!saved) {
      saved = true;
      history.replaceState(null, '', `#/p/${projectId}/d/${d.id}`);
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(persist, 500); };

  form.addEventListener('input', (e) => {
    const n = e.target.name;
    if (n && n in d) { d[n] = e.target.value; schedule(); }
    if (e.target.classList.contains('phrase-filter')) renderPhrases(e.target.value);
  });
  form.addEventListener('change', (e) => {
    const n = e.target.name;
    if (n && n in d) { d[n] = e.target.value; schedule(); }
  });

  // ---------- status ----------
  function setStatus(st) {
    if (d.status === st) return;
    d.status = st;
    if (st === 'rectified' && !d.rectifiedAt) d.rectifiedAt = Date.now();
    if (st === 'closed') d.closedAt = Date.now();
    if (st === 'outstanding') { d.rectifiedAt = null; d.closedAt = null; }
    renderStatus();
    schedule();
  }
  function renderStatus() {
    view.querySelectorAll('[data-st]').forEach((b) => b.classList.toggle('on', b.dataset.st === d.status));
    const note = view.querySelector('.status-note');
    note.textContent = d.status === 'rectified' && d.rectifiedAt ? `修復日期：${fmtDate(d.rectifiedAt)}`
      : d.status === 'closed' && d.closedAt ? `關閉日期：${fmtDate(d.closedAt)}` : '';
  }
  view.querySelector('[data-status]').addEventListener('click', (e) => {
    const st = e.target.closest('[data-st]')?.dataset.st;
    if (st) setStatus(st);
  });

  // ---------- phrases ----------
  function renderPhrases(filter = '') {
    const f = filter.trim().toLowerCase();
    const list = settings.phrases.filter((p) => !f || p.toLowerCase().includes(f));
    view.querySelector('.phrases').innerHTML = list.map((p) => `<button type="button" class="chip" data-phrase="${esc(p)}">${esc(p)}</button>`).join('')
      || '<span class="muted small">沒有符合的描述</span>';
  }
  view.querySelector('.phrases').addEventListener('click', (e) => {
    const p = e.target.closest('[data-phrase]')?.dataset.phrase;
    if (!p) return;
    const ta = form.elements.description;
    d.description = d.description.trim() ? `${d.description.trim()}\n${p}` : p;
    ta.value = d.description;
    schedule();
  });

  // ---------- pin ----------
  function renderPin() {
    const el = view.querySelector('.pin-info');
    const plan = plans.find((p) => p.id === d.planId);
    if (!plans.length) {
      el.innerHTML = `<p class="muted small">此項目未有平面圖。可在項目的「平面圖」分頁匯入。</p>`;
    } else if (plan) {
      el.innerHTML = `<div class="row gap"><span class="grow">📍 已標示於「${esc(plan.name)}」</span><button type="button" class="btn sm" data-a="pin">更改</button></div>`;
    } else {
      el.innerHTML = `<button type="button" class="btn block" data-a="pin">📍 在平面圖上標示位置</button>`;
    }
  }

  // ---------- photos ----------
  function renderPhotos(kind) {
    const el = view.querySelector(`.photos[data-kind="${kind}"]`);
    el.innerHTML = d[kind].map((id) => `
      <button type="button" class="thumb" data-photo="${id}">
        <img src="${objURL(photos[id].thumb || photos[id].blob)}" alt="">
        ${photos[id].annotations?.length ? '<span class="badge">✎</span>' : ''}
      </button>`).join('') || `<p class="muted small empty">${kind === 'before' ? '未有相片' : d.status === 'outstanding' ? '修復後在此加相，狀態會自動改為「已修復」' : '未有相片'}</p>`;
  }

  async function annotate(p) {
    const shapes = await openAnnotator(p);
    if (shapes === null) return;
    p.annotations = shapes;
    p.thumb = await makeThumb(p);
    await db.put('photos', p);
    renderPhotos(p.kind);
  }

  async function addPhotos(kind, files, autoAnnotate) {
    if (!files.length) return;
    await persist(true);
    const b = busy('處理相片…');
    const added = [];
    try {
      for (const f of files) {
        const { blob, w, h } = await compressImage(f, 1600, 0.82);
        const p = { id: uid(), projectId, defectId: d.id, kind, blob, w, h, annotations: [], takenAt: f.lastModified || Date.now(), createdAt: Date.now() };
        p.thumb = await makeThumb(p);
        await db.put('photos', p);
        photos[p.id] = p;
        d[kind].push(p.id);
        added.push(p);
      }
    } catch (e) {
      alert('相片處理失敗：' + e.message);
    } finally {
      b.close();
    }
    if (kind === 'after' && added.length && d.status === 'outstanding') {
      setStatus('rectified');
      toast('已自動標記為「已修復」');
    }
    await persist(true);
    renderPhotos(kind);
    if (autoAnnotate && added.length === 1) await annotate(added[0]);
  }

  view.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.cam) addPhotos(t.dataset.cam, await pickFiles({ capture: true }), true);
    else if (t.dataset.gal) addPhotos(t.dataset.gal, await pickFiles({ multiple: true }), false);
    else if (t.dataset.photo) {
      const p = photos[t.dataset.photo];
      const m = modal(`<h3>相片</h3><img class="modal-img" src="${objURL(p.thumb || p.blob)}" alt="">
        <p class="muted small">拍攝日期：${fmtDate(p.takenAt)}</p>
        <div class="stack">
          <button class="btn primary" data-m="annot">✎ 加箭頭 / 圈圈</button>
          <button class="btn" data-m="view">檢視大圖</button>
          <button class="btn danger ghost" data-m="del">刪除相片</button>
          <button class="btn ghost" data-m="close">關閉</button>
        </div>`);
      m.el.addEventListener('click', async (ev) => {
        const k = ev.target.closest('[data-m]')?.dataset.m;
        if (k === 'annot') { m.close(); annotate(p); }
        else if (k === 'view') {
          const c = await renderPhoto(p, 2000);
          c.toBlob((b) => photoViewer(objURL(b), `Defect #${d.itemNo}`), 'image/jpeg', 0.9);
        } else if (k === 'del') {
          if (!confirm('刪除這張相片？')) return;
          d[p.kind] = d[p.kind].filter((id) => id !== p.id);
          delete photos[p.id];
          await db.del('photos', p.id);
          await persist(true);
          renderPhotos(p.kind);
          m.close();
        } else if (k === 'close') m.close();
      });
    } else if (t.dataset.a === 'pin') {
      const r = await pickPin(projectId, { planId: d.planId, x: d.x, y: d.y, defectId: d.id });
      if (r === 'remove') { d.planId = null; d.x = d.y = null; }
      else if (r) Object.assign(d, r);
      else return;
      renderPin();
      persist(true);
    } else if (t.dataset.a === 'delete') {
      if (!confirm(`刪除 Defect #${d.itemNo}？相片會一併刪除，無法復原。`)) return;
      await db.deleteDefect(d);
      go(`#/p/${projectId}`);
    } else if (t.dataset.a === 'done') {
      await persist();
      go(`#/p/${projectId}`);
    } else if (t.dataset.a === 'next') {
      await persist();
      go(`#/p/${projectId}/d/new`);
    }
  });

  renderPhotos('before');
  renderPhotos('after');
  renderPin();
  renderPhrases();
  renderStatus();

  if (pending.files) {
    const files = pending.files;
    pending.files = null;
    await addPhotos('before', files, files.length === 1);
  }
}
