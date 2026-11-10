import * as db from './db.js';
import {
  $, esc, uid, objURL, revokeAll, toast, busy, pickFiles, parseQuery, sortDefects, STATUS, fmtDate,
  compressImage, deliverFile, safeName, stamp,
} from './util.js';
import { viewDefect, pending } from './defect.js';
import { viewRecord } from './record.js';
import { viewPlan, importPlans } from './plan.js';
import { makeThumb } from './annotate.js';
import { collectReport, exportPdf, exportDocx } from './export.js';
import { exportProjectBackup, importBackup } from './backup.js';
import { warmLibs } from './libs.js';
import { TYPES, typeOf, dimCalc, fmtNum, sizeText } from './types.js';

export const APP_VERSION = '0.2.1';

// ---------- layout ----------
function shell({ title, back, actions = '', body, tabs = '' }) {
  return `
    <header class="topbar">
      ${back ? `<a class="back" href="${back}" aria-label="返回">‹</a>` : '<span class="logo-dot"></span>'}
      <h1>${esc(title)}</h1>
      <div class="top-actions">${actions}</div>
    </header>
    ${tabs}
    <main class="content">${body}</main>`;
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

const typePill = (t) => `<span class="pill" style="--c:${TYPES[t].color}">${TYPES[t].short}</span>`;

// ---------- project list ----------
async function viewProjects(view) {
  const projects = (await db.all('projects')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const allRecords = await db.all('defects');
  const stats = (p) => {
    const list = allRecords.filter((d) => d.projectId === p.id);
    return { total: list.length, out: list.filter((d) => d.status === 'outstanding').length };
  };
  view.innerHTML = shell({
    title: 'Site Records',
    actions: '<a class="btn ghost light sm" href="#/settings" aria-label="設定">⚙ 設定</a>',
    body: `
      <div class="row gap">
        <a class="btn primary grow" href="#/new">＋ 新項目</a>
        <button class="btn" data-a="import">匯入備份</button>
      </div>
      <div class="list">
        ${projects.map((p) => {
          const s = stats(p);
          const t = typeOf(p);
          return `<a class="item" href="#/p/${p.id}">
            <div class="item-main">
              <div class="item-title">${esc(p.code ? p.code + ' · ' : '')}${esc(p.name || '未命名項目')}</div>
              <div class="row gap small">${typePill(t)}<span class="muted">${esc(p.dates || '')}</span></div>
            </div>
            <div class="item-side">
              ${t === 'defect' ? `<span class="pill" style="--c:${STATUS.outstanding.color}">${s.out} 未完成</span>` : ''}
              <span class="muted small">共 ${s.total} 項</span>
            </div></a>`;
        }).join('') || `<div class="empty-state"><p>未有項目</p><p class="muted small">按「＋ 新項目」開始。資料只會儲存在這部手機。</p></div>`}
      </div>`,
  });
  view.querySelector('[data-a="import"]').addEventListener('click', async () => {
    const [f] = await pickFiles({ accept: '.json,application/json' });
    if (!f) return;
    const b = busy('還原備份…');
    try {
      const p = await importBackup(f, b.set, makeThumb);
      if (p) { toast('已還原項目'); go(`#/p/${p.id}`); }
    } catch (e) { alert(e.message); } finally { b.close(); }
  });
}

// ---------- project form ----------
const FORM_FIELDS = [
  ['woNo', 'W.O. No.', '例如 QEH/042/FUJI/RLB/CHML/WO029'],
  ['refNo', 'Ref.', ''],
  ['siteLocation', 'Location（表頭）', '例如 G6 / F2 Staircase'],
  ['preparedBy', 'Attended and Prepared By（姓名）', '例如 Nathan Ng'],
  ['preparedTitle', '　職銜', 'TMC - PM / Site Agent'],
  ['inspectedBy', 'Inspected By（姓名）', '例如 Chris Ng'],
  ['inspectedTitle', '　職銜', "TMS's Representative"],
  ['signDate', '簽署日期', '例如 26/01/2026'],
];

async function viewProjectForm(view, projectId, q = {}) {
  const isNew = !projectId;
  const p = isNew
    ? { id: uid(), type: TYPES[q.type] ? q.type : 'defect', code: '', name: '', client: '', title: '', dates: '', createdAt: Date.now() }
    : await db.get('projects', projectId);
  if (!p) { go('#/'); return; }
  p.type = typeOf(p);
  const draw = () => {
    const T = TYPES[p.type];
    view.innerHTML = shell({
      title: isNew ? '新項目' : '項目資料',
      back: isNew ? '#/' : `#/p/${p.id}`,
      body: `
        <form class="form" onsubmit="return false">
          ${isNew ? `
          <h3>報告類型</h3>
          <div class="type-grid">
            ${Object.entries(TYPES).map(([k, t]) => `
              <button type="button" class="type-card ${p.type === k ? 'on' : ''}" data-type="${k}" style="--c:${t.color}">
                <b>${t.zh}</b><span class="muted small">${t.desc}</span>
              </button>`).join('')}
          </div>` : `<p>${typePill(p.type)}</p>`}
          <label>Project No.<input class="input" name="code" value="${esc(p.code)}" placeholder="例如 A22305"></label>
          <label>Project Name<textarea class="input" name="name" rows="2">${esc(p.name)}</textarea></label>
          <label>${T.form ? 'Hospital / Client' : 'Client'}<input class="input" name="client" value="${esc(p.client)}"></label>
          <label>報告標題<input class="input" name="title" value="${esc(p.title)}" placeholder="${esc(T.title)}"></label>
          <label>${p.type === 'condition' ? '相片日期（例如 25 Jul 2025）' : '檢查日期（顯示於報告）'}<input class="input" name="dates" value="${esc(p.dates)}"></label>
          ${T.form ? `<h3>表格資料（顯示於表頭及簽署欄）</h3>
            ${FORM_FIELDS.map(([k, l, ph]) => `<label>${l}<input class="input" name="${k}" value="${esc(p[k] || '')}" placeholder="${esc(ph)}"></label>`).join('')}` : ''}
          <button class="btn primary block" data-a="save">${isNew ? '建立項目' : '儲存'}</button>
          ${isNew ? '' : '<button class="btn danger ghost block" data-a="delete">刪除整個項目</button>'}
        </form>`,
    });
  };
  const collect = () => {
    const form = view.querySelector('form');
    for (const el of form.elements) if (el.name) p[el.name] = el.value.trim();
  };
  draw();
  view.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-type],[data-a]');
    if (!t) return;
    if (t.dataset.type) { collect(); p.type = t.dataset.type; draw(); return; }
    const a = t.dataset.a;
    if (a === 'save') {
      collect();
      if (!p.code && !p.name) { toast('請輸入 Project No. 或名稱'); return; }
      if (TYPES[p.type].form) {
        p.preparedTitle ||= 'TMC - PM / Site Agent';
        p.inspectedTitle ||= "TMS's Representative";
      }
      p.updatedAt = Date.now();
      await db.put('projects', p);
      go(`#/p/${p.id}`);
    } else if (a === 'delete') {
      if (!confirm(`刪除項目「${p.code} ${p.name}」及所有相片？\n此動作無法復原，建議先匯出備份。`)) return;
      if (prompt('請輸入 DELETE 確認刪除') !== 'DELETE') return;
      await db.deleteProject(p.id);
      toast('項目已刪除');
      go('#/');
    }
  });
}

