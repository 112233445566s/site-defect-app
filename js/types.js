// Report types. Every record has an auto number `no` (1, 2, 3 … used for pins)
// and an optional custom `ref` (e.g. 27a, F2-STR-LGF-01).

export const TYPES = {
  defect: {
    zh: 'Defect List（執漏清單）',
    short: 'Defect List',
    title: 'Outstanding / Defect List',
    desc: '修復前後相、狀態追蹤',
    color: '#d93025',
  },
  spalling: {
    zh: 'Spalling Record（石屎剝落）',
    short: 'Spalling',
    title: 'Inspection Record for Spalled Concrete',
    desc: '4 張固定階段相 + 尺寸表',
    color: '#8e24aa',
    slots: [
      ['markout', 'Mark out', '畫線'],
      ['sawcut', 'Saw cut & Open-up', '切割及打開'],
      ['primer', 'Primer application', '塗底漆'],
      ['completion', 'Completion', '完成'],
    ],
    dims: true,
    form: true,
    defaultType: 'A',
  },
  hwr: {
    zh: 'Hidden Work Record（隱蔽工程）',
    short: 'Hidden Work',
    title: 'Hidden Work Record - Concrete Repairing / Debonded Plaster',
    desc: '1 張相 + 尺寸表 + 簽署欄',
    color: '#00897b',
    slots: [['main', 'Photo', '相片']],
    dims: true,
    form: true,
    defaultType: 'B',
  },
  condition: {
    zh: 'Condition Survey（狀況調查）',
    short: 'Condition Survey',
    title: 'Condition Survey Record - Site Inspection Photos',
    desc: '每個位置 1 張相 + 描述',
    color: '#1e88e5',
    slots: [['main', 'Photo', '相片']],
  },
};

export const typeOf = (project) => TYPES[project?.type] ? project.type : 'defect';

export const DEFECT_TYPES = [
  ['A', 'Spalled concrete'],
  ['B', 'Debonded plaster'],
  ['C', 'Other'],
];
export const REPAIR_METHODS = [
  ['A', 'Unicell 40 concrete repair mortar'],
  ['B', 'Patchbond 40 concrete repair mortar'],
  ['C', 'Cement and sand'],
  ['D', 'Other'],
];

// ---------- numbering ----------
export function nextNo(records) {
  return records.reduce((m, r) => Math.max(m, +r.no || 0), 0) + 1;
}
export const byNo = (a, b) => (a.no || 0) - (b.no || 0) || (a.createdAt || 0) - (b.createdAt || 0);

// "F2-STR-1F-07" -> "F2-STR-1F-08"; "" -> ""
export function incrementRef(ref) {
  if (!ref) return '';
  const m = String(ref).match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return '';
  const n = String(+m[2] + 1).padStart(m[2].length, '0');
  return m[1] + n + m[3];
}

export const label = (r) => (r.ref ? `${r.no} (${r.ref})` : String(r.no ?? ''));

// ---------- dimensions (mm in, m² / m out) ----------
export function dimCalc(r) {
  const L = +r.length || 0, W = +r.width || 0;
  return {
    area: L && W ? (L * W) / 1e6 : 0,
    girth: L && W ? (2 * (L + W)) / 1000 : 0,
  };
}
export const fmtNum = (n, dp = 2) => (n ? String(+n.toFixed(dp)) : '');
export const sizeText = (r) => (r.length && r.width ? `${r.length}x${r.width}` : '');

// ---------- photos ----------
export function photoIdsOf(r) {
  return [...(r.before || []), ...(r.after || []), ...Object.values(r.photos || {}).filter(Boolean)];
}
