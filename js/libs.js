// Third-party libraries, loaded on demand from a CDN and cached by the service
// worker so they keep working offline after the first online visit.
export const LIB_URLS = {
  docx: 'https://cdn.jsdelivr.net/npm/docx@8.5.0/+esm',
  pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  pdfjsWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('load failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => { s.remove(); reject(new Error('未能載入元件，請連接網絡後再試一次')); };
    document.head.appendChild(s);
  });
}

export async function getDocx() {
  try {
    return await import(LIB_URLS.docx);
  } catch {
    throw new Error('未能載入 Word 元件，請連接網絡後再試一次（之後可離線使用）');
  }
}

export async function getPdfjs() {
  await loadScript(LIB_URLS.pdfjs);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIB_URLS.pdfjsWorker;
  return window.pdfjsLib;
}

// Pre-fetch libraries while online so they are cached for offline use.
export function warmLibs() {
  if (!navigator.onLine) return;
  const run = () => {
    getDocx().catch(() => {});
    fetch(LIB_URLS.pdfjs, { mode: 'cors' }).catch(() => {});
    fetch(LIB_URLS.pdfjsWorker, { mode: 'cors' }).catch(() => {});
  };
  (window.requestIdleCallback || ((f) => setTimeout(f, 2500)))(run);
}