// ---------- project home ----------
const listState = {};

async function viewProject(view, projectId, tab = 'list') {
  const { project, plans, defects: records } = await db.projectData(projectId);
  if (!project) { go('#/'); return; }
  const type = typeOf(project);
  const T = TYPES[type];
  const tabs = `
    <nav class="tabs">
      ${[['list', `${T.short} (${records.length})`], ['plans', `平面圖 (${plans.length})`], ['export', '匯出']]
        .map(([k, l]) => `<a href="#/p/${projectId}/${k}" class="${tab === k ? 'on' : ''}">${l}</a>`).join('')}
    </nav>`;
  const title = project.code || project.name || '項目';
  const actions = `<a class="btn ghost light sm" href="#/p/${projectId}/edit">項目資料</a>`;

  if (tab === 'plans') return viewPlansTab(view, project, plans, records, { title, actions, tabs });
  if (tab === 'export') return viewExportTab(view, project, records, { title, actions, tabs });

  db.cleanOrphanPhotos(projectId).catch(() => {});
  const st = (listState[projectId] ||= { status: 'all', q: '' });
  const thumbs = {};
  for (const d of records) {
    const ids = type === 'defect' ? [d.before?.[0], d.after?.[0]] : [Object.values(d.photos || {}).filter(Boolean).pop()];
    for (const id of ids.filter(Boolean)) { const p = await db.get('photos', id); if (p) thumbs[id] = p.thumb || p.blob; }
  }
  const counts = { all: records.length };
  for (const k of Object.keys(STATUS)) counts[k] = records.filter((d) => d.status === k).length;
  const gaps = sortDefects([...records]).some((d, i) => d.no !== i + 1);

  view.innerHTML = shell({
    title, back: '#/', actions, tabs,
    body: `
      <div class="filters">
        ${type === 'defect' ? `<div class="chips">
          ${[['all', '全部'], ...Object.entries(STATUS).map(([k, s]) => [k, s.zh])]
            .map(([k, l]) => `<button class="chip ${st.status === k ? 'on' : ''}" data-f="${k}">${l} ${counts[k]}</button>`).join('')}
        </div>` : ''}
        <div class="row gap">
          <input class="input grow" data-q placeholder="🔍 搜尋" value="${esc(st.q)}">
          ${gaps ? '<button class="btn sm" data-a="renumber" title="重新編號">重新編號 1,2,3</button>' : ''}
        </div>
      </div>
      <div class="list defects"></div>
      <div class="spacer"></div>
      <div class="fab-bar">
        <button class="btn" data-a="new">＋ 無相新增</button>
        <button class="btn primary big" data-a="capture">📷 影相新增</button>
      </div>`,
  });

  const rowHtml = (d) => {
    if (type === 'defect') {
      const s = STATUS[d.status];
      const b = thumbs[d.before?.[0]], a = thumbs[d.after?.[0]];
      return `<a class="item defect" href="#/p/${projectId}/d/${d.id}">
        <div class="dthumb">${b ? `<img src="${objURL(b)}" alt="">` : '<span>無相</span>'}<span class="no-badge">${d.no}</span></div>
        <div class="item-main">
          <div class="item-title">${d.ref ? esc(d.ref) + ' ' : ''}<span class="muted">${esc([d.area, d.location].filter(Boolean).join(' · '))}</span></div>
          <div class="desc">${esc(d.description || '（未有描述）')}</div>
          <div class="row gap small">
            <span class="pill" style="--c:${s.color}">${s.zh}</span>
            ${d.dueDate && d.status === 'outstanding' ? `<span class="muted">期限 ${fmtDate(d.dueDate)}</span>` : ''}
            ${d.planId ? '<span class="muted">📍</span>' : ''}
          </div>
        </div>
        ${a ? `<div class="dthumb after"><img src="${objURL(a)}" alt=""></div>` : ''}
      </a>`;
    }
    const id = Object.values(d.photos || {}).filter(Boolean).pop();
    const nPhotos = Object.values(d.photos || {}).filter(Boolean).length;
    const c = dimCalc(d);
    const info = type === 'condition' ? esc(d.caption || '（未有描述）')
      : `${sizeText(d) ? `${sizeText(d)} mm · ${fmtNum(c.area, 3)} m²` : '未填尺寸'}`;
    return `<a class="item defect" href="#/p/${projectId}/d/${d.id}">
      <div class="dthumb">${thumbs[id] ? `<img src="${objURL(thumbs[id])}" alt="">` : '<span>無相</span>'}<span class="no-badge">${d.no}</span></div>
      <div class="item-main">
        <div class="item-title">${d.ref ? esc(d.ref) + ' ' : ''}<span class="muted">${esc(d.location || '')}</span></div>
        <div class="desc">${info}</div>
        <div class="row gap small">
          ${type === 'spalling' ? `<span class="pill" style="--c:${nPhotos === 4 ? '#188038' : '#e8590c'}">相片 ${nPhotos}/4</span>` : ''}
          ${type === 'condition' && d.section ? `<span class="muted">${esc(d.section)}</span>` : ''}
          ${d.planId ? '<span class="muted">📍</span>' : ''}
        </div>
      </div>
    </a>`;
  };

  const renderList = () => {
    const q = st.q.trim().toLowerCase();
    const list = sortDefects(records.filter((d) =>
      (type !== 'defect' || st.status === 'all' || d.status === st.status)
      && (!q || [d.no, d.ref, d.area, d.location, d.description, d.caption, d.section, d.remarks].join(' ').toLowerCase().includes(q))));
    view.querySelector('.defects').innerHTML = list.map(rowHtml).join('')
      || '<div class="empty-state"><p>未有記錄</p><p class="muted small">按下面「📷 影相新增」開始記錄。</p></div>';
    if (type === 'hwr' || type === 'spalling') {
      const total = records.reduce((s, d) => s + dimCalc(d).area, 0);
      view.querySelector('.defects').insertAdjacentHTML('beforeend', list.length ? `<p class="muted small total">總面積 Total area：<b>${fmtNum(total, 3) || 0}</b> m²</p>` : '');
    }
  };
  renderList();

  view.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.f) {
      st.status = t.dataset.f;
      view.querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('on', b === t));
      renderList();
    } else if (t.dataset.a === 'new') go(`#/p/${projectId}/d/new`);
    else if (t.dataset.a === 'capture') {
      const files = await pickFiles({ capture: true });
      if (!files.length) return;
      pending.files = files;
      go(`#/p/${projectId}/d/new`);
    } else if (t.dataset.a === 'renumber') {
      if (!confirm('按目前次序重新編號為 1, 2, 3 …？\n平面圖上的 pin 編號會一併更新。')) return;
      const list = sortDefects([...records]);
      list.forEach((d, i) => { d.no = i + 1; });
      await db.putMany('defects', list);
      toast('已重新編號');
      route();
    }
  });
  view.querySelector('[data-q]').addEventListener('input', (e) => { st.q = e.target.value; renderList(); });
}

