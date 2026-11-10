// Record form for Spalling Record, Hidden Work Record and Condition Survey.
import * as db from './db.js';
import { esc, uid, objURL, compressImage, busy, modal, pickFiles, fmtDate } from './util.js';
import { openAnnotator, makeThumb, renderPhoto, photoViewer } from './annotate.js';
import { pickPin } from './plan.js';
import { pending } from './defect.js';
import { TYPES, DEFECT_TYPES, REPAIR_METHODS, nextNo, incrementRef, dimCalc, fmtNum, byNo } from './types.js';

function lastUsed(projectId) {
  try { return JSON.parse(localStorage.getItem('lastrec.' + projectId)) || {}; } catch { return {}; }
}
function rememberLast(projectId, r) {
  try {
    localStorage.setItem('lastrec.' + projectId, JSON.stringify({
      location: r.location, section: r.section, thickness: r.thickness, defectType: r.defectType, repairMethod: r.repairMethod,
    }));
  } catch { /* ignore */ }
}

export async function viewRecord(view, project, recordId, q, { shell, go }) {
  const projectId = project.id;
  const T = TYPES[project.type];
  const { plans, defects: records } = await db.projectData(projectId);
  const settings = await db.getSettings();
  const isNew = recordId === 'new';
  let saved = !isNew;
  let r;
  if (isNew) {
    const last = lastUsed(projectId);
    const prev = [...records].sort(byNo).pop();
    r = {
      id: uid(), projectId, type: project.type, no: nextNo(records), ref: incrementRef(prev?.ref),
      location: last.location || '', section: last.section || '',
      planId: q.plan || null, x: q.x != null ? +q.x : null, y: q.y != null ? +q.y : null,
      photos: {}, caption: '', length: '', width: '', thickness: last.thickness || (T.dims ? '50' : ''),
      defectType: last.defectType || T.defaultType || '', repairMethod: last.repairMethod || 'C',
      remarks: '', createdAt: Date.now(), updatedAt: Date.now(),
    };
  } else {
    r = records.find((x) => x.id === recordId);
    if (!r) { go(`#/p/${projectId}`); return; }
    r.photos ||= {};
  }
  const photos = {};
  for (const [slot, id] of Object.entries(r.photos)) {
    const p = id && (await db.get('photos', id));
    if (p) photos[slot] = p; else delete r.photos[slot];
  }
  const others = records.filter((x) => x.id !== r.id);
  const locs = [...new Set(others.map((x) => x.location).filter(Boolean))];
  const sections = [...new Set(others.map((x) => x.section).filter(Boolean))];
  const single = T.slots.length === 1;
  const noun = project.type === 'spalling' ? 'Spalling' : project.type === 'hwr' ? 'Defect' : 'Photo';

  view.innerHTML = shell({
    title: `${isNew ? '新增 ' : ''}${noun} No. ${r.no}`,
    back: `#/p/${projectId}`,
    body: `
    <form class="form" autocomplete="off" onsubmit="return false">
      <div class="grid3">
        <label>Pin No.<input class="input" name="no" type="number" min="1" value="${r.no}" inputmode="numeric"></label>
        <label>Ref.（可選）<input class="input" name="ref" value="${esc(r.ref || '')}" placeholder="${project.type === 'hwr' ? '例如 F2-STR-LGF-01' : ''}"></label>
        <label>Location<input class="input" name="location" list="dl-loc" value="${esc(r.location)}"></label>
      </div>
      <datalist id="dl-loc">${locs.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
      ${project.type === 'condition' ? `
        <label>分段標題（可選，例如 Site take over）<input class="input" name="section" list="dl-sec" value="${esc(r.section || '')}"></label>
        <datalist id="dl-sec">${sections.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>` : ''}

      <section class="card">
        <div class="card-head"><h3>${single ? '相片' : '相片（4 個階段）'}</h3></div>
        <div class="slots ${single ? 'single' : ''}"></div>
      </section>

      ${T.dims ? `
      <section class="card">
        <h3>尺寸</h3>
        <div class="grid3 dims">
          <label>Length (mm)<input class="input" name="length" type="number" inputmode="decimal" value="${esc(r.length)}"></label>
          <label>Width (mm)<input class="input" name="width" type="number" inputmode="decimal" value="${esc(r.width)}"></label>
          <label>Thickness (mm)<input class="input" name="thickness" type="number" inputmode="decimal" value="${esc(r.thickness)}"></label>
        </div>
        <div class="calc"></div>
        <div class="grid2">
          <label>Defect Type<select class="input" name="defectType">${DEFECT_TYPES.map(([k, l]) => `<option value="${k}" ${r.defectType === k ? 'selected' : ''}>(${k}) ${l}</option>`).join('')}</select></label>
          <label>Repair Method<select class="input" name="repairMethod">${REPAIR_METHODS.map(([k, l]) => `<option value="${k}" ${r.repairMethod === k ? 'selected' : ''}>(${k}) ${l}</option>`).join('')}</select></label>
        </div>
      </section>` : ''}

      <section class="card">
        <div class="card-head"><h3>位置 Pin</h3></div>
        <div class="pin-info"></div>
      </section>

      ${project.type === 'condition' ? `
      <section class="card">
        <h3>描述</h3>
        <textarea class="input" name="caption" rows="2" placeholder="例如 General view">${esc(r.caption)}</textarea>
        <input class="input phrase-filter" placeholder="🔍 搜尋常用描述">
        <div class="chips phrases"></div>
      </section>` : ''}

      <section class="card">
        <label>Remarks<textarea class="input" name="remarks" rows="2">${esc(r.remarks)}</textarea></label>
      </section>

      ${!isNew ? `<button type="button" class="btn danger ghost block" data-a="delete">刪除此記錄</button>` : ''}
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
    const hasContent = Object.keys(r.photos).length || r.caption?.trim() || r.length || r.width || r.planId;
    if (!saved && !force && !hasContent) return;
    r.updatedAt = Date.now();
    await db.put('defects', r);
    rememberLast(projectId, r);
    if (!saved) {
      saved = true;
      history.replaceState(null, '', `#/p/${projectId}/d/${r.id}`);
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(persist, 500); };

  const setField = (n, v) => {
    if (n === 'no') { r.no = Math.max(1, parseInt(v, 10) || r.no); view.querySelector('.topbar h1').textContent = `${noun} No. ${r.no}`; }
    else r[n] = v;
    if (['length', 'width'].includes(n)) { renderCalc(); renderSlots(); }
    schedule();
  };
  form.addEventListener('input', (e) => {
    const n = e.target.name;
    if (n && n in r) setField(n, e.target.value);
    if (e.target.classList.contains('phrase-filter')) renderPhrases(e.target.value);
  });
  form.addEventListener('change', (e) => {
    const n = e.target.name;
    if (n === 'no') e.target.value = r.no;
    else if (n && n in r) setField(n, e.target.value);
  });

  function renderCalc() {
    const el = view.querySelector('.calc');
    if (!el) return;
    const c = dimCalc(r);
    el.innerHTML = `<div class="calc-row"><span>Area <b>${fmtNum(c.area, 3) || '–'}</b> m²</span><span>Girth <b>${fmtNum(c.girth, 2) || '–'}</b> m</span></div>`;
  }

  // ---------- phrases (condition survey) ----------
  function renderPhrases(filter = '') {
    const el = view.querySelector('.phrases');
    if (!el) return;
    const f = filter.trim().toLowerCase();
    const list = (settings.conditionPhrases || []).filter((p) => !f || p.toLowerCase().includes(f));
    el.innerHTML = list.map((p) => `<button type="button" class="chip" data-phrase="${esc(p)}">${esc(p)}</button>`).join('')
      || '<span class="muted small">沒有符合的描述</span>';
  }
  view.querySelector('.phrases')?.addEventListener('click', (e) => {
    const p = e.target.closest('[data-phrase]')?.dataset.phrase;
    if (!p) return;
    r.caption = r.caption?.trim() ? `${r.caption.trim()}; ${p}` : p;
    form.elements.caption.value = r.caption;
    schedule();
  });

  // ---------- pin ----------
  function renderPin() {
    const el = view.querySelector('.pin-info');
    const plan = plans.find((p) => p.id === r.planId);
    if (!plans.length) el.innerHTML = `<p class="muted small">此項目未有平面圖。可在項目的「平面圖」分頁匯入。</p>`;
    else if (plan) el.innerHTML = `<div class="row gap"><span class="grow">📍 已標示於「${esc(plan.name)}」（pin ${r.no}）</span><button type="button" class="btn sm" data-a="pin">更改</button></div>`;
    else el.innerHTML = `<button type="button" class="btn block" data-a="pin">📍 在平面圖上標示位置</button>`;
  }

  // ---------- photo slots ----------
  function renderSlots() {
    const size = r.length && r.width ? `Size: ${r.length}x${r.width}` : '';
    view.querySelector('.slots').innerHTML = T.slots.map(([key, en, zh]) => {
      const p = photos[key];
      return `<div class="slot">
        ${single ? '' : `<div class="slot-label"><b>${en}</b> <span class="muted">${zh}</span></div>`}
        ${p ? `<button type="button" class="thumb" data-photo="${key}"><img src="${objURL(p.thumb || p.blob)}" alt="">
            ${p.annotations?.length ? '<span class="badge">✎</span>' : ''}</button>`
          : `<div class="slot-empty"><button type="button" class="btn primary sm" data-cam="${key}">📷 影相</button>
             <button type="button" class="btn sm" data-gal="${key}">🖼 相簿</button></div>`}
        ${!single && size ? `<div class="muted small">${size}</div>` : ''}
      </div>`;
    }).join('');
  }

  async function annotate(p) {
    const shapes = await openAnnotator(p);
    if (shapes === null) return;
    p.annotations = shapes;
    p.thumb = await makeThumb(p);
    await db.put('photos', p);
    renderSlots();
  }

  async function setPhoto(slot, file, autoAnnotate) {
    if (!file) return;
    await persist(true);
    const b = busy('處理相片…');
    let p;
    try {
      const { blob, w, h } = await compressImage(file, 1600, 0.82);
      p = { id: uid(), projectId, defectId: r.id, kind: slot, blob, w, h, annotations: [], takenAt: file.lastModified || Date.now(), createdAt: Date.now() };
      p.thumb = await makeThumb(p);
      await db.put('photos', p);
      if (photos[slot]) await db.del('photos', photos[slot].id);
      photos[slot] = p;
      r.photos[slot] = p.id;
      await persist(true);
    } catch (e) {
      alert('相片處理失敗：' + e.message);
    } finally {
      b.close();
    }
    renderSlots();
    if (p && autoAnnotate) await annotate(p);
  }

  view.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.cam) setPhoto(t.dataset.cam, (await pickFiles({ capture: true }))[0], true);
    else if (t.dataset.gal) setPhoto(t.dataset.gal, (await pickFiles())[0], false);
    else if (t.dataset.photo) {
      const slot = t.dataset.photo;
      const p = photos[slot];
      const m = modal(`<h3>${esc(T.slots.find((s) => s[0] === slot)[1])}</h3><img class="modal-img" src="${objURL(p.thumb || p.blob)}" alt="">
        <p class="muted small">拍攝日期：${fmtDate(p.takenAt)}</p>
        <div class="stack">
          <button class="btn primary" data-m="annot">✎ 加箭頭 / 圈圈</button>
          <button class="btn" data-m="retake">📷 重新影相</button>
          <button class="btn" data-m="view">檢視大圖</button>
          <button class="btn danger ghost" data-m="del">刪除相片</button>
          <button class="btn ghost" data-m="close">關閉</button>
        </div>`);
      m.el.addEventListener('click', async (ev) => {
        const k = ev.target.closest('[data-m]')?.dataset.m;
        if (k === 'annot') { m.close(); annotate(p); }
        else if (k === 'retake') { m.close(); setPhoto(slot, (await pickFiles({ capture: true }))[0], true); }
        else if (k === 'view') {
          const c = await renderPhoto(p, 2000);
          c.toBlob((b) => photoViewer(objURL(b), `${noun} No. ${r.no}`), 'image/jpeg', 0.9);
        } else if (k === 'del') {
          if (!confirm('刪除這張相片？')) return;
          delete r.photos[slot];
          delete photos[slot];
          await db.del('photos', p.id);
          await persist(true);
          renderSlots();
          m.close();
        } else if (k === 'close') m.close();
      });
    } else if (t.dataset.a === 'pin') {
      const res = await pickPin(projectId, { planId: r.planId, x: r.x, y: r.y, defectId: r.id });
      if (res === 'remove') { r.planId = null; r.x = r.y = null; }
      else if (res) Object.assign(r, res);
      else return;
      renderPin();
      persist(true);
    } else if (t.dataset.a === 'delete') {
      if (!confirm(`刪除 ${noun} No. ${r.no}？相片會一併刪除，無法復原。`)) return;
      await db.deleteDefect(r);
      go(`#/p/${projectId}`);
    } else if (t.dataset.a === 'done') {
      await persist();
      go(`#/p/${projectId}`);
    } else if (t.dataset.a === 'next') {
      await persist();
      go(`#/p/${projectId}/d/new`);
    }
  });

  renderSlots();
  renderPin();
  renderCalc();
  renderPhrases();

  if (pending.files) {
    const [f] = pending.files;
    pending.files = null;
    const slot = T.slots.find(([k]) => !photos[k])?.[0] || T.slots[0][0];
    await setPhoto(slot, f, true);
  }
}
