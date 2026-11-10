// IndexedDB storage: everything stays on this device.
import { photoIdsOf } from './types.js';
const DB_NAME = 'site-defect';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('projects', { keyPath: 'id' });
      for (const s of ['plans', 'defects', 'photos']) {
        d.createObjectStore(s, { keyPath: 'id' }).createIndex('projectId', 'projectId');
      }
      d.createObjectStore('settings', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export async function get(store, id) {
  const d = await open();
  return req(d.transaction(store).objectStore(store).get(id));
}
export async function all(store) {
  const d = await open();
  return req(d.transaction(store).objectStore(store).getAll());
}
export async function byProject(store, projectId) {
  const d = await open();
  return req(d.transaction(store).objectStore(store).index('projectId').getAll(projectId));
}
export async function put(store, obj) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  t.objectStore(store).put(obj);
  await done(t);
  return obj;
}
export async function putMany(store, list) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  list.forEach((o) => s.put(o));
  await done(t);
}
export async function del(store, id) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  t.objectStore(store).delete(id);
  await done(t);
}
export async function delMany(store, ids) {
  if (!ids.length) return;
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  ids.forEach((id) => s.delete(id));
  await done(t);
}

// ---------- settings ----------
export const DEFAULT_PHRASES = [
  'Outstanding installation of ceiling panels',
  'Waste/dirt/stain/mark on floor',
  'Dirt/stain/mark on wall',
  'Dirt/stain/mark at soffit',
  'Dirt/stain/mark on door frame/door leaf/ironmongery',
  'Dirt/stain/mark inside cabinet',
  'Dirt/stain on skirting',
  'Crack on door leaf',
  'Crack on wall paint',
  'Crack on wall and water seepage found',
  'Wall water seepage found',
  'Wall water seepage and rust found',
  'Deformed ceiling grid',
  'Defective ceiling panels',
  'Misalignment of cabinet door',
  'Uneven gap between countertop and plastic laminate',
  'Missing door stopper',
  'Loose fixing of door architrave',
  'Malfunction of drop seal',
  'Hole around handle cover',
  'Gap around wall covers',
  'Large gap between wall and false ceiling',
  'Wall opening above false ceiling',
  'Missing access panel installation',
  'Poor workmanship of wall painting',
  'Poor workmanship of painting on soffit',
  'Construction material left above ceiling',
  'Construction waste to be removed',
  'Construction equipment to be removed',
  'Temporary notice to be removed',
  'Tape to be removed',
];
export const DEFAULT_CONDITION_PHRASES = [
  'General view',
  'Crack on wall',
  'Crack on wall and water seepage found',
  'Wall water seepage found',
  'Wall water seepage and rust found',
  'Water stain on ceiling',
  'Spalled concrete found',
  'Debonded plaster found',
  'Rusty steel bar exposed',
  'Peeled-off paint',
  'Existing damage on floor finishes',
  'Existing damage on door',
];
export const DEFAULT_CATEGORIES = ['General Item', 'Architectural', 'Building Services', 'Safety'];

export async function getSettings() {
  const s = (await get('settings', 'app')) || {};
  return {
    key: 'app',
    companyName: '',
    logo: null,
    phrases: DEFAULT_PHRASES,
    conditionPhrases: DEFAULT_CONDITION_PHRASES,
    categories: DEFAULT_CATEGORIES,
    ...s,
  };
}
export const saveSettings = (s) => put('settings', { ...s, key: 'app' });

// ---------- project helpers ----------
export async function projectData(projectId) {
  const [project, plans, defects] = await Promise.all([
    get('projects', projectId),
    byProject('plans', projectId),
    byProject('defects', projectId),
  ]);
  await ensureNumbers(defects);
  return { project, plans, defects };
}

// Older records used a free-text itemNo; give every record a numeric `no` (1, 2, 3 …)
// and keep any non-numeric label as `ref`.
async function ensureNumbers(records) {
  const missing = records.filter((r) => r.no == null);
  if (!missing.length) return;
  const used = new Set(records.filter((r) => r.no != null).map((r) => r.no));
  missing.sort((a, b) => String(a.itemNo ?? '').localeCompare(String(b.itemNo ?? ''), undefined, { numeric: true }) || a.createdAt - b.createdAt);
  let next = Math.max(0, ...used) + 1;
  for (const r of missing) {
    const n = /^\d+$/.test(String(r.itemNo ?? '')) ? +r.itemNo : null;
    if (n && !used.has(n)) r.no = n;
    else { r.no = next; if (r.itemNo) r.ref = String(r.itemNo); }
    used.add(r.no);
    next = Math.max(next, r.no + 1);
    delete r.itemNo;
  }
  await putMany('defects', missing);
}

export async function deleteProject(projectId) {
  for (const s of ['plans', 'defects', 'photos']) {
    const items = await byProject(s, projectId);
    await delMany(s, items.map((i) => i.id));
  }
  await del('projects', projectId);
}

export async function deleteDefect(defect) {
  await delMany('photos', photoIdsOf(defect));
  await del('defects', defect.id);
}

// Remove photos that no longer belong to a saved defect.
export async function cleanOrphanPhotos(projectId) {
  const [photos, defects] = await Promise.all([byProject('photos', projectId), byProject('defects', projectId)]);
  const used = new Set(defects.flatMap(photoIdsOf));
  await delMany('photos', photos.filter((p) => !used.has(p.id)).map((p) => p.id));
}