function viewPlansTab(view, project, plans, defects, { title, actions, tabs }) {
  plans.sort((a, b) => a.createdAt - b.createdAt);
  view.innerHTML = shell({
    title, back: '#/', actions, tabs,
    body: `
      <button class="btn primary block" data-a="import">＋ 匯入平面圖（圖片 / PDF）</button>
      <div class="plan-grid">
        ${plans.map((p) => {
          const n = defects.filter((d) => d.planId === p.id);
          return `<a class="plan-card" href="#/p/${project.id}/plan/${p.id}">
            <img src="${objURL(p.blob)}" alt="">
            <div class="plan-name">${esc(p.name)}</div>
            <div class="muted small">${n.length} 個 pin</div>
          </a>`;
        }).join('') || '<div class="empty-state"><p>未有平面圖</p><p class="muted small">匯入平面圖後，可以在圖上點選位置新增記錄，報告亦會附上標示了編號 (1, 2, 3 …) 的位置圖。</p></div>'}
      </div>`,
  });
  view.querySelector('[data-a="import"]').addEventListener('click', async () => {
    const added = await importPlans(project.id);
    if (added.length) route();
  });
}

function viewExportTab(view, project, records, { title, actions, tabs }) {
  const type = typeOf(project);
  const areas = [...new Set(records.map((d) => d.area).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const options = {
    defect: `
      <label>範圍
        <select class="input" name="scope">
          <option value="all">全部項目</option>
          <option value="outstanding">只限未完成 (Outstanding)</option>
          <option value="open">未完成 + 已修復（不包括已關閉）</option>
        </select>
      </label>
      <label>Area
        <select class="input" name="area"><option value="">所有 Area</option>${areas.map((a) => `<option>${esc(a)}</option>`).join('')}</select>
      </label>
      <label class="check"><input type="checkbox" name="summary" checked> 包括摘要頁（各狀態數量）</label>`,
    condition: `
      <label>每頁相片數目
        <select class="input" name="perPage">
          <option value="6">每頁 6 張（2 × 3）</option>
          <option value="3">每頁 3 張（相片 + 右邊描述）</option>
        </select>
      </label>`,
    hwr: '',
    spalling: '<label class="check"><input type="checkbox" name="photoPages" checked> 包括每個 Spalling 的 4 階段相片頁</label>',
  }[type];
  const note = {
    defect: 'A4 橫向，每項列出修復前後相片、描述及狀態。',
    condition: 'A4 直向，相片按編號排列，附位置圖。',
    hwr: 'A4 直向：表格（尺寸、面積、Girth）及簽署欄 → 位置圖 → 相片頁。',
    spalling: 'A4 直向：表格（尺寸、面積、Girth）及簽署欄 → 位置圖 → 每個 Spalling 一頁 4 張相。',
  }[type];
  view.innerHTML = shell({
    title, back: '#/', actions, tabs,
    body: `
      <section class="card form">
        <h3>匯出報告 ${typePill(type)}</h3>
        ${options}
        <label class="check"><input type="checkbox" name="plans" checked> 包括平面圖（標示 pin 編號 1, 2, 3 …）</label>
        <div class="row gap">
          <button class="btn primary grow" data-a="pdf">匯出 PDF</button>
          <button class="btn primary grow" data-a="docx">匯出 Word</button>
        </div>
        <p class="muted small">${note}</p>
      </section>
      <section class="card">
        <h3>備份</h3>
        <p class="muted small">資料只儲存在這部手機。請定期匯出備份檔（.json），儲存到雲端硬碟或電腦。備份檔亦可在另一部手機「匯入備份」。</p>
        <button class="btn block" data-a="backup">匯出項目備份</button>
      </section>`,
  });
  const val = (n) => view.querySelector(`[name="${n}"]`);
  const checked = (n, dflt) => (val(n) ? val(n).checked : dflt);
  view.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const b = busy('準備中…');
    try {
      const base = safeName(`${project.code || project.name}`);
      if (a === 'backup') {
        deliverFile(await exportProjectBackup(project.id, b.set), `${base}_backup_${stamp()}.json`);
        return;
      }
      const opts = {
        scope: val('scope')?.value || 'all', area: val('area')?.value || '',
        summary: checked('summary', false), plans: checked('plans', true),
        perPage: +(val('perPage')?.value || 6), photoPages: checked('photoPages', true),
      };
      const R = await collectReport(project.id, opts);
      const kind = { defect: 'Defect List', condition: 'Condition Survey', hwr: 'Hidden Work Record', spalling: 'Spalling Record' }[type];
      const suffix = type === 'defect' && opts.scope === 'outstanding' ? '_Outstanding' : '';
      if (a === 'pdf') deliverFile(await exportPdf(R, b.set), `${base}_${kind}${suffix}_${stamp()}.pdf`);
      if (a === 'docx') deliverFile(await exportDocx(R, b.set), `${base}_${kind}${suffix}_${stamp()}.docx`);
    } catch (err) {
      console.error(err);
      alert('匯出失敗：' + err.message);
    } finally {
      b.close();
    }
  });
}

