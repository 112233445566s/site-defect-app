// Project backup / restore as a single JSON file (photos embedded as data URLs).
import * as db from './db.js';
import { blobToDataURL, dataURLToBlob } from './util.js';

const FORMAT = 'site-defect-backup';

export async function exportProjectBackup(projectId, progress = () => {}) {
  const { project, plans, defects } = await db.projectData(projectId);
  const photos = await db.byProject('photos', projectId);
  const enc = async (o, keys) => {
    const copy = { ...o };
    for (const k of keys) if (copy[k] instanceof Blob) copy[k] = await blobToDataURL(copy[k]);
    return copy;
  };
  const outPlans = [];
  for (const p of plans) outPlans.push(await enc(p, ['blob']));
  const outPhotos = [];
  for (let i = 0; i < photos.length; i++) {
    if (i % 10 === 0) progress(`備份相片 ${i + 1}/${photos.length}`);
    outPhotos.push(await enc(photos[i], ['blob'])); // thumbnails are rebuilt on restore
    delete outPhotos[i].thumb;
  }
  const data = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), project, plans: outPlans, defects, photos: outPhotos };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

// Returns the restored project. If the project already exists, asks before replacing it.
export async function importBackup(file, progress = () => {}, makeThumb) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('檔案格式不正確');
  }
  if (data.format !== FORMAT || !data.project) throw new Error('這不是本 app 的備份檔');
  const existing = await db.get('projects', data.project.id);
  if (existing) {
    if (!confirm(`手機上已有項目「${existing.code || ''} ${existing.name || ''}」。\n要用備份檔取代它嗎？（現有資料會被覆蓋）`)) return null;
    await db.deleteProject(existing.id);
  }
  const plans = [];
  for (const p of data.plans || []) plans.push({ ...p, blob: await dataURLToBlob(p.blob) });
  const photos = [];
  const list = data.photos || [];
  for (let i = 0; i < list.length; i++) {
    if (i % 10 === 0) progress(`還原相片 ${i + 1}/${list.length}`);
    const p = { ...list[i], blob: await dataURLToBlob(list[i].blob) };
    p.thumb = await makeThumb(p);
    photos.push(p);
  }
  await db.putMany('plans', plans);
  await db.putMany('photos', photos);
  await db.putMany('defects', data.defects || []);
  await db.put('projects', data.project);
  return data.project;
}