// ---------- record (dispatch by project type) ----------
async function viewItem(view, projectId, recordId, q) {
  const project = await db.get('projects', projectId);
  if (!project) { go('#/'); return; }
  if (typeOf(project) === 'defect') return viewDefect(view, projectId, recordId, q, { shell, go });
  return viewRecord(view, { ...project, type: typeOf(project) }, recordId, q, { shell, go });
}

// ---------- settings ----------
async function viewSettings(view) {
  const s = await db.getSettings();
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) usage = `已使用 ${(est.usage / 1048576).toFixed(1)} MB（可用約 ${(est.quota / 1073741824).toFixed(1)} GB）`;
  } catch { /* ignore */ }
  let persisted = null;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* ignore */ }
  view.innerHTML = shell({
    title: '設定', back: '#/',
    body: `
      <form class="form" onsubmit="return false">
        <section class="card">
          <h3>公司資料（顯示於報告頁首）</h3>
          <label>公司名稱<input class="input" name="companyName" value="${esc(s.companyName)}"></label>
          <div class="row gap">
            <div class="logo-box">${s.logo ? `<img src="${objURL(s.logo)}" alt="logo">` : '<span class="muted small">未有 logo</span>'}</div>
            <button class="btn sm" data-a="logo">上載 logo</button>
            ${s.logo ? '<button class="btn sm ghost danger" data-a="nologo">移除</button>' : ''}
          </div>
        </section>
        <section class="card">
          <h3>Defect List 常用描述（每行一項）</h3>
          <textarea class="input" name="phrases" rows="8">${esc(s.phrases.join('\n'))}</textarea>
        </section>
        <section class="card">
          <h3>Condition Survey 常用描述（每行一項）</h3>
          <textarea class="input" name="conditionPhrases" rows="6">${esc((s.conditionPhrases || []).join('\n'))}</textarea>
        </section>
        <section class="card">
          <h3>Defect 分類（每行一項）</h3>
          <textarea class="input" name="categories" rows="4">${esc(s.categories.join('\n'))}</textarea>
        </section>
        <button class="btn primary block" data-a="save">儲存設定</button>
        <section class="card">
          <h3>儲存空間</h3>
          <p class="small">${usage || '無法讀取'}</p>
          <p class="small">${persisted ? '✅ 已啟用持久儲存（系統不會自動清除）' : '⚠️ 未啟用持久儲存。iPhone 請用「加入主畫面」開啟本 app。'}</p>
          <p class="muted small">版本 ${APP_VERSION} · ${navigator.onLine ? '在線' : '離線'}</p>
        </section>
      </form>`,
  });
  const form = view.querySelector('form');
  view.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'logo') {
      const [f] = await pickFiles();
      if (!f) return;
      s.logo = (await compressImage(f, 600, 0.9)).blob;
      await db.saveSettings(s);
      route();
    } else if (a === 'nologo') {
      s.logo = null; await db.saveSettings(s); route();
    } else if (a === 'save') {
      const lines = (n) => form.elements[n].value.split('\n').map((l) => l.trim()).filter(Boolean);
      s.companyName = form.elements.companyName.value.trim();
      s.phrases = lines('phrases');
      s.conditionPhrases = lines('conditionPhrases');
      s.categories = lines('categories');
      await db.saveSettings(s);
      toast('設定已儲存');
    }
  });
}

// ---------- router ----------
const routes = [
  [/^#?\/?$/, (v) => viewProjects(v)],
  [/^#\/settings$/, (v) => viewSettings(v)],
  [/^#\/new$/, (v, m, q) => viewProjectForm(v, null, q)],
  [/^#\/p\/([^/]+)\/edit$/, (v, m) => viewProjectForm(v, m[1])],
  [/^#\/p\/([^/]+)\/d\/([^/]+)$/, (v, m, q) => viewItem(v, m[1], m[2], q)],
  [/^#\/p\/([^/]+)\/plan\/([^/]+)$/, (v, m) => viewPlan(v, m[1], m[2], shell)],
  [/^#\/p\/([^/]+)(?:\/(list|defects|plans|export))?$/, (v, m) => viewProject(v, m[1], m[2] === 'defects' ? 'list' : m[2])],
];

let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  revokeAll();
  document.querySelectorAll('.modal-wrap, .viewer').forEach((el) => el.remove());
  const hash = location.hash || '#/';
  const path = hash.split('?')[0];
  const q = parseQuery(hash);
  const view = document.createElement('div');
  view.className = 'view';
  $('#app').replaceChildren(view);
  window.scrollTo(0, 0);
  try {
    for (const [re, fn] of routes) {
      const m = path.match(re);
      if (m) { await fn(view, m, q); return; }
    }
    go('#/');
  } catch (e) {
    console.error(e);
    if (seq === routeSeq) view.innerHTML = shell({ title: '出錯', back: '#/', body: `<p>${esc(e.message)}</p>` });
  }
}

window.addEventListener('hashchange', route);
route();

// Ask the browser not to evict our data, register offline support, and pre-cache libraries.
navigator.storage?.persist?.().catch(() => {});
// (skipped on localhost so local testing always loads fresh files)
if ('serviceWorker' in navigator && location.protocol !== 'file:' && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
warmLibs();
