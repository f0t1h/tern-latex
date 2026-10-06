// ternlatex live PDF viewer. Plain ES module, served by the ternlatex dev server.
// pdf.js API: pdfjs-dist 6.4.299 (see node_modules/pdfjs-dist/types/src/display/*.d.ts). A document is
// destroyed through its loading task (`doc.loadingTask.destroy()`); pdf.js 6 dropped PDFDocumentProxy.destroy.
import {
  getDocument,
  GlobalWorkerOptions,
  PDFWorker,
  RenderingCancelledException,
  TextLayer,
} from '/pdfjs/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

// ---------------------------------------------------------------- constants

const CSS_UNITS = 96 / 72; // "100%" = real size, like other PDF viewers
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6.4];
const MIN_SCALE = 0.1 * CSS_UNITS;
const MAX_SCALE = 8 * CSS_UNITS;
const PAD = 12; // keep in sync with .pages padding / .page margin in viewer.css
const MAX_CANVAS_PIXELS = 16_777_216; // WebKit per-canvas limit
const MAX_CONCURRENT_RENDERS = 2;
const KEEP_VIEWPORTS = 2.5; // free canvases farther than this many viewport heights away
const STAGING_TIMEOUT_MS = 4000; // swap anyway if the new visible pages take longer than this
const ZOOM_SETTLE_MS = 120; // debounce re-rendering while zooming continuously
// Chromium's userAgentData says "macOS", WebKit's navigator.platform "MacIntel".
const IS_MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl+'; // display prefixes in hints
const ALT = IS_MAC ? '⌥' : 'Alt+';
const TIP_KEY = 'ternlatex.tip.v1'; // localStorage: the first-run tip was dismissed
const QUERY_DOC = new URLSearchParams(location.search).get('doc') || ''; // popped-out block: pinned document
const VIEW_KEY = 'ternlatex:view:'; // sessionStorage prefix for per-document position and zoom
const VIEW_SAVE_MS = 400;
const CHECKPOINT_LIMIT = 15;
const CONFIRM_MS = 4000; // how long an "Accept all" button waits for its confirming click
const AUTHOR_PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d'];

// ---------------------------------------------------------------- DOM

const $ = (id) => document.getElementById(id);
const viewer = $('viewer');
const ui = {
  buildState: $('build-state'),
  buildLabel: $('build-label'),
  errCount: $('err-count'),
  warnCount: $('warn-count'),
  conn: $('conn'),
  pageInfo: $('page-info'),
  zoomOut: $('zoom-out'),
  zoomLabel: $('zoom-label'),
  zoomIn: $('zoom-in'),
  banner: $('banner'),
  bannerClose: $('banner-close'),
  bannerList: $('banner-list'),
  diagPanel: $('diag-panel'),
  diagClose: $('diag-close'),
  diagList: $('diag-list'),
  empty: $('empty'),
  emptyTitle: $('empty-title'),
  emptyList: $('empty-list'),
  toast: $('toast'),
  rebuild: $('rebuild'),
  download: $('download'),
  selBar: $('sel-bar'),
  selActions: $('sel-actions'),
  selSource: $('sel-source'),
  selProofread: $('sel-proofread'),
  selAsk: $('sel-ask'),
  selDictate: $('sel-dictate'),
  selInput: $('sel-input'),
  dictatePill: $('dictate-pill'),
  dictateTime: $('dictate-time'),
  dictateLevel: $('dictate-level'),
  dictateText: $('dictate-text'),
  dictateDone: $('dictate-done'),
  dictateCancel: $('dictate-cancel'),
  docs: $('docs'),
  changesBtn: $('changes-btn'),
  changesMenu: $('changes-menu'),
  changesLive: $('changes-live'),
  changesHead: $('changes-head'),
  changesCheckpoints: $('changes-checkpoints'),
  changesCustom: $('changes-custom'),
  changesRev: $('changes-rev'),
  diffBar: $('diff-bar'),
  diffLabel: $('diff-label'),
  diffBack: $('diff-back'),
  reviewBtn: $('review-btn'),
  reviewCount: $('review-count'),
  reviewPanel: $('review-panel'),
  reviewFilter: $('review-filter'),
  reviewClose: $('review-close'),
  reviewAuthors: $('review-authors'),
  reviewEmpty: $('review-empty'),
  reviewList: $('review-list'),
  helpBtn: $('help-btn'),
  help: $('help'),
  tip: $('tip'),
  tipText: $('tip-text'),
  tipClose: $('tip-close'),
  ctxMenu: $('ctx-menu'),
};

// One worker for the whole session; documents passed `worker` do not destroy it.
const worker = new PDFWorker({ name: 'ternlatex' });

// ---------------------------------------------------------------- state

const state = {
  doc: null, // PDFDocumentProxy currently shown
  rev: 0, // rev of `doc` (for a redline: the live rev it was built against)
  docKind: 'live', // 'live' | 'diff': what `doc` is
  docOf: null, // document name `doc` belongs to (null: single-document server)
  pages: [], // PageRec[] of `doc`
  container: $('pages'),
  scale: CSS_UNITS, // CSS px per PDF unit (getViewport scale)
  fitWidth: true,
  status: null, // Status of the current document
  connected: false,
  bannerDismissedKey: null,
  pendingReveal: null,
  pendingPos: null, // reading position to restore at the next swap (document switch)
  lastZoomAt: 0,
  caps: { agent: false, editor: false, popout: false, keys: null, dictation: null }, // GET /capabilities
  sel: null, // SelInfo shown in the selection action bar
  docName: QUERY_DOC || hashParam('doc') || null, // current document; null until GET /docs (or an old server)
  docs: [], // DocEntry[] from GET /docs and SSE status events
  docsLoaded: false, // GET /docs answered (ok or 404)
  diff: null, // DiffMode while showing (or preparing) a redline
  review: { available: false, authors: [], items: [], filter: '', key: '' },
};

/**
 * @typedef {object} DocEntry
 * @property {string} name
 * @property {string} root project-relative root .tex file
 * @property {any} status latest Status of this document
 * @property {number} pages page count once its PDF was loaded here
 * @property {number} builtAt Date.now() when a finished build was last seen
 */

/**
 * @typedef {object} DiffMode
 * @property {string} rev git revision the redline compares against
 * @property {string} label shown in the diff bar
 * @property {number} liveRev live PDF rev the newest diff request was made for
 * @property {boolean} shown a redline is on screen (false while the first one is being built)
 * @property {boolean} busy POST /diff in flight
 * @property {boolean} again a newer live rev arrived while busy
 */

/** Pages of the current document that own a canvas or a running render. */
let rendered = new Set();
const pageByDiv = new WeakMap();

/**
 * @typedef {object} PageRec
 * @property {number} index 0-based
 * @property {import('pdfjs-dist').PDFPageProxy} proxy
 * @property {number} baseW viewport width at scale 1
 * @property {number} baseH viewport height at scale 1
 * @property {HTMLDivElement} div
 * @property {HTMLCanvasElement|null} canvas
 * @property {any} task running RenderTask
 * @property {number} taskScale
 * @property {number} renderedScale
 * @property {number} renderedDpr
 * @property {number} seq bumps to invalidate in-flight work
 * @property {any} pendingText TextLayer being built
 * @property {HTMLDivElement|null} textDiv
 * @property {boolean} near intersecting the observer's extended viewport
 */

function makePage(proxy, index) {
  const vp = proxy.getViewport({ scale: 1 });
  const div = document.createElement('div');
  div.className = 'page';
  div.dataset.page = String(index + 1);
  const p = {
    index,
    proxy,
    baseW: vp.width,
    baseH: vp.height,
    div,
    canvas: null,
    task: null,
    taskScale: 0,
    renderedScale: 0,
    renderedDpr: 0,
    seq: 0,
    pendingText: null,
    textDiv: null,
    near: false,
  };
  pageByDiv.set(div, p);
  return p;
}

function sizePage(p, scale) {
  const s = p.div.style;
  s.width = `${Math.round(p.baseW * scale)}px`;
  s.height = `${Math.round(p.baseH * scale)}px`;
  // pdf.js text layer sizes itself from this variable (= viewport.scale * userUnit).
  s.setProperty('--total-scale-factor', String(scale * p.proxy.userUnit));
}

// ---------------------------------------------------------------- rendering

function outputScale(vp) {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height)));
}

function releaseCanvas(c) {
  c.remove();
  c.width = 0; // frees the backing store immediately in WebKit
  c.height = 0;
}

function cancelWork(p) {
  p.seq++;
  if (p.task) {
    p.task.cancel();
    p.task = null;
  }
  if (p.pendingText) {
    p.pendingText.cancel();
    p.pendingText = null;
  }
}

/** Free everything a page holds. `cleanup`: also drop pdf.js per-page caches. */
function freePage(p, cleanup) {
  cancelWork(p);
  if (p.canvas) {
    releaseCanvas(p.canvas);
    p.canvas = null;
  }
  if (p.textDiv) {
    p.textDiv.remove();
    p.textDiv = null;
  }
  p.renderedScale = 0;
  p.renderedDpr = 0;
  if (cleanup) p.proxy.cleanup();
}

/**
 * Render a page into a fresh canvas and only then swap it in, so the previous
 * canvas (possibly at another zoom) stays visible meanwhile.
 * Resolves true when the new canvas was attached.
 */
async function renderPage(p, scale) {
  cancelWork(p);
  const seq = p.seq;
  const viewport = p.proxy.getViewport({ scale });
  const out = outputScale(viewport);
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width * out));
  canvas.height = Math.max(1, Math.floor(viewport.height * out));
  const sx = canvas.width / viewport.width;
  const sy = canvas.height / viewport.height;
  const task = p.proxy.render({
    canvas,
    viewport,
    transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : undefined,
  });
  p.task = task;
  p.taskScale = scale;
  try {
    await task.promise;
  } catch (err) {
    releaseCanvas(canvas);
    if (p.task === task) p.task = null;
    if (err instanceof RenderingCancelledException || err?.name === 'RenderingCancelledException') return false;
    if (seq === p.seq) {
      // Do not retry in a loop; a zoom change or reload will try again.
      p.renderedScale = scale;
      p.renderedDpr = dpr;
    }
    console.error(`ternlatex: rendering page ${p.index + 1} failed`, err);
    return false;
  }
  if (p.task === task) p.task = null;
  if (seq !== p.seq) {
    releaseCanvas(canvas);
    return false;
  }
  if (p.canvas) {
    p.canvas.replaceWith(canvas);
    releaseCanvas(p.canvas);
  } else {
    p.div.prepend(canvas);
  }
  p.canvas = canvas;
  p.renderedScale = scale;
  p.renderedDpr = dpr;
  buildTextLayer(p, viewport, seq);
  return true;
}

function buildTextLayer(p, viewport, seq) {
  const div = document.createElement('div');
  div.className = 'textLayer';
  let tl;
  try {
    tl = new TextLayer({ textContentSource: p.proxy.streamTextContent(), container: div, viewport });
  } catch (err) {
    console.warn('ternlatex: text layer unavailable', err);
    return;
  }
  p.pendingText = tl;
  tl.render().then(
    () => {
      if (seq !== p.seq || p.pendingText !== tl) return;
      p.pendingText = null;
      if (p.textDiv) p.textDiv.remove();
      p.textDiv = div;
      p.div.append(div);
    },
    () => {},
  );
}

let pumpTimer = 0;

/** Start renders for near pages that are missing or stale, closest first. */
function pump() {
  const sinceZoom = performance.now() - state.lastZoomAt;
  if (sinceZoom < ZOOM_SETTLE_MS) {
    clearTimeout(pumpTimer);
    pumpTimer = setTimeout(pump, ZOOM_SETTLE_MS - sinceZoom + 5);
    return;
  }
  const scale = state.scale;
  const dpr = window.devicePixelRatio || 1;
  let active = 0;
  const todo = [];
  for (const p of state.pages) {
    if (p.task) {
      if (p.taskScale === scale) {
        active++;
        continue;
      }
    } else if (p.renderedScale === scale && p.renderedDpr === dpr) {
      continue;
    }
    if (p.near) todo.push(p);
  }
  if (!todo.length || active >= MAX_CONCURRENT_RENDERS) return;
  const center = viewer.scrollTop + viewer.clientHeight / 2;
  const dist = (p) => Math.abs(p.div.offsetTop + p.div.offsetHeight / 2 - center);
  todo.sort((a, b) => dist(a) - dist(b));
  for (const p of todo.slice(0, MAX_CONCURRENT_RENDERS - active)) {
    rendered.add(p);
    renderPage(p, scale).finally(() => scheduleUpdate());
  }
}

/** Free canvases that are far outside the viewport. */
function evict() {
  const top = viewer.scrollTop;
  const h = viewer.clientHeight;
  for (const p of rendered) {
    if (p.near) continue;
    const t = p.div.offsetTop;
    const b = t + p.div.offsetHeight;
    const dist = Math.max(0, t - (top + h), top - b);
    if (dist > KEEP_VIEWPORTS * h) {
      freePage(p, true);
      rendered.delete(p);
    }
  }
}

let updateQueued = false;
function scheduleUpdate() {
  if (updateQueued) return;
  updateQueued = true;
  requestAnimationFrame(() => {
    updateQueued = false;
    updatePageInfo();
    evict();
    pump();
  });
}

let io = null;
function observePages() {
  if (io) io.disconnect();
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const p = pageByDiv.get(e.target);
        if (p) p.near = e.isIntersecting;
      }
      scheduleUpdate();
    },
    { root: viewer, rootMargin: '100% 0px 100% 0px' },
  );
  for (const p of state.pages) io.observe(p.div);
}

// ---------------------------------------------------------------- position

/** Index of the last page whose top is <= y (y in container coordinates). */
function pageIndexAt(pages, y) {
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].div.offsetTop <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Reading position = page index + fraction within that page at viewport offset
 * `anchorY` (+ px into the gap below the page), plus horizontal center ratio.
 */
function capturePosition(anchorY) {
  const pages = state.pages;
  if (!pages.length) return null;
  const y = viewer.scrollTop + anchorY;
  const index = pageIndexAt(pages, y);
  const d = pages[index].div;
  const into = y - d.offsetTop;
  const h = d.offsetHeight || 1;
  const sw = viewer.scrollWidth || 1;
  return {
    index,
    frac: Math.max(0, Math.min(1, into / h)),
    gap: Math.max(0, into - h),
    anchorY,
    xFrac: (viewer.scrollLeft + viewer.clientWidth / 2) / sw,
  };
}

function initialPosition() {
  const n = hashPage();
  return { index: n ? n - 1 : 0, frac: 0, gap: 0, anchorY: PAD, xFrac: 0.5 };
}

function targetScrollTop(pages, pos) {
  const index = Math.min(pos.index, pages.length - 1);
  const d = pages[index].div;
  const frac = pos.index > index ? 1 : pos.frac;
  return d.offsetTop + frac * d.offsetHeight + pos.gap - pos.anchorY;
}

function restorePosition(pos) {
  if (!state.pages.length) return;
  viewer.scrollTop = targetScrollTop(state.pages, pos);
  viewer.scrollLeft = pos.xFrac * viewer.scrollWidth - viewer.clientWidth / 2;
}

function currentPageIndex() {
  const pages = state.pages;
  if (!pages.length) return -1;
  if (viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 2) return pages.length - 1;
  return pageIndexAt(pages, viewer.scrollTop + viewer.clientHeight * 0.3);
}

function updatePageInfo() {
  const i = currentPageIndex();
  ui.pageInfo.textContent = i < 0 ? '– / –' : `${i + 1} / ${state.pages.length}`;
}

function scrollToPage(n) {
  const p = state.pages[Math.max(1, Math.min(n, state.pages.length)) - 1];
  if (p) viewer.scrollTop = p.div.offsetTop - PAD;
}

function hashParam(name) {
  return new URLSearchParams(location.hash.slice(1)).get(name);
}

function hashPage() {
  const v = hashParam('page');
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : 0;
}

// ---------------------------------------------------------------- zoom

function fitScale(pages) {
  if (!pages.length) return state.scale;
  let maxW = 0;
  for (const p of pages) maxW = Math.max(maxW, p.baseW);
  const avail = viewer.clientWidth - 2 * PAD;
  return clampScale(avail / maxW);
}

function clampScale(s) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

function updateZoomLabel() {
  ui.zoomLabel.textContent = `${Math.round((state.scale / CSS_UNITS) * 100)}%`;
  ui.zoomLabel.title = state.fitWidth ? 'Fit width (⌘0)' : 'Fit width (⌘0) — currently manual zoom';
}

function setScale(scale, { fit = false, anchorY = viewer.clientHeight / 2 } = {}) {
  scale = clampScale(scale);
  state.fitWidth = fit;
  if (Math.abs(scale - state.scale) < 1e-6) {
    updateZoomLabel();
    return;
  }
  const pos = capturePosition(anchorY);
  state.scale = scale;
  for (const p of state.pages) sizePage(p, scale);
  if (pos) restorePosition(pos);
  if (state.sel) anchorSelBar();
  state.lastZoomAt = performance.now();
  updateZoomLabel();
  scheduleUpdate();
}

function zoomStep(dir) {
  const z = state.scale / CSS_UNITS;
  let next;
  if (dir > 0) next = ZOOM_STEPS.find((s) => s > z * 1.01) ?? z * 1.25;
  else next = [...ZOOM_STEPS].reverse().find((s) => s < z * 0.99) ?? z / 1.25;
  setScale(next * CSS_UNITS);
}

function fitWidth() {
  setScale(fitScale(state.pages), { fit: true });
}

// ---------------------------------------------------------------- loading / live reload

let loadSeq = 0;
let loadingRev = 0;
let loadingKind = 'live';
let loadingDoc = null;
let loadingTask = null;
let fetchCtl = null;
let stagingPages = null; // pages of the load in progress, so a newer rev can cancel their renders

/** URL of a document-specific GET route, for the current document. */
function docURL(path, params = {}) {
  const q = new URLSearchParams();
  if (state.docName) q.set('doc', state.docName);
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Body of a document-specific POST route, for the current document. */
function withDoc(body) {
  return state.docName ? { ...body, doc: state.docName } : body;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

/**
 * Load rev N into a hidden staging container laid out at the current zoom,
 * render the pages that will be visible at the restored position, then swap
 * synchronously (old canvases stay on screen until then). Newer loads abort this.
 * `kind` 'diff' loads the redline (GET /diff.pdf) built against live rev N instead.
 * Resolves true when the new document was swapped in.
 */
async function loadRev(rev, kind = 'live') {
  const seq = ++loadSeq;
  const stale = () => seq !== loadSeq;
  const docName = state.docName;
  loadingRev = rev;
  loadingKind = kind;
  loadingDoc = docName;
  if (fetchCtl) fetchCtl.abort();
  fetchCtl = new AbortController();
  if (loadingTask) loadingTask.destroy().catch(() => {});
  loadingTask = null;
  if (stagingPages) for (const p of stagingPages) cancelWork(p);
  stagingPages = null;
  updateEmpty();

  let pdf = null;
  let staging = null;
  let newPages = null;
  try {
    const path = kind === 'diff' ? '/diff.pdf' : '/pdf';
    const res = await fetch(docURL(path, { rev }), { cache: 'no-store', signal: fetchCtl.signal });
    if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (stale()) return false;

    const task = getDocument({ data, worker, cMapUrl: '/pdfjs-cmaps/', standardFontDataUrl: '/pdfjs-fonts/', wasmUrl: '/pdfjs-wasm/' });
    loadingTask = task;
    pdf = await task.promise;
    if (loadingTask === task) loadingTask = null; // `pdf` owns the document from here on
    if (stale()) return false;

    const proxies = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
    if (stale()) return false;

    newPages = proxies.map(makePage);
    stagingPages = newPages;
    let scale = state.fitWidth ? fitScale(newPages) : state.scale;
    staging = document.createElement('div');
    staging.className = 'pages staging';
    for (const p of newPages) {
      sizePage(p, scale);
      staging.append(p.div);
    }
    viewer.append(staging);

    // Pre-render what will be visible after the swap.
    const pos = state.pendingPos ?? capturePosition(0) ?? initialPosition();
    const top = targetScrollTop(newPages, pos);
    const bottom = top + viewer.clientHeight;
    const targets = newPages.filter((p) => p.div.offsetTop < bottom && p.div.offsetTop + p.div.offsetHeight > top);
    await withTimeout(Promise.all(targets.map((p) => renderPage(p, scale))), STAGING_TIMEOUT_MS);
    if (stale()) return false;

    // Zoom or block size may have changed while staging.
    const finalScale = state.fitWidth ? fitScale(newPages) : state.scale;
    if (finalScale !== scale) {
      scale = finalScale;
      for (const p of newPages) sizePage(p, scale);
    }
    stagingPages = null;
    // swapIn owns these from here: should it throw, the finally below must not remove the container it took over.
    const doc = pdf;
    const pages = newPages;
    const container = staging;
    pdf = null;
    newPages = null;
    staging = null;
    swapIn(doc, rev, pages, container, scale, kind, docName);
    return true;
  } catch (err) {
    if (!stale() && err?.name !== 'AbortError') {
      console.error('ternlatex: loading PDF failed', err);
      toast(`Could not load ${kind === 'diff' ? 'the changes PDF' : 'PDF'}: ${err?.message ?? err}`);
      // Do not leave another document's pages on screen under this document's tab.
      if (state.docOf !== state.docName) clearDoc();
    }
    return false;
  } finally {
    if (newPages && stagingPages === newPages) stagingPages = null;
    if (newPages) for (const p of newPages) freePage(p, false);
    if (staging) staging.remove();
    if (pdf) pdf.loadingTask.destroy().catch(() => {});
    if (seq === loadSeq) {
      loadingRev = 0;
      loadingTask = null;
      updateEmpty();
    }
  }
}

/** Abort the load in progress, if any. */
function cancelLoad() {
  ++loadSeq;
  if (fetchCtl) fetchCtl.abort();
  if (loadingTask) loadingTask.destroy().catch(() => {});
  loadingTask = null;
  loadingRev = 0;
  if (stagingPages) for (const p of stagingPages) cancelWork(p);
  stagingPages = null;
}

/** Drop the shown document (switching to a document without a PDF yet). */
function clearDoc() {
  cancelLoad();
  if (io) io.disconnect();
  for (const p of state.pages) freePage(p, false);
  if (state.doc) state.doc.loadingTask.destroy().catch(() => {});
  state.container.replaceChildren();
  state.doc = null;
  state.rev = 0;
  state.docKind = 'live';
  state.docOf = null;
  state.pages = [];
  rendered = new Set();
  if (state.sel) hideSelBar();
  updatePageInfo();
  updateEmpty();
  updateBanner();
}

function swapIn(pdf, rev, newPages, staging, scale, kind, docName) {
  const firstLoad = !state.doc;
  const pos = state.pendingPos ?? (firstLoad ? initialPosition() : (capturePosition(0) ?? initialPosition()));
  const sameView = state.docKind === kind && state.docOf === docName;
  const oldPages = state.pages;
  const oldDoc = state.doc;

  state.pendingPos = null;
  state.container.remove();
  staging.classList.remove('staging');
  staging.id = 'pages';
  state.container = staging;
  state.doc = pdf;
  state.rev = rev;
  state.docKind = kind;
  state.docOf = docName;
  state.pages = newPages;
  state.scale = scale;
  restorePosition(pos);
  // The old text layer (and with it the selection) is gone. Keep the bar only while
  // the user is typing an instruction about the same document; its PDF-space snapshot
  // re-anchors on the new pages. A redline has no SyncTeX, so the bar never shows there.
  if (state.sel) {
    if (askOpen() && sameView && selActionsAvailable()) anchorSelBar();
    else hideSelBar();
  }
  const entry = docEntry(docName);
  if (entry && kind === 'live' && entry.pages !== newPages.length) {
    entry.pages = newPages.length;
    renderDocs();
  }

  rendered = new Set(newPages.filter((p) => p.canvas || p.task));
  observePages();

  for (const p of oldPages) freePage(p, false);
  if (oldDoc) oldDoc.loadingTask.destroy().catch(() => {});

  updateZoomLabel();
  updateEmpty();
  updateBanner();
  scheduleUpdate();

  if (state.pendingReveal) {
    const r = state.pendingReveal;
    state.pendingReveal = null;
    applyReveal(r);
  }
}

// ---------------------------------------------------------------- reveal (forward search)

// A reveal for another document switches to it first; the reveal runs once its PDF is in.
// In the Changes view the box comes from the live PDF's SyncTeX, so it is approximate there.
function onReveal(r) {
  if (typeof r.doc === 'string' && r.doc !== state.docName && docEntry(r.doc)) switchDoc(r.doc);
  if (!state.doc || loadingRev || state.docOf !== state.docName) {
    state.pendingReveal = r;
    return;
  }
  applyReveal(r);
}

function applyReveal(r) {
  const p = state.pages[(r.page | 0) - 1];
  if (!p) return;
  const vp = p.proxy.getViewport({ scale: state.scale });
  const [vx0, , , vy1] = p.proxy.view;
  // Box is top-left-origin PDF points; PDF user space is bottom-left-origin.
  const a = vp.convertToViewportPoint(vx0 + r.x, vy1 - r.y);
  const b = vp.convertToViewportPoint(vx0 + r.x + (r.width || 0), vy1 - r.y - (r.height || 0));
  let left = Math.min(a[0], b[0]);
  let top = Math.min(a[1], b[1]);
  let width = Math.abs(b[0] - a[0]);
  let height = Math.abs(b[1] - a[1]);
  const pageW = p.div.offsetWidth;
  if (width < 2) {
    // Point-like result: highlight the whole line band.
    left = pageW * 0.05;
    width = pageW * 0.9;
  }
  const minH = 10 * state.scale;
  if (height < minH) {
    top -= (minH - height) / 2;
    height = minH;
  }
  const box = document.createElement('div');
  box.className = 'reveal-box';
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  box.addEventListener('animationend', () => box.remove());
  setTimeout(() => box.remove(), 2500); // in case animations are disabled
  p.div.append(box);

  const targetTop = p.div.offsetTop + top - viewer.clientHeight / 3;
  const pageLeft = p.div.offsetLeft;
  const targetLeft =
    viewer.scrollWidth > viewer.clientWidth ? pageLeft + left + width / 2 - viewer.clientWidth / 2 : 0;
  viewer.scrollTo({ top: Math.max(0, targetTop), left: Math.max(0, targetLeft), behavior: 'smooth' });
}

// ---------------------------------------------------------------- reverse search

function isSyncModifier(e) {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/** Client (CSS viewport) point → PDF points on page `p`, top-left origin, y downward. */
function clientToPdf(p, clientX, clientY) {
  const rect = p.div.getBoundingClientRect();
  const vp = p.proxy.getViewport({ scale: state.scale });
  const px = ((clientX - rect.left) * vp.width) / rect.width;
  const py = ((clientY - rect.top) * vp.height) / rect.height;
  const [x, y] = vp.convertToPdfPoint(px, py);
  const [vx0, , , vy1] = p.proxy.view;
  return {
    x: Math.round((x - vx0) * 100) / 100,
    y: Math.round((vy1 - y) * 100) / 100,
  };
}

/** Inverse of clientToPdf, as an offset in #viewer's scroll space (for absolute children). */
function pdfToViewer(p, x, y) {
  const vp = p.proxy.getViewport({ scale: state.scale });
  const [vx0, , , vy1] = p.proxy.view;
  const [px, py] = vp.convertToViewportPoint(vx0 + x, vy1 - y);
  const rect = p.div.getBoundingClientRect();
  const vr = viewer.getBoundingClientRect();
  return {
    left: rect.left + (px * rect.width) / vp.width - vr.left - viewer.clientLeft + viewer.scrollLeft,
    top: rect.top + (py * rect.height) / vp.height - vr.top - viewer.clientTop + viewer.scrollTop,
  };
}

function onSyncClick(e) {
  if (!isSyncModifier(e)) return;
  const div = e.target instanceof Element ? e.target.closest('.page') : null;
  const p = div && pageByDiv.get(div);
  if (!p || !state.pages.includes(p)) return;
  e.preventDefault();
  e.stopPropagation();
  sourceAt(p, e.clientX, e.clientY);
}

/** Reverse search at a client point on page `p` (⌘-click, the menu's "Show source here"). */
function sourceAt(p, clientX, clientY) {
  if (state.docKind === 'diff') {
    toast('Source lookup works on the live PDF — click “Back to live” first');
    return;
  }
  const { x, y } = clientToPdf(p, clientX, clientY);
  reverseSearch({ page: p.index + 1, x, y });
}

function reverseSearch(body) {
  postJSON('/reverse', withDoc(body))
    .then((res) => {
      if (res.status === 404) toast('No source location found here');
      else if (!res.ok) toast(`Reverse search failed (${res.status})`);
    })
    .catch(() => toast('Reverse search failed: server unreachable'));
}

function postJSON(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function openFile(file, line) {
  const body = line ? { file, line } : { file, line: 1 };
  postJSON('/open', body)
    .then((res) => {
      if (!res.ok) toast(`Could not open ${file} (${res.status})`);
    })
    .catch(() => toast('Could not open file: server unreachable'));
}

// ---------------------------------------------------------------- selection action bar

const SEL_DEBOUNCE_MS = 180;
const SEL_TEXT_MAX = 1500;
const SEL_PLACEHOLDER = ui.selInput.placeholder; // "Ask omp about this spot…" swaps in its own

/**
 * Snapshot of a text selection, taken when the bar is shown. PDF points, top-left origin.
 * @typedef {object} SelInfo
 * @property {number} page 1-based page holding the first selection rect
 * @property {{x: number, y: number}} start left edge, vertical middle of the first rect
 * @property {{x: number, y: number}} end right edge, vertical middle of the last rect on `page`
 * @property {string} text whitespace-collapsed, at most SEL_TEXT_MAX chars
 * @property {number} top first rect's top edge (bar anchor)
 * @property {number} bottom first rect's bottom edge (bar anchor when there is no room above)
 * @property {Range} range clone, to restore the selection when the instruction input is cancelled
 */

let selTimer = 0;
let selPointerDown = false;
let selBusy = false;
let selDismissed = null; // signature of a selection whose bar was dismissed (Escape / scrolled away)

function selSignature(s) {
  return s ? [s.anchorNode, s.anchorOffset, s.focusNode, s.focusOffset] : null;
}

function sameSignature(a, b) {
  return !!a && !!b && a.every((v, i) => v === b[i]);
}

function pageAtClient(x, y, hint) {
  const inside = (p) => {
    const r = p.div.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const h = hint && pageByDiv.get(hint.closest('.page'));
  if (h && state.pages.includes(h) && inside(h)) return h;
  return state.pages.find(inside) ?? null;
}

/** @returns {SelInfo|null} */
function readSelection(s) {
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  const range = s.getRangeAt(0);
  const node = range.startContainer;
  const startEl = node instanceof Element ? node : node.parentElement;
  if (!startEl?.closest('.textLayer') || !state.container.contains(startEl)) return null;
  const text = s.toString().replace(/\s+/g, ' ').trim().slice(0, SEL_TEXT_MAX);
  if (!text) return null;
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const mid = (r) => r.top + r.height / 2;
  const first = rects[0];
  const p = pageAtClient(first.left + first.width / 2, mid(first), startEl);
  if (!p) return null;
  // Spanning pages: stay on the start page and end at its last rect.
  const box = p.div.getBoundingClientRect();
  const onPage = rects.filter((r) => {
    const cx = r.left + r.width / 2;
    const cy = mid(r);
    return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
  });
  const last = onPage.at(-1) ?? first;
  return {
    page: p.index + 1,
    start: clientToPdf(p, first.left, mid(first)),
    end: clientToPdf(p, last.right, mid(last)),
    text,
    top: clientToPdf(p, first.left, first.top).y,
    bottom: clientToPdf(p, first.left, first.bottom).y,
    range: range.cloneRange(),
  };
}

/** The bar maps selections through SyncTeX, which only the live PDF has. */
function selActionsAvailable() {
  return state.docKind === 'live' && (state.caps.editor || state.caps.agent || state.caps.proofread || Boolean(state.caps.dictation));
}

function askOpen() {
  return !ui.selInput.hidden;
}

function updateSelButtons() {
  ui.selSource.hidden = !state.caps.editor;
  ui.selProofread.hidden = !(state.caps.agent || state.caps.proofread);
  ui.selAsk.hidden = !state.caps.agent;
  ui.selDictate.hidden = !state.caps.dictation;
  ui.selDictate.disabled = selBusy || !dictationReady();
  ui.selDictate.title = dictationReady()
    ? 'Speak text to go after this passage; it lands as a suggestion in ✎ Review (key D)'
    : `Dictation needs omp's speech model: ${state.caps.dictation?.hint || 'run `omp setup speech`'}`;
  if (state.sel && (!selActionsAvailable() || (askOpen() && !state.caps.agent))) hideSelBar();
  else if (state.sel) anchorSelBar();
}

function setAskMode(on) {
  ui.selActions.hidden = on;
  ui.selInput.hidden = !on;
  if (on) {
    ui.selInput.value = '';
    ui.selInput.focus({ preventScroll: true });
  }
}

function openAsk() {
  setAskMode(true);
  anchorSelBar();
}

function showSelBar(info) {
  state.sel = info;
  ui.selInput.placeholder = SEL_PLACEHOLDER;
  setAskMode(false);
  ui.selBar.hidden = false;
  updateSelButtons();
}

function hideSelBar() {
  clearTimeout(selTimer);
  state.sel = null;
  if (askOpen()) setAskMode(false);
  ui.selBar.hidden = true;
}

/** Hide the bar and do not bring it back for the current selection. */
function dismissSelBar() {
  selDismissed = selSignature(document.getSelection());
  hideSelBar();
}

/** Place the bar just above the selection's first rect, from its PDF-space snapshot. */
function anchorSelBar() {
  const info = state.sel;
  const p = info && state.pages[info.page - 1];
  if (!p) {
    hideSelBar();
    return;
  }
  const bar = ui.selBar;
  const a = pdfToViewer(p, info.start.x, info.top);
  let top = a.top - bar.offsetHeight - 6;
  if (top < viewer.scrollTop + 2) top = pdfToViewer(p, info.start.x, info.bottom).top + 6;
  const maxLeft = Math.max(0, state.container.offsetWidth - bar.offsetWidth - 4);
  bar.style.left = `${Math.round(Math.max(0, Math.min(a.left - 4, maxLeft)))}px`;
  bar.style.top = `${Math.round(Math.max(0, top))}px`;
}

function scheduleSelRefresh() {
  clearTimeout(selTimer);
  selTimer = setTimeout(refreshSelection, SEL_DEBOUNCE_MS);
}

function refreshSelection() {
  // Typing an instruction moves focus (and the document selection) into the input.
  if (selPointerDown || selBusy || askOpen()) return;
  const s = document.getSelection();
  const info = readSelection(s);
  if (!info) {
    selDismissed = null;
    hideSelBar();
    return;
  }
  if (sameSignature(selSignature(s), selDismissed) || !selActionsAvailable()) {
    hideSelBar();
    return;
  }
  selDismissed = null;
  showSelBar(info);
}

function onSelScroll() {
  if (!state.sel) return;
  const h = viewer.clientHeight;
  const top = ui.selBar.offsetTop;
  if (top < viewer.scrollTop - h || top > viewer.scrollTop + 2 * h) dismissSelBar();
}

function setSelBusy(on) {
  selBusy = on;
  ui.selBar.classList.toggle('busy', on);
  for (const el of [ui.selSource, ui.selProofread, ui.selAsk, ui.selInput]) el.disabled = on;
  ui.selDictate.disabled = on || !dictationReady();
  if (!on && askOpen()) ui.selInput.focus({ preventScroll: true });
}

function selSource() {
  const info = state.sel;
  if (info) reverseSearch({ page: info.page, x: info.start.x, y: info.start.y, text: info.text });
}

async function sendToAgent(action, instruction) {
  const info = state.sel;
  if (!info || selBusy) return;
  const body = { action, page: info.page, start: info.start, end: info.end, text: info.text };
  if (instruction) body.instruction = instruction;
  // Proofread runs on the server (one no-reasoning omp call per paragraph) when it can, not in the omp block.
  const direct = action === 'proofread' && state.caps?.proofread;
  setSelBusy(true);
  if (direct) toast('Proofreading…');
  try {
    const res = await postJSON(direct ? '/proofread' : '/agent', withDoc(body));
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast(data?.error ?? `${direct ? 'proofread' : 'omp request'} failed (${res.status})`);
    } else if (direct) {
      const n = data?.suggestions ?? 0;
      const where = data?.pending ? ' — review them in ✎ Review (the PDF changes when you accept)' : ' — review them in ✎ Review';
      toast(data?.reverted ? `Proofread reverted: ${data.reverted}` : n ? `${n} suggestion${n === 1 ? '' : 's'}${where}` : 'No corrections found');
      hideSelBar();
      document.getSelection()?.removeAllRanges();
      if (n && !data?.reverted) {
        await fetchReview();
        setReviewPanel(true);
      }
    } else {
      toast(`Sent to omp (${data?.file}:${data?.from}–${data?.to})`);
      hideSelBar();
      document.getSelection()?.removeAllRanges();
    }
  } catch {
    toast(`${direct ? 'proofread' : 'omp request'} failed: server unreachable`);
  } finally {
    setSelBusy(false);
  }
}

// ---------------------------------------------------------------- dictation

const DICTATE_MAX_MS = 120_000; // a recording stops (Done) after 2 minutes
const DICTATE_PREVIEW_MS = 1500; // live transcript refresh
const DICTATE_TICK_MS = 200; // clock and level meter
const DICTATE_RATE = 16000; // upload rate (the model's): 2 minutes stay under the server's 8 MiB body cap
const DICTATE_CHUNK = 2048; // frames per message from the capture worklet

// Batches the microphone's frames (128 per render quantum) into larger messages for the page.
const CAPTURE_WORKLET = `registerProcessor('tl-capture', class extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${DICTATE_CHUNK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(${DICTATE_CHUNK}); this.n = 0; }
    }
    return true;
  }
});`;

/**
 * The recording in progress, or null.
 * @type {null | { info: SelInfo, doc: string | null, stream: MediaStream, ctx: AudioContext, node: AudioNode,
 *   chunks: Float32Array[], frames: number, level: number, startedAt: number, timer: number,
 *   previewAt: number, previewFrames: number, previewBusy: boolean, sending: boolean }}
 */
let rec = null;

function dictationReady() {
  return state.caps.dictation?.ready === true;
}

/** Mono capture at the context's own rate: an AudioWorklet where available, else a ScriptProcessor. */
async function captureNode(ctx, source, onFrames) {
  if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'tl-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (e) => onFrames(e.data);
      source.connect(node);
      node.connect(ctx.destination); // silent; keeps the node pulled
      return node;
    } catch {
      // Fall through to the ScriptProcessor.
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => onFrames(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(node);
  node.connect(ctx.destination);
  return node;
}

/** Start recording for the selection: the bar gives way to the dictation pill. */
async function startDictation() {
  const info = state.sel;
  if (!info || selBusy || rec) return;
  if (!dictationReady()) {
    toast(state.caps.dictation?.hint || 'dictation is unavailable', 6000);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('no microphone access in this browser');
    return;
  }
  setSelBusy(true);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    setSelBusy(false);
    toast(`microphone unavailable: ${e?.message || e}`, 5000);
    return;
  }
  const ctx = new AudioContext();
  const r = { info, doc: state.docName, stream, ctx, node: null, chunks: [], frames: 0, level: 0, startedAt: performance.now(), timer: 0, previewAt: 0, previewFrames: 0, previewBusy: false, sending: false };
  rec = r;
  try {
    r.node = await captureNode(ctx, ctx.createMediaStreamSource(stream), (frames) => {
      if (rec !== r || r.sending) return;
      r.chunks.push(frames);
      r.frames += frames.length;
      let sum = 0;
      for (let i = 0; i < frames.length; i++) sum += frames[i] * frames[i];
      r.level = Math.max(Math.sqrt(sum / frames.length), r.level * 0.8);
    });
    await ctx.resume();
  } catch (e) {
    stopCapture(r);
    rec = null;
    setSelBusy(false);
    toast(`recording failed: ${e?.message || e}`, 5000);
    return;
  }
  hideSelBar();
  setPill('recording');
  ui.dictateText.textContent = 'Listening…';
  ui.dictateText.classList.add('muted');
  anchorPill();
  r.timer = setInterval(() => dictationTick(r), DICTATE_TICK_MS);
  dictationTick(r);
}

function dictationTick(r) {
  if (rec !== r || r.sending) return;
  const ms = performance.now() - r.startedAt;
  const s = Math.floor(ms / 1000);
  ui.dictateTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  ui.dictateLevel.style.setProperty('--level', String(Math.min(1, r.level * 4)));
  r.level *= 0.6;
  if (ms >= DICTATE_MAX_MS) {
    finishDictation();
    return;
  }
  if (!r.previewBusy && r.frames > r.previewFrames && ms - r.previewAt >= DICTATE_PREVIEW_MS) previewDictation(r);
}

/** Live transcript of the audio so far; never more than one request in flight. */
async function previewDictation(r) {
  r.previewBusy = true;
  r.previewAt = performance.now() - r.startedAt;
  r.previewFrames = r.frames;
  try {
    const res = await postJSON('/dictate/transcribe', { audio: pcmBase64(r), sampleRate: DICTATE_RATE });
    const data = await res.json().catch(() => null);
    if (rec !== r || r.sending) return;
    if (res.ok && typeof data?.text === 'string' && data.text) {
      ui.dictateText.textContent = data.text;
      ui.dictateText.classList.remove('muted');
      ui.dictateText.scrollLeft = ui.dictateText.scrollWidth; // the newest words
    } else if (!res.ok) {
      ui.dictateText.textContent = data?.error ?? `preview failed (${res.status})`;
    }
  } catch {
    // The final transcription reports a dead server.
  } finally {
    r.previewBusy = false;
  }
}

/** The recording so far: mono, resampled to DICTATE_RATE, 16-bit little-endian PCM in base64. */
function pcmBase64(r) {
  const step = r.ctx.sampleRate / DICTATE_RATE;
  const n = Math.floor(r.frames / step);
  const all = new Float32Array(r.frames);
  let at = 0;
  for (const c of r.chunks) {
    all.set(c.subarray(0, Math.min(c.length, r.frames - at)), at);
    at += c.length;
    if (at >= r.frames) break;
  }
  const pcm = new DataView(new ArrayBuffer(n * 2));
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const f = x - j;
    const v = all[j] * (1 - f) + (all[j + 1] ?? all[j]) * f;
    pcm.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(v * 32768))), true);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Stop the microphone at once (the system's recording indicator goes off) and release the audio graph. */
function stopCapture(r) {
  clearInterval(r.timer);
  for (const t of r.stream.getTracks()) t.stop();
  try {
    r.node?.disconnect();
  } catch {
    // Already disconnected.
  }
  r.ctx.close().catch(() => {});
}

function cancelDictation() {
  const r = rec;
  if (!r || r.sending) return;
  stopCapture(r);
  rec = null;
  setPill(null);
  setSelBusy(false);
  scheduleSelRefresh(); // the selection is still there: its bar comes back
}

/** Done: transcribe everything and insert it after the selection as a suggestion, like Proofread's. */
async function finishDictation() {
  const r = rec;
  if (!r || r.sending) return;
  r.sending = true;
  stopCapture(r);
  setPill('busy');
  try {
    const body = { page: r.info.page, start: r.info.start, end: r.info.end, text: r.info.text, audio: pcmBase64(r), sampleRate: DICTATE_RATE };
    const res = await postJSON('/dictate', r.doc ? { ...body, doc: r.doc } : body);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast(data?.error ?? `dictation failed (${res.status})`, 5000);
      return;
    }
    toast(data?.pending ? 'Dictation added — review it in ✎ Review (the PDF changes when you accept)' : 'Dictation added — review it in ✎ Review', 4000);
    document.getSelection()?.removeAllRanges();
    await fetchReview();
    setReviewPanel(true);
  } catch {
    toast('dictation failed: server unreachable');
  } finally {
    rec = null;
    setPill(null);
    setSelBusy(false);
  }
}

/** Pill state: 'recording', 'busy' (transcribing) or null (hidden). */
function setPill(mode) {
  ui.dictatePill.hidden = !mode;
  ui.dictatePill.classList.toggle('busy', mode === 'busy');
  ui.dictateDone.disabled = mode !== 'recording';
  ui.dictateCancel.disabled = mode !== 'recording';
  if (mode === 'busy') {
    ui.dictateText.textContent = 'Transcribing…';
    ui.dictateText.classList.add('muted');
  }
}

/** Place the pill just below the selection's end, from its PDF-space snapshot. */
function anchorPill() {
  const p = rec && state.pages[rec.info.page - 1];
  if (!p) return;
  const pill = ui.dictatePill;
  const a = pdfToViewer(p, rec.info.end.x, rec.info.end.y);
  const maxLeft = Math.max(0, state.container.offsetWidth - pill.offsetWidth - 4);
  pill.style.left = `${Math.round(Math.max(0, Math.min(a.left - 16, maxLeft)))}px`;
  pill.style.top = `${Math.round(a.top + 12)}px`;
}

function cancelAsk() {
  const range = state.sel?.range;
  setAskMode(false);
  if (range && range.startContainer.isConnected && range.endContainer.isConnected) {
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(range); // selectionchange re-shows the buttons for it
    anchorSelBar();
  } else {
    hideSelBar();
  }
}

// Embedded browsers (Tern's included) may ignore downloads, so ask the server to open the PDF in the
// system app; a plain download remains the fallback.
function openPdfApp() {
  postJSON('/open-pdf', withDoc({}))
    .then((res) => {
      if (!res.ok) location.href = ui.download.href;
    })
    .catch(() => {
      location.href = ui.download.href;
    });
}

// ---------------------------------------------------------------- rebuild / capabilities

let rebuilding = false;

async function rebuild() {
  if (rebuilding) return;
  rebuilding = true;
  ui.rebuild.disabled = true;
  ui.buildState.className = 'state-building';
  ui.buildLabel.textContent = 'Building…';
  try {
    const res = await postJSON('/build', withDoc({}));
    if (!res.ok) {
      toast(`Rebuild failed (${res.status})`);
      return;
    }
    const j = await res.json().catch(() => null);
    // Current servers answer {docs: Status[]}; older ones a single Status.
    const list = Array.isArray(j?.docs) ? j.docs : j && typeof j === 'object' ? [j] : [];
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      const cur = typeof s.doc === 'string' ? docEntry(s.doc)?.status : state.status;
      if (!cur || s.build >= cur.build) onStatus(s);
    }
    if (state.status?.ok === false) toast('Build failed — see diagnostics');
  } catch {
    toast('Rebuild failed: server unreachable');
  } finally {
    rebuilding = false;
    ui.rebuild.disabled = false;
    // Undo the optimistic building state if no status arrived meanwhile.
    if (state.status && state.status.state !== 'building' && ui.buildState.className === 'state-building') {
      applyStatus(state.status);
    }
  }
}

function pdfStem(root) {
  const base = String(root ?? '').split(/[\\/]/).pop() ?? '';
  return base.replace(/\.[^.]*$/, '') || 'document';
}

let capsSeq = 0;

async function fetchCaps() {
  const seq = ++capsSeq;
  let caps = { agent: false, editor: false, popout: false, history: false, proofread: false, keys: null, dictation: null };
  let answered = false;
  try {
    const res = await fetch('/capabilities', { cache: 'no-store' });
    if (res.ok) {
      const c = await res.json();
      const keys = Array.isArray(c?.keys)
        ? c.keys.filter((k) => k && ['id', 'title', 'hint', 'display'].every((f) => typeof k[f] === 'string'))
        : null;
      const d = c?.dictation;
      const dictation = d && typeof d.ready === 'boolean' ? { ready: d.ready, hint: typeof d.hint === 'string' ? d.hint : '' } : null;
      caps = { agent: c?.agent === true, editor: c?.editor === true, popout: c?.popout === true, history: c?.history === true, proofread: c?.proofread === true, keys, dictation };
      answered = true;
    }
  } catch {
    // Server unreachable: treat as no capabilities until the next EventSource open.
  }
  if (seq !== capsSeq) return;
  state.caps = caps;
  updateSelButtons();
  renderDocs();
  ui.changesBtn.hidden = !caps.history;
  if (!caps.history) closeChangesMenu();
  if (answered) updateTip();
  if (!ui.help.hidden) renderHelp();
  // Fix buttons depend on caps.agent, which may arrive after the first status.
  if (state.status) {
    fillList(ui.diagList, [...diagnostics()].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3)));
    updateBanner();
    updateEmpty();
  }
}

// ---------------------------------------------------------------- status UI

const SEV_ORDER = { error: 0, warning: 1, info: 2 };

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function diagItem(d) {
  const li = document.createElement('li');
  li.className = `sev-${d.severity}`;
  const sev = document.createElement('span');
  sev.className = 'sev';
  sev.textContent = d.severity;
  li.append(sev);
  if (d.file) {
    li.classList.add('clickable');
    li.title = 'Open in editor';
    const loc = document.createElement('span');
    loc.className = 'loc';
    loc.textContent = d.line ? `${d.file}:${d.line}` : d.file;
    li.append(loc, ' ');
    li.addEventListener('click', () => openFile(d.file, d.line));
  }
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = d.message;
  li.append(msg);
  if (state.caps.agent) {
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.className = 'fix';
    fix.textContent = 'Fix';
    fix.title = 'Ask omp to fix this at the source';
    fix.addEventListener('click', (e) => {
      e.stopPropagation(); // not the row's open-in-editor
      askFix([d]);
    });
    li.append(fix);
  }
  return li;
}

/** A list of diagnostics, headed by "Fix all with omp" when omp is attached and something is fixable. */
function fillList(ul, diags) {
  const items = diags.map(diagItem);
  const fixable = diags.filter((d) => d.severity !== 'info');
  if (state.caps.agent && fixable.length > 1) {
    const li = document.createElement('li');
    li.className = 'fix-all';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `Fix all ${fixable.length} with omp`;
    b.title = 'Send every error and warning of this document to omp';
    b.addEventListener('click', () => askFix(fixable));
    li.append(b);
    items.unshift(li);
  }
  ul.replaceChildren(...items);
}

/** Hands diagnostics of the current document to the omp block (fix-build skill for errors). */
async function askFix(diags) {
  try {
    const res = await postJSON('/fix', withDoc({ diagnostics: diags }));
    const data = await res.json().catch(() => null);
    toast(res.ok ? `Sent ${diags.length === 1 ? 'it' : `${diags.length} items`} to omp` : (data?.error ?? `omp request failed (${res.status})`));
  } catch {
    toast('omp request failed: server unreachable');
  }
}

function diagnostics() {
  return state.status?.diagnostics ?? [];
}

function errorsOf(diags) {
  return diags.filter((d) => d.severity === 'error');
}

function applyStatus(s) {
  state.status = s;
  const diags = [...(s.diagnostics ?? [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
  const nErr = diags.filter((d) => d.severity === 'error').length;
  const nWarn = diags.filter((d) => d.severity === 'warning').length;
  const nInfo = diags.filter((d) => d.severity === 'info').length;

  let cls;
  let label;
  if (s.state === 'building') {
    cls = 'state-building';
    label = s.note ? `Building… (${s.note})` : 'Building…';
  } else if (s.ok === true) {
    cls = 'state-ok';
    // A cached PDF: these exact sources were built before (an undo, a revert, a restart).
    label = s.cached ? 'Reused earlier build' : s.durationMs != null ? `Built in ${(s.durationMs / 1000).toFixed(1)}s` : 'Built';
  } else if (s.ok === false) {
    cls = 'state-failed';
    label = 'Build failed';
  } else {
    cls = 'state-idle';
    label = 'Waiting for build';
  }
  ui.buildState.className = cls;
  ui.buildLabel.textContent = label;
  const root = s.root ?? docEntry(state.docName)?.root ?? '';
  const stem = state.docName || pdfStem(root);
  ui.buildState.title = `${root} — build #${s.build}${s.rev ? `, PDF rev ${s.rev}` : ''}`;
  ui.download.hidden = !(s.rev > 0);
  ui.download.href = docURL('/pdf', { download: 1 });
  ui.download.download = `${stem}.pdf`;
  ui.download.title = `Open ${stem}.pdf in the system PDF app (save, print, share)`;

  ui.errCount.hidden = nErr === 0;
  ui.errCount.textContent = plural(nErr, 'error');
  ui.warnCount.hidden = nWarn + nInfo === 0;
  ui.warnCount.textContent = nWarn ? plural(nWarn, 'warning') : `${nInfo} info`;
  ui.warnCount.title = `${plural(nWarn, 'warning')}, ${nInfo} info — show diagnostics`;

  fillList(ui.diagList, diags);
  if (!diags.length) setPanel(false);
  updateBanner();
  updateEmpty();

  if (state.diff) {
    // The redline follows the edits: rebuild it for every new live rev.
    if (s.rev > 0 && s.rev !== state.diff.liveRev) requestDiff();
    return;
  }
  const showing = state.docKind === 'live' && state.docOf === state.docName && s.rev === state.rev;
  const loading = loadingRev === s.rev && loadingKind === 'live' && loadingDoc === state.docName;
  if (s.rev > 0 && !showing && !loading) loadRev(s.rev);
  else if (!(s.rev > 0) && state.doc && state.docOf !== state.docName) clearDoc();
}

function bannerKey() {
  return JSON.stringify(errorsOf(diagnostics()));
}

function updateBanner() {
  const s = state.status;
  const show = !!(s && s.ok === false && state.doc && state.bannerDismissedKey !== bannerKey());
  ui.banner.hidden = !show;
  if (show) fillList(ui.bannerList, errorsOf(diagnostics()));
}

// Diagnostics and Review share the right edge; only one is open at a time.
function setPanel(open) {
  ui.diagPanel.hidden = !open;
  ui.errCount.setAttribute('aria-pressed', String(open));
  ui.warnCount.setAttribute('aria-pressed', String(open));
  if (open) setReviewPanel(false);
}

function updateEmpty() {
  const hasDoc = !!state.doc;
  ui.empty.hidden = hasDoc;
  if (hasDoc) return;
  const s = state.status;
  let spinner = true;
  let title;
  let list = [];
  if (!state.connected && !s) title = 'Connecting to the ternlatex server…';
  else if (!state.connected) title = 'Disconnected — waiting for the ternlatex server…';
  else if (!s || s.state === 'building' || s.ok === null) title = s?.note ? `Building… ${s.note}` : 'Building…';
  else if (loadingRev || s.rev > 0) title = 'Loading PDF…';
  else if (s.ok === false) {
    spinner = false;
    title = 'Build failed — no PDF yet';
    list = errorsOf(s.diagnostics ?? []);
    if (!list.length) list = s.diagnostics ?? [];
  } else title = 'Waiting for the first build…';
  const parts = [];
  if (spinner) {
    const sp = document.createElement('span');
    sp.className = 'spinner';
    parts.push(sp);
  }
  parts.push(document.createTextNode(` ${title}`));
  ui.emptyTitle.replaceChildren(...parts);
  fillList(ui.emptyList, list);
}

let connTimer = 0;
function setConnected(on) {
  if (state.connected === on) return;
  state.connected = on;
  clearTimeout(connTimer);
  if (on) ui.conn.hidden = true;
  else connTimer = setTimeout(() => (ui.conn.hidden = state.connected), 800); // avoid flashing on quick reconnects
  updateEmpty();
}

let toastTimer = 0;
function toast(text, ms = 2400) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.hidden = true), ms);
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso ?? '');
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  return new Date(t).toLocaleDateString();
}

/** Wall-clock label for a timestamp: "14:32" today, "3 Oct 14:32" otherwise. */
function clockTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso ?? '');
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

// ---------------------------------------------------------------- documents

const views = new Map(); // document name → saved reading position and zoom

function docEntry(name) {
  return name ? (state.docs.find((d) => d.name === name) ?? null) : null;
}

function upsertDoc(name, root, status) {
  let d = docEntry(name);
  if (!d) {
    d = { name, root: '', status: null, pages: 0, builtAt: 0 };
    state.docs.push(d);
  }
  if (root) d.root = root;
  if (status) {
    const prev = d.status;
    if (prev && status.state !== 'building' && (prev.build !== status.build || prev.state === 'building')) {
      d.builtAt = Date.now();
    }
    d.status = status;
  }
  return d;
}

/** True when a status may come with edited sources, so the review list is worth refetching. */
function reviewStale(prev, s) {
  if (!prev) return true;
  if (prev.rev !== s.rev) return true;
  return s.state !== 'building' && (prev.build !== s.build || prev.state === 'building');
}

/** Every Status from the server goes through here: SSE, POST /build. */
function onStatus(s) {
  const name = typeof s.doc === 'string' ? s.doc : null;
  const prev = name ? docEntry(name)?.status : state.status;
  if (name) {
    upsertDoc(name, typeof s.root === 'string' ? s.root : '', s);
    renderDocs();
  }
  if (reviewStale(prev, s)) fetchReview();
  // Statuses without `doc` come from a single-document server.
  if (!name || name === state.docName) applyStatus(s);
}

async function fetchDocs() {
  let list = null;
  try {
    const res = await fetch('/docs', { cache: 'no-store' });
    if (res.status === 404) list = []; // older server: one unnamed document
    else if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j)) list = j;
    }
  } catch {
    // Unreachable: retried on the next EventSource open.
  }
  if (!list) return;
  state.docsLoaded = true;
  const names = new Set();
  for (const d of list) {
    const name = typeof d?.name === 'string' ? d.name : typeof d?.doc === 'string' ? d.doc : null;
    if (!name) continue;
    names.add(name);
    // An SSE status may already be newer than this snapshot.
    upsertDoc(name, typeof d.root === 'string' ? d.root : '', docEntry(name)?.status ? null : { ...d, doc: name });
  }
  state.docs = state.docs.filter((d) => names.has(d.name));
  if (!state.docs.length) {
    state.docName = null;
    renderDocs();
    return;
  }
  const cur = docEntry(state.docName);
  if (!cur) {
    if (state.docName) toast(`No document named “${state.docName}” — showing ${state.docs[0].name}`);
    const first = state.docName === null;
    state.docName = null;
    switchDoc(state.docs[0].name, { page: first ? hashPage() : 0, initial: first });
  } else if (cur.status && state.status !== cur.status) {
    applyStatus(cur.status);
  }
  renderDocs();
}

function loadView(name) {
  if (views.has(name)) return views.get(name);
  let v = null;
  try {
    v = JSON.parse(sessionStorage.getItem(VIEW_KEY + name) ?? 'null');
  } catch {
    v = null;
  }
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  if (!v || typeof v !== 'object' || !['index', 'frac', 'gap', 'anchorY', 'xFrac', 'scale'].every((k) => num(v[k]))) return null;
  views.set(name, v);
  return v;
}

function saveView() {
  const name = state.docName;
  if (!name || state.docOf !== name || state.docKind !== 'live') return;
  const pos = capturePosition(0);
  if (!pos) return;
  const v = { ...pos, scale: state.scale, fitWidth: state.fitWidth };
  views.set(name, v);
  try {
    sessionStorage.setItem(VIEW_KEY + name, JSON.stringify(v));
  } catch {
    // Storage full or disabled: the in-memory copy still covers this session.
  }
}

let viewSaveTimer = 0;
function scheduleViewSave() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveView, VIEW_SAVE_MS);
}

/** Position and zoom to open document `name` with: page `page`, else where the user left it. */
function primeView(name, page) {
  const view = page ? null : loadView(name);
  if (view) {
    state.fitWidth = view.fitWidth !== false;
    if (!state.fitWidth) state.scale = clampScale(view.scale);
    updateZoomLabel();
  }
  state.pendingPos = view
    ? { index: view.index, frac: view.frac, gap: view.gap, anchorY: view.anchorY, xFrac: view.xFrac }
    : { index: page ? page - 1 : 0, frac: 0, gap: 0, anchorY: PAD, xFrac: 0.5 };
}

function writeLocation(name, page) {
  const q = new URLSearchParams(location.search);
  if (q.has('doc')) q.set('doc', name); // a popped-out block reopens on the document it shows now
  const h = new URLSearchParams({ doc: name });
  if (page) h.set('page', String(page));
  const search = q.toString();
  history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}#${h}`);
}

/** Show document `name`; the previous one stays on screen until the new PDF is ready. */
function switchDoc(name, { page = 0, initial = false } = {}) {
  const entry = docEntry(name);
  if (!entry) return;
  if (name === state.docName) {
    if (page && state.doc) scrollToPage(page);
    return;
  }
  clearTimeout(viewSaveTimer);
  saveView();
  if (state.diff) leaveDiff();
  state.docName = name;
  state.pendingReveal = null;
  state.bannerDismissedKey = null;
  if (state.sel) hideSelBar();
  primeView(name, page);
  if (!initial) writeLocation(name, page);
  postJSON('/focus', { doc: name }).catch(() => {}); // build this document first from now on
  renderDocs();
  applyStatus(entry.status ?? { doc: name, build: 0, rev: 0, state: 'idle', ok: null, diagnostics: [] });
}

function docTitle(d, i) {
  const s = d.status;
  const lines = [d.root || d.name];
  if (s?.state === 'building') lines.push('Building…');
  else if (s && s.build > 0) {
    const when = d.builtAt ? relTime(new Date(d.builtAt).toISOString()) : `build #${s.build}`;
    const took = s.cached ? ', reused an earlier build of the same sources' : s.durationMs != null ? `, took ${(s.durationMs / 1000).toFixed(1)}s` : '';
    const nErr = errorsOf(s.diagnostics ?? []).length;
    const result = s.ok === false ? ` — failed (${plural(nErr, 'error')})` : '';
    lines.push(`Last build: ${when}${took}${result}`);
  }
  if (i < 9) lines.push(`${IS_MAC ? '⌥' : 'Alt+'}${i + 1}`);
  return lines.join('\n');
}

function docChip(d, i) {
  const s = d.status;
  const current = d.name === state.docName;
  const wrap = el('div', current ? 'doc-chip current' : 'doc-chip');
  const tab = el('button', 'doc-tab');
  tab.type = 'button';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', String(current));
  tab.title = docTitle(d, i);
  let mark;
  if (s?.state === 'building') mark = el('span', 'spinner');
  else if (s?.ok === true) mark = el('span', 'doc-dot ok');
  else if (s?.ok === false) {
    const nErr = errorsOf(s.diagnostics ?? []).length;
    mark = el('span', 'doc-dot failed', nErr ? String(nErr) : '');
  } else mark = el('span', 'doc-dot');
  tab.append(mark, el('span', 'doc-name', d.name));
  if (d.pages) tab.append(el('span', 'doc-pages', `${d.pages}p`));
  tab.addEventListener('click', () => switchDoc(d.name));
  wrap.append(tab);
  if (state.caps.popout) {
    const pop = el('button', 'doc-pop', '⧉');
    pop.type = 'button';
    pop.title = `Open ${d.name} in another browser block`;
    pop.addEventListener('click', () => popout(d.name));
    wrap.append(pop);
  }
  return wrap;
}

function renderDocs() {
  const many = state.docs.length > 1;
  ui.docs.hidden = !many;
  ui.docs.replaceChildren(...(many ? state.docs.map(docChip) : []));
}

function popout(name) {
  postJSON('/popout', { doc: name })
    .then(async (res) => {
      if (!res.ok) toast((await res.json().catch(() => null))?.error ?? `Pop-out failed (${res.status})`);
    })
    .catch(() => toast('Pop-out failed: server unreachable'));
}

// ---------------------------------------------------------------- changes (redline) mode

let diffSeq = 0;
let menuSeq = 0;

function firstError(diags) {
  if (!Array.isArray(diags) || !diags.length) return '';
  const d = diags.find((x) => x?.severity === 'error') ?? diags[0];
  const loc = d?.file ? `${d.file}${d.line ? `:${d.line}` : ''}: ` : '';
  return `${loc}${d?.message ?? ''}`;
}

function updateDiffUI() {
  const d = state.diff;
  document.body.classList.toggle('diff-mode', !!d);
  ui.diffBar.hidden = !d;
  ui.changesLive.hidden = !d;
  ui.changesBtn.classList.toggle('busy', !!d?.busy);
  ui.changesBtn.setAttribute('aria-pressed', String(!!d));
  if (!d) return;
  ui.diffBar.classList.toggle('busy', d.busy);
  ui.diffBar.classList.toggle('outdated', !d.busy && !!d.error);
  let label = `Changes since ${d.label}`;
  if (d.busy) label = d.shown ? `${label} — updating…` : `Preparing changes since ${d.label}…`;
  else if (d.error) label = `${label} — out of date`;
  ui.diffLabel.textContent = label;
  ui.diffBar.title = d.error || `Redline (latexdiff) of ${d.rev} against the working tree`;
}

function enterDiff(rev, label) {
  closeChangesMenu();
  state.diff = { rev, label, liveRev: 0, shown: false, busy: false, again: false, error: '' };
  if (state.sel) hideSelBar();
  updateDiffUI();
  requestDiff();
}

/** Forget the redline without reloading anything (document switch). */
function leaveDiff() {
  state.diff = null;
  ++diffSeq;
  // A redline still loading must not land on screen after this.
  if (loadingRev && loadingKind === 'diff') {
    cancelLoad();
    updateEmpty();
  }
  updateDiffUI();
}

/** "Back to live": drop the redline and show the live PDF at the current rev. */
function exitDiff() {
  leaveDiff();
  if (state.status) applyStatus(state.status);
}

/** POST /diff for the current live rev, then swap the redline in. Coalesces while one is in flight. */
async function requestDiff() {
  const d = state.diff;
  if (!d) return;
  if (d.busy) {
    d.again = true;
    return;
  }
  const seq = ++diffSeq;
  const stale = () => seq !== diffSeq || state.diff !== d;
  d.busy = true;
  d.again = false;
  d.liveRev = state.status?.rev ?? 0;
  updateDiffUI();
  let failure = '';
  try {
    const res = await postJSON('/diff', withDoc({ rev: d.rev }));
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.ok !== true) {
      failure = firstError(j?.diagnostics) || j?.error || `building the changes PDF failed (${res.status})`;
    }
  } catch {
    failure = 'server unreachable';
  }
  if (stale()) return;
  if (!failure) {
    const swapped = await loadRev(d.liveRev, 'diff');
    if (stale()) return;
    if (swapped) {
      d.shown = true;
      d.error = '';
    } else failure = 'could not load the changes PDF';
  } else {
    toast(`Changes since ${d.label}: ${failure}`, 6000);
  }
  if (failure && !d.shown) {
    exitDiff(); // never got a redline: stay on the live PDF
    return;
  }
  if (failure) d.error = failure; // keep the last redline, marked out of date
  d.busy = false;
  if (d.again) requestDiff();
  else updateDiffUI();
}

function closeChangesMenu() {
  ui.changesMenu.hidden = true;
  ui.changesBtn.setAttribute('aria-expanded', 'false');
}

function menuItem(text, title, onClick) {
  const b = el('button', 'menu-item');
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  if (title) b.title = title;
  b.append(...(Array.isArray(text) ? text : [text]));
  b.addEventListener('click', onClick);
  return b;
}

async function openChangesMenu() {
  ui.changesMenu.hidden = false;
  ui.changesBtn.setAttribute('aria-expanded', 'true');
  ui.changesRev.hidden = true;
  ui.changesCustom.hidden = false;
  ui.changesCheckpoints.replaceChildren(el('div', 'menu-note', 'Loading checkpoints…'));
  const seq = ++menuSeq;
  let list = null;
  try {
    const res = await fetch(`/checkpoints?limit=${CHECKPOINT_LIMIT}`, { cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j)) list = j;
    }
  } catch {
    list = null;
  }
  if (seq !== menuSeq || ui.changesMenu.hidden) return;
  if (!list) {
    ui.changesCheckpoints.replaceChildren(el('div', 'menu-note', 'Checkpoints unavailable'));
    return;
  }
  const items = list
    .filter((c) => typeof c?.sha === 'string')
    .map((c) => {
      const msg = typeof c.message === 'string' ? c.message : '';
      const title = `${c.sha.slice(0, 10)} · ${new Date(c.date).toLocaleString()}${msg ? `\n${msg}` : ''}`;
      return menuItem([el('span', 'when', relTime(c.date)), el('span', 'what', msg)], title, () =>
        enterDiff(c.sha, `the ${clockTime(c.date)} checkpoint`),
      );
    });
  ui.changesCheckpoints.replaceChildren(
    ...(items.length ? items : [el('div', 'menu-note', 'No checkpoints yet — one is taken on every save')]),
  );
}

// ---------------------------------------------------------------- review panel (changes package)

const ANON = '-'; // filter key for items without an author (author ids are alphanumeric)
const KIND = {
  added: { icon: '+', label: 'Added' },
  deleted: { icon: '−', label: 'Deleted' },
  replaced: { icon: '↔', label: 'Replaced' },
  comment: { icon: '❝', label: 'Comment' },
  highlight: { icon: '▍', label: 'Highlight' },
};
const SNIPPET_MAX = 220;

let reviewBusy = false;
let reviewAgain = false;

async function fetchReview() {
  if (reviewBusy) {
    reviewAgain = true;
    return;
  }
  reviewBusy = true;
  try {
    const res = await fetch('/changes', { cache: 'no-store' });
    if (res.status === 404) {
      state.review.available = false; // older server, or review disabled
      state.review.items = [];
    } else if (res.ok) {
      const j = await res.json();
      if (j && Array.isArray(j.items)) {
        state.review.available = true;
        state.review.authors = Array.isArray(j.authors) ? j.authors.filter((a) => typeof a?.id === 'string') : [];
        state.review.items = j.items.filter((c) => typeof c?.id === 'string' && typeof c.file === 'string');
      }
    }
  } catch {
    // Unreachable: keep what we have; the next status refetches.
  }
  reviewBusy = false;
  renderReview();
  if (reviewAgain) {
    reviewAgain = false;
    fetchReview();
  }
}

function authorKey(c) {
  return c.author || ANON;
}

function authorName(key) {
  if (key === ANON) return 'No author';
  return state.review.authors.find((a) => a.id === key)?.name || key;
}

function authorColor(key) {
  if (key === ANON) return 'var(--muted)';
  const authors = state.review.authors;
  const i = authors.findIndex((a) => a.id === key);
  const c = authors[i]?.color;
  if (c && CSS.supports('color', c)) return c;
  let h = i;
  if (h < 0) for (const ch of key) h = (Math.max(h, 0) * 31 + ch.charCodeAt(0)) >>> 0;
  return AUTHOR_PALETTE[h % AUTHOR_PALETTE.length];
}

function chip(key) {
  const c = el('span', 'chip');
  c.style.background = authorColor(key);
  c.title = authorName(key);
  return c;
}

function clip(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX)}…` : t;
}

function snippet(c) {
  const div = el('div', 'snippet');
  if (c.kind === 'replaced') div.append(el('del', null, clip(c.old)), ' → ', el('ins', null, clip(c.text)));
  else if (c.kind === 'deleted') div.append(el('del', null, clip(c.text)));
  else if (c.kind === 'added') div.append(el('ins', null, clip(c.text)));
  else if (c.kind === 'highlight') div.append(el('mark', null, clip(c.text)));
  else div.textContent = clip(c.text);
  return div;
}

async function resolve(ids, decision) {
  if (!ids.length) return;
  try {
    const res = await postJSON('/changes/resolve', { ids, decision });
    const j = await res.json().catch(() => null);
    if (!res.ok) toast(j?.error ?? `Resolving failed (${res.status})`);
    else {
      const n = typeof j?.resolved === 'number' ? j.resolved : ids.length;
      const verb = decision === 'accept' ? 'Accepted' : 'Rejected';
      toast(n === ids.length ? `${verb} ${plural(n, 'change')}` : `${verb} ${n} of ${ids.length} — the rest changed meanwhile`);
    }
  } catch {
    toast('Resolving failed: server unreachable');
  }
  fetchReview(); // the source edit also triggers a rebuild, which refetches again
}

/** Locate a change in the PDF (forward search; the server picks the document) and in the editor. */
function revealChange(c) {
  postJSON('/forward', { file: c.file, line: c.line })
    .then((res) => {
      if (res.status === 404) toast(`${c.file}:${c.line} is not in any PDF`);
    })
    .catch(() => {});
  openFile(c.file, c.line);
}

function actionButton(label, cls, title, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(b);
  });
  return b;
}

function reviewItem(c) {
  const key = authorKey(c);
  const kind = KIND[c.kind] ?? { icon: '•', label: String(c.kind) };
  const li = el('li', `review-item kind-${c.kind}`);
  li.title = 'Show in the PDF and the editor';
  const head = el('div', 'item-head');
  head.append(chip(key), el('span', 'kind', `${kind.icon} ${kind.label}`), el('span', 'who', authorName(key)));
  head.append(el('span', 'spacer'), el('span', 'loc', `${c.file}:${c.line}`));
  const actions = el('div', 'item-actions');
  if (c.kind === 'comment') {
    actions.append(actionButton('Resolve', 'accept', 'Remove this comment from the source', () => resolve([c.id], 'accept')));
  } else {
    actions.append(
      actionButton('Accept', 'accept', 'Keep the new text and drop the markup', () => resolve([c.id], 'accept')),
      actionButton('Reject', 'reject', 'Restore the old text and drop the markup', () => resolve([c.id], 'reject')),
    );
  }
  li.append(head, snippet(c));
  // The `comment=` key: the proofreader's reason, or a reviewer's note on a change.
  if (c.comment && c.kind !== 'comment') li.append(el('div', 'why', c.comment));
  li.append(actions);
  li.addEventListener('click', () => revealChange(c));
  return li;
}

/** A bulk button that needs a second click within CONFIRM_MS. */
function confirmButton(label, cls, title, ids, decision) {
  let timer = 0;
  return actionButton(label, cls, title, (b) => {
    if (b.classList.contains('confirm')) {
      clearTimeout(timer);
      resolve(ids, decision);
      return;
    }
    b.classList.add('confirm');
    b.textContent = `Confirm (${ids.length})`;
    timer = setTimeout(() => {
      b.classList.remove('confirm');
      b.textContent = label;
    }, CONFIRM_MS);
  });
}

function renderReview() {
  const r = state.review;
  ui.reviewBtn.hidden = !r.available;
  if (!r.available) {
    setReviewPanel(false);
    return;
  }
  const n = r.items.length;
  ui.reviewCount.textContent = `(${n})`;
  ui.reviewBtn.classList.toggle('has-items', n > 0);
  ui.reviewBtn.title = `${plural(n, 'open change')} and comments (LaTeX changes package)`;

  const byAuthor = new Map();
  for (const c of r.items) {
    const key = authorKey(c);
    if (!byAuthor.has(key)) byAuthor.set(key, []);
    byAuthor.get(key).push(c);
  }
  if (r.filter && !byAuthor.has(r.filter)) r.filter = '';
  const options = [el('option', null, `All authors (${n})`)];
  options[0].value = '';
  for (const [key, list] of byAuthor) {
    const o = el('option', null, `${authorName(key)} (${list.length})`);
    o.value = key;
    options.push(o);
  }
  ui.reviewFilter.replaceChildren(...options);
  ui.reviewFilter.value = r.filter;
  ui.reviewFilter.hidden = byAuthor.size < 2 && !r.filter;

  const authorRows = [];
  for (const [key, list] of byAuthor) {
    if (r.filter && key !== r.filter) continue;
    const ids = list.map((c) => c.id);
    const li = el('li', 'review-author');
    li.append(chip(key), el('span', 'who', authorName(key)), el('span', 'count', `${list.length}`), el('span', 'spacer'));
    li.append(
      confirmButton('Accept all', 'accept', `Accept every change by ${authorName(key)} (comments are removed)`, ids, 'accept'),
      confirmButton('Reject all', 'reject', `Reject every change by ${authorName(key)} (comments are removed)`, ids, 'reject'),
    );
    authorRows.push(li);
  }
  ui.reviewAuthors.replaceChildren(...authorRows);

  const visible = r.filter ? (byAuthor.get(r.filter) ?? []) : r.items;
  const byFile = new Map();
  for (const c of visible) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }
  const rows = [];
  for (const [file, list] of byFile) {
    const head = el('li', 'review-file');
    head.append(el('span', null, file), el('span', 'count', `${list.length}`));
    rows.push(head, ...list.sort((a, b) => a.line - b.line).map(reviewItem));
  }
  ui.reviewList.replaceChildren(...rows);
  ui.reviewEmpty.hidden = visible.length > 0;
}

function setReviewPanel(open) {
  ui.reviewPanel.hidden = !open;
  ui.reviewBtn.setAttribute('aria-pressed', String(open));
  if (open) setPanel(false);
}

// ---------------------------------------------------------------- server events

let reconnectTimer = 0;

function parse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function connect() {
  // `?doc=` asks the server to build the document on screen first.
  const es = new EventSource(docURL('/events'));
  es.addEventListener('open', () => {
    setConnected(true);
    // The server may have restarted with or without an omp block, other documents or review support.
    fetchCaps();
    fetchDocs();
    fetchReview();
  });
  es.addEventListener('status', (e) => {
    setConnected(true);
    const s = parse(e.data);
    if (s && typeof s === 'object') onStatus(s);
  });
  es.addEventListener('reveal', (e) => {
    const r = parse(e.data);
    if (r) onReveal(r);
  });
  es.addEventListener('error', () => {
    setConnected(false);
    // EventSource retries by itself unless the server answered with an error status.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1500);
    }
  });
}

// ---------------------------------------------------------------- help popover & first-run tip

/** Rows of `[keys or gesture, what it does]` under a heading. */
function helpSection(title, rows) {
  const sec = el('section', 'help-section');
  const dl = el('dl');
  for (const [keys, what] of rows) dl.append(el('dt', null, keys), el('dd', null, what));
  sec.append(el('h3', null, title), dl);
  return sec;
}

/** Describes what this viewer, with this server's capabilities, actually does. */
function renderHelp() {
  const c = state.caps;
  const bar = [c.editor && 'Source', (c.agent || c.proofread) && 'Proofread', c.agent && 'Ask omp…', c.dictation && '🎙 Dictate'].filter(Boolean);
  const viewerRows = [
    [`${MOD}click`, c.editor ? 'open the source of that spot in the editor' : "print that spot's source file:line in the dev terminal"],
    ['Right-click', 'actions for the selection or that spot'],
    [`${IS_MAC ? '⇧' : 'Shift+'}F10`, 'the same menu from the keyboard (also the menu key)'],
    [`${IS_MAC ? '⇧/⌥' : 'Shift/Alt'} right-click`, "the browser's own menu (Copy link…)"],
  ];
  if (bar.length) viewerRows.push(['Drag or double-click', `select text: a bar offers ${bar.join(' · ')}`]);
  if (c.dictation) {
    const ready = c.dictation.ready ? '' : ` (first: ${c.dictation.hint || 'run `omp setup speech`'})`;
    viewerRows.push(['D', `with the bar open: 🎙 Dictate — speak, then Enter or D puts your words after the selection as a suggestion in ✎ Review; Esc cancels${ready}`]);
  }
  viewerRows.push(['Esc', 'close the bar, panels and this help; cancel a dictation']);
  if (state.docs.length > 1) viewerRows.push([`${ALT}1–9  ${ALT}[  ${ALT}]`, 'switch document: by number, previous, next']);
  viewerRows.push(
    [`${MOD}+  ${MOD}−`, `zoom in / out (also pinch or ${MOD}scroll)`],
    [`${MOD}0`, 'fit width (also a click on the zoom %)'],
    ['?', 'this help'],
  );
  const toolbarRows = [
    ['↻', 'rebuild now'],
    ['errors / warnings', `list diagnostics; a row opens its source${c.agent ? ', Fix sends it to omp' : ''}`],
  ];
  if (c.history) toolbarRows.push(['± Changes', 'redline PDF since the last commit or a checkpoint']);
  toolbarRows.push(['✎ Review', 'tracked changes and comments: accept, reject, jump to them'], ['⤓', 'open the PDF in the system PDF app']);
  if (c.popout && state.docs.length > 1) toolbarRows.push(['⧉', 'on a document tab: show that document in another browser block']);
  const sections = [helpSection('In the viewer', viewerRows), helpSection('Toolbar', toolbarRows)];
  if (c.keys?.length) {
    const rows = c.keys.map((k) => [k.display, `${k.title} — ${k.hint}`]);
    rows.push(['Palette', 'type ternlatex for every command']);
    sections.push(helpSection('In the editor (Tern)', rows));
  }
  ui.help.replaceChildren(...sections);
}

function setHelp(open) {
  if (open) {
    renderHelp();
    dismissTip(); // found the keys
  }
  ui.help.hidden = !open;
  ui.helpBtn.setAttribute('aria-expanded', String(open));
}

function tipDismissed() {
  try {
    return localStorage.getItem(TIP_KEY) === '1';
  } catch {
    return true; // no storage: the tip could never go away
  }
}

/** The first-run tip names the selection actions and the editor's show-in-PDF key this server offers. */
function updateTip() {
  if (tipDismissed()) {
    ui.tip.hidden = true;
    return;
  }
  const c = state.caps;
  const actions = [(c.agent || c.proofread) && 'Proofread', c.agent && 'Ask omp', c.dictation && 'Dictate (D, speak, Enter)'].filter(Boolean);
  const show = c.keys?.find((k) => k.id === 'show-in-pdf');
  ui.tipText.textContent = [
    actions.length ? `Select text for ${actions.join(' · ')}.` : '',
    show ? `${show.display} in the editor shows the caret here.` : '',
    'Press ? for all keys.',
  ].filter(Boolean).join(' ');
  ui.tip.hidden = false;
}

function dismissTip() {
  try {
    localStorage.setItem(TIP_KEY, '1');
  } catch {
    // Not persisted; hidden for this page at least.
  }
  ui.tip.hidden = true;
}

// ---------------------------------------------------------------- right-click menu

const LIVE_ONLY = 'Works on the live PDF — click “Back to live” first';
const NATIVE_MENU_HINT = `Hold ${IS_MAC ? '⇧ or ⌥' : 'Shift or Alt'} while right-clicking for the browser's menu`;

/**
 * What the menu acts on.
 * @typedef {object} CtxTarget
 * @property {PageRec|null} page page under the point
 * @property {number} x client x of the point
 * @property {number} y client y of the point
 * @property {SelInfo|null} sel the selection, when the point lies in it (keyboard: any selection)
 */

let ctxKeyOpened = false; // the menu key / Shift+F10 opened the menu: swallow the contextmenu event that may follow
let ctxReturnFocus = null;

function closeCtxMenu({ refocus = false } = {}) {
  if (ui.ctxMenu.hidden) return;
  ui.ctxMenu.hidden = true;
  ui.ctxMenu.replaceChildren();
  const back = ctxReturnFocus;
  ctxReturnFocus = null;
  if (refocus && back?.isConnected) back.focus({ preventScroll: true });
}

/** A row: glyph, label and key hint; `why` disables it and becomes its tooltip, like the selection bar's. */
function ctxItem(glyph, label, key, title, run, why = '') {
  const b = menuItem([el('span', 'glyph', glyph), el('span', 'label', label), el('span', 'key', key)], why || title, () => {
    closeCtxMenu();
    run();
  });
  b.disabled = Boolean(why);
  return b;
}

function ctxSep() {
  const s = el('div', 'menu-sep');
  s.setAttribute('role', 'separator');
  return s;
}

/** The selection at a client point, or null when there is none or the point is outside it. */
function selectionAt(x, y) {
  const s = document.getSelection();
  const info = readSelection(s);
  if (!info) return null;
  const near = (r) => r.width > 0 && x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
  return [...s.getRangeAt(0).getClientRects()].some(near) ? info : null;
}

/** Runs a selection-bar action on `sel`, bringing the bar up for it first when it is not. */
function onSel(sel, action) {
  if (state.sel?.page !== sel.page || state.sel?.text !== sel.text) showSelBar(sel);
  action();
}

function copySelection() {
  const text = document.getSelection()?.toString() ?? '';
  if (!text) return;
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  if (!ok) navigator.clipboard?.writeText(text).catch(() => toast(`Copy failed — try ${MOD}C`));
}

/**
 * The text line at a client point on page `p`, as a SelInfo without a range: the run of text-layer spans
 * sharing the line of the span under the point (else of the point's height), or the bare point off the text.
 */
function spotAt(p, x, y) {
  const spans = [];
  for (const s of p.div.querySelectorAll('.textLayer span:not(.markedContent)')) {
    const r = s.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && s.textContent.trim()) spans.push({ s, r });
  }
  const hit =
    spans.find(({ r }) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) ??
    spans.filter(({ r }) => y >= r.top && y <= r.bottom).sort((a, b) => Math.abs(x - (a.r.left + a.r.right) / 2) - Math.abs(x - (b.r.left + b.r.right) / 2))[0];
  if (!hit) {
    const at = clientToPdf(p, x, y);
    return { page: p.index + 1, start: at, end: at, text: '', top: clientToPdf(p, x, y - 8).y, bottom: clientToPdf(p, x, y + 8).y, range: null };
  }
  const mid = (r) => r.top + r.height / 2;
  const line = spans.filter(({ r }) => mid(r) >= hit.r.top && mid(r) <= hit.r.bottom).sort((a, b) => a.r.left - b.r.left);
  // Stop at a wide gap: the other column of a two-column page is another line.
  const gap = hit.r.height * 2;
  let lo = line.indexOf(hit);
  let hi = lo;
  while (lo > 0 && line[lo].r.left - line[lo - 1].r.right < gap) lo--;
  while (hi < line.length - 1 && line[hi + 1].r.left - line[hi].r.right < gap) hi++;
  const run = line.slice(lo, hi + 1);
  const first = run[0].r;
  const last = run.at(-1).r;
  const top = Math.min(...run.map(({ r }) => r.top));
  const bottom = Math.max(...run.map(({ r }) => r.bottom));
  return {
    page: p.index + 1,
    start: clientToPdf(p, first.left, mid(first)),
    end: clientToPdf(p, last.right, mid(last)),
    text: run.map(({ s }) => s.textContent).join(' ').replace(/\s+/g, ' ').trim().slice(0, SEL_TEXT_MAX),
    top: clientToPdf(p, first.left, top).y,
    bottom: clientToPdf(p, first.left, bottom).y,
    range: null,
  };
}

/** "Ask omp about this spot…": the bar's instruction input, for the line at the point. */
function askSpot(t) {
  document.getSelection()?.removeAllRanges();
  showSelBar(spotAt(t.page, t.x, t.y));
  ui.selInput.placeholder = 'Tell omp what to do here';
  openAsk();
}

function ctxSelItems(sel) {
  const c = state.caps;
  const why = state.docKind !== 'live' ? LIVE_ONLY : selBusy || rec ? 'Busy with the last request' : '';
  const items = [];
  if (c.editor) items.push(ctxItem('', 'Source', '', ui.selSource.title, () => onSel(sel, selSource), why));
  if (c.agent || c.proofread) items.push(ctxItem('', 'Proofread', '', ui.selProofread.title, () => onSel(sel, () => sendToAgent('proofread')), why));
  if (c.agent) items.push(ctxItem('', 'Ask omp…', '', ui.selAsk.title, () => onSel(sel, openAsk), why));
  if (c.dictation) {
    const notReady = dictationReady() ? '' : ui.selDictate.title;
    items.push(ctxItem('🎙', 'Dictate', 'D', ui.selDictate.title, () => onSel(sel, startDictation), why || notReady));
  }
  if (items.length) items.push(ctxSep());
  items.push(ctxItem('', 'Copy text', `${MOD}C`, 'Copy the selected text', copySelection));
  return items;
}

function ctxSpotItems(t) {
  const c = state.caps;
  const p = t.page;
  const where = !p ? 'Right-click on a page' : state.docKind !== 'live' ? LIVE_ONLY : '';
  // The PDF may have reloaded while the menu was open: its pages are new objects then.
  const onPage = (run) => () => {
    if (state.pages.includes(p)) run();
    else toast('The PDF changed meanwhile — right-click again');
  };
  const items = [
    ctxItem('', 'Show source here', `${MOD}click`, c.editor ? 'Open the source of this spot in the editor' : "Print this spot's source file:line in the dev terminal",
      onPage(() => sourceAt(p, t.x, t.y)), where),
  ];
  if (c.agent) {
    items.push(ctxItem('', 'Ask omp about this spot…', '', 'Tell omp what to do with the line here (type an instruction, Enter sends)',
      onPage(() => askSpot(t)), where || (selBusy || rec ? 'Busy with the last request' : '')));
  }
  items.push(ctxSep(), ctxItem('↻', 'Rebuild', '', 'Rebuild now', rebuild, rebuilding ? 'A rebuild is running' : ''));
  if (c.history) items.push(ctxItem('±', 'Changes', '', ui.changesBtn.title, openChangesMenu));
  if (state.review.available) items.push(ctxItem('✎', 'Review', '', ui.reviewBtn.title, () => setReviewPanel(ui.reviewPanel.hidden)));
  items.push(ctxItem('⤓', 'Open in PDF app', '', ui.download.title || 'Open the PDF in the system PDF app', openPdfApp, ui.download.hidden ? 'No PDF yet' : ''));
  if (c.popout && state.docs.length > 1 && state.docName) {
    const name = state.docName;
    items.push(ctxItem('⧉', 'Pop out document', '', `Open ${name} in another browser block`, () => popout(name)));
  }
  items.push(ctxSep(), ctxItem('', 'Keyboard shortcuts', '?', 'Keys and gestures', () => setHelp(true)));
  return items;
}

/** Opens the menu at the target's point, kept inside the window. */
function openCtxMenu(t, keyboard) {
  const active = document.activeElement;
  ctxReturnFocus = active instanceof HTMLElement && active !== document.body && !ui.ctxMenu.contains(active) ? active : ctxReturnFocus;
  closeChangesMenu();
  const m = ui.ctxMenu;
  m.replaceChildren(...(t.sel ? ctxSelItems(t.sel) : ctxSpotItems(t)), ctxSep(), el('div', 'menu-foot', NATIVE_MENU_HINT));
  m.hidden = false;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = m.offsetWidth;
  const h = m.offsetHeight;
  const left = t.x + w + 4 <= vw ? t.x : t.x - w;
  const top = t.y + h + 4 <= vh ? t.y : t.y - h;
  m.style.left = `${Math.round(Math.max(4, Math.min(left, vw - w - 4)))}px`;
  m.style.top = `${Math.round(Math.max(4, Math.min(top, vh - h - 4)))}px`;
  const first = ctxEnabledItems()[0];
  if (keyboard && first) first.focus({ preventScroll: true });
  else m.focus({ preventScroll: true });
}

function ctxEnabledItems() {
  return [...ui.ctxMenu.querySelectorAll('.menu-item:not(:disabled)')];
}

/** Shift+F10 / the menu key: the menu for the selection (at its end), else for the middle of the view. */
function keyboardTarget() {
  const vr = viewer.getBoundingClientRect();
  const clampX = (x) => Math.max(vr.left + 8, Math.min(x, vr.right - 8));
  const clampY = (y) => Math.max(vr.top + 8, Math.min(y, vr.bottom - 8));
  const s = document.getSelection();
  const sel = readSelection(s);
  const last = sel ? [...s.getRangeAt(0).getClientRects()].filter((r) => r.width > 0 && r.height > 0).at(-1) : null;
  const x = clampX(last ? last.left : vr.left + vr.width / 2);
  const y = clampY(last ? last.bottom + 4 : vr.top + vr.height / 2);
  return { page: pageAtClient(x, last ? clampY(last.top + last.height / 2) : y), x, y, sel };
}

function onContextMenu(e) {
  if (e.shiftKey || e.altKey) return; // the escape hatch: the browser's own menu
  if (!state.doc || ui.selBar.contains(e.target) || ui.dictatePill.contains(e.target)) return;
  e.preventDefault();
  const sel = selectionAt(e.clientX, e.clientY);
  const page = pageAtClient(e.clientX, e.clientY, e.target instanceof Element ? e.target : null);
  openCtxMenu({ page, x: e.clientX, y: e.clientY, sel }, false);
}

function onCtxMenuKey(e) {
  e.stopPropagation(); // the global shortcuts (?, D, Escape) stay out of the menu
  const items = ctxEnabledItems();
  const at = items.indexOf(document.activeElement);
  let to;
  if (e.key === 'ArrowDown') to = at < 0 ? 0 : (at + 1) % items.length;
  else if (e.key === 'ArrowUp') to = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  else if (e.key === 'Home') to = 0;
  else if (e.key === 'End') to = items.length - 1;
  else if (e.key === 'Enter') {
    if (at >= 0) items[at].click();
  } else if (e.key === 'Escape' || e.key === 'Tab') closeCtxMenu({ refocus: true });
  else return;
  e.preventDefault();
  if (to !== undefined) items[to]?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- wiring

viewer.addEventListener('scroll', scheduleUpdate, { passive: true });
viewer.addEventListener('scroll', onSelScroll, { passive: true });
viewer.addEventListener('scroll', scheduleViewSave, { passive: true });
window.addEventListener('pagehide', saveView);

new ResizeObserver(() => {
  if (state.fitWidth && state.pages.length) setScale(fitScale(state.pages), { fit: true });
  if (state.sel) anchorSelBar(); // pages re-center when the block width changes
  if (rec) anchorPill();
  scheduleUpdate();
}).observe(viewer);

function watchDpr() {
  const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  mq.addEventListener('change', () => {
    scheduleUpdate();
    watchDpr();
  }, { once: true });
}
watchDpr();

ui.zoomIn.addEventListener('click', () => zoomStep(1));
ui.zoomOut.addEventListener('click', () => zoomStep(-1));
ui.zoomLabel.addEventListener('click', fitWidth);

const togglePanel = () => setPanel(ui.diagPanel.hidden);
ui.errCount.addEventListener('click', togglePanel);
ui.warnCount.addEventListener('click', togglePanel);
ui.diagClose.addEventListener('click', () => setPanel(false));
ui.bannerClose.addEventListener('click', () => {
  state.bannerDismissedKey = bannerKey();
  updateBanner();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Meta' || e.key === 'Control') document.body.classList.toggle('sync-mod', isSyncModifier(e));
  // While recording, Enter or D is Done and Escape is Cancel; nothing else reacts to them.
  if (rec && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'Escape' || e.key === 'Enter' || e.key === 'd' || e.key === 'D')) {
    e.preventDefault();
    if (!e.repeat) {
      if (e.key === 'Escape') cancelDictation();
      else finishDictation();
    }
    return;
  }
  if (e.key === 'Escape') {
    setHelp(false);
    setPanel(false);
    setReviewPanel(false);
    closeChangesMenu();
    closeCtxMenu();
    if (state.sel) dismissSelBar();
    return;
  }
  const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && state.doc) {
      ctxKeyOpened = true;
      openCtxMenu(keyboardTarget(), true);
      e.preventDefault();
      return;
    }
    if (e.key === '?') {
      setHelp(ui.help.hidden);
      e.preventDefault();
      return;
    }
    if ((e.key === 'd' || e.key === 'D') && state.sel && !askOpen() && !ui.selDictate.hidden) {
      startDictation();
      e.preventDefault();
      return;
    }
  }
  // ⌘1…⌘9 belong to Tern's tabs, so documents switch with ⌥1…⌥9 (Alt on other systems) and ⌥[ / ⌥] cycle.
  // e.code, not e.key: on macOS Option+digit types a symbol (¡ ™ £ …).
  if (e.altKey && !e.metaKey && !e.ctrlKey && state.docs.length > 1) {
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    const at = state.docs.findIndex((d) => d.name === state.docName);
    let target;
    if (digit) target = state.docs[Number(digit) - 1];
    else if (e.code === 'BracketLeft') target = state.docs[(at - 1 + state.docs.length) % state.docs.length];
    else if (e.code === 'BracketRight') target = state.docs[(at + 1) % state.docs.length];
    if (!target) return;
    switchDoc(target.name);
    e.preventDefault();
    return;
  }
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key;
  if (k === '+' || k === '=' || e.code === 'NumpadAdd') zoomStep(1);
  else if (k === '-' || k === '_' || e.code === 'NumpadSubtract') zoomStep(-1);
  else if (k === '0' || e.code === 'Digit0' || e.code === 'Numpad0') fitWidth();
  else return;
  e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Meta' || e.key === 'Control') document.body.classList.remove('sync-mod');
  if (e.key !== 'Escape' && !ui.selBar.contains(e.target)) scheduleSelRefresh();
});
window.addEventListener('blur', () => {
  document.body.classList.remove('sync-mod');
  selPointerDown = false;
});

// Pinch / Ctrl+wheel zoom around the pointer.
viewer.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 0.05 : 0.0025;
    const anchorY = e.clientY - viewer.getBoundingClientRect().top;
    setScale(state.scale * Math.exp(-e.deltaY * k), { anchorY });
  },
  { passive: false },
);
// WebKit trackpad pinch (Safari / WKWebView) delivers gesture events instead.
let gestureStart = 0;
viewer.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  gestureStart = state.scale;
});
viewer.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (gestureStart) setScale(gestureStart * e.scale);
});
viewer.addEventListener('gestureend', (e) => {
  e.preventDefault();
  gestureStart = 0;
});

// SyncTeX reverse search: Cmd-click (Ctrl-click elsewhere). Capture phase so links/selection never see it.
viewer.addEventListener('click', onSyncClick, true);
viewer.addEventListener(
  'mousedown',
  (e) => {
    if (ui.selBar.contains(e.target)) return;
    if (isSyncModifier(e) && e.button === 0) e.preventDefault(); // no text selection start
    // A right-click (Control-click on a Mac) keeps the selection as it is: the menu acts on it or on that spot.
    if ((e.button === 2 || (IS_MAC && e.ctrlKey && e.button === 0)) && !e.shiftKey && !e.altKey) e.preventDefault();
  },
  true,
);
viewer.addEventListener('contextmenu', onContextMenu);
viewer.addEventListener('scroll', () => closeCtxMenu(), { passive: true });
window.addEventListener('resize', () => closeCtxMenu());
window.addEventListener('blur', () => closeCtxMenu());
document.addEventListener(
  'contextmenu',
  (e) => {
    // The keyboard menu is already open; on the menu itself the browser's menu has nothing to offer.
    if (ctxKeyOpened || ui.ctxMenu.contains(e.target)) {
      ctxKeyOpened = false;
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);
document.addEventListener(
  'mousedown',
  (e) => {
    ctxKeyOpened = false;
    if (!ui.ctxMenu.contains(e.target)) closeCtxMenu();
  },
  true,
);
ui.ctxMenu.addEventListener('mousedown', (e) => e.preventDefault()); // keep the page selection and focus
ui.ctxMenu.addEventListener('keydown', onCtxMenuKey);
ui.ctxMenu.addEventListener('pointermove', (e) => {
  const item = e.target instanceof Element ? e.target.closest('.menu-item:not(:disabled)') : null;
  if (item && item !== document.activeElement) item.focus({ preventScroll: true });
});

// Selection action bar. Buttons keep the page selection (no focus change on mousedown).
document.addEventListener('selectionchange', scheduleSelRefresh);
viewer.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || (IS_MAC && e.ctrlKey) || ui.selBar.contains(e.target)) return;
  selPointerDown = true;
  selDismissed = null;
  if (state.sel) hideSelBar();
});
window.addEventListener('mouseup', () => {
  if (!selPointerDown) return;
  selPointerDown = false;
  scheduleSelRefresh();
});
ui.selBar.addEventListener('mousedown', (e) => {
  if (e.target !== ui.selInput) e.preventDefault();
});
ui.selSource.addEventListener('click', selSource);
ui.selProofread.addEventListener('click', () => sendToAgent('proofread'));
ui.selAsk.addEventListener('click', openAsk);
ui.selDictate.addEventListener('click', startDictation);
// The pill keeps the page selection and stays out of the selection bar's pointer handling.
ui.dictatePill.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
});
ui.dictateDone.addEventListener('click', finishDictation);
ui.dictateCancel.addEventListener('click', cancelDictation);
ui.selSource.title = `Show the source of this passage in the editor (${MOD}click does this for any spot)`;
ui.selInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // keep global shortcuts (Escape, zoom) out of the input
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    const instruction = ui.selInput.value.trim();
    if (instruction) sendToAgent('ask', instruction);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelAsk();
  }
});
ui.rebuild.addEventListener('click', rebuild);
ui.download.addEventListener('click', (e) => {
  e.preventDefault();
  openPdfApp();
});

// Toolbar: Changes menu, diff bar, Review panel.
ui.changesBtn.addEventListener('click', () => {
  if (ui.changesMenu.hidden) openChangesMenu();
  else closeChangesMenu();
});
ui.changesLive.addEventListener('click', () => {
  closeChangesMenu();
  exitDiff();
});
ui.changesHead.addEventListener('click', () => enterDiff('HEAD', 'last commit'));
ui.changesCustom.addEventListener('click', () => {
  ui.changesCustom.hidden = true;
  ui.changesRev.hidden = false;
  ui.changesRev.value = '';
  ui.changesRev.focus();
});
ui.changesRev.addEventListener('keydown', (e) => {
  e.stopPropagation(); // keep global shortcuts out of the input
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    const rev = ui.changesRev.value.trim();
    if (rev) enterDiff(rev, rev);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeChangesMenu();
  }
});
document.addEventListener('mousedown', (e) => {
  if (!ui.changesMenu.hidden && !ui.changesMenu.parentElement.contains(e.target)) closeChangesMenu();
  if (!ui.help.hidden && !ui.help.contains(e.target) && !ui.helpBtn.contains(e.target)) setHelp(false);
});
ui.helpBtn.addEventListener('click', () => setHelp(ui.help.hidden));
ui.tipClose.addEventListener('click', dismissTip);
ui.diffBack.addEventListener('click', exitDiff);
ui.reviewBtn.addEventListener('click', () => setReviewPanel(ui.reviewPanel.hidden));
ui.reviewClose.addEventListener('click', () => setReviewPanel(false));
ui.reviewFilter.addEventListener('change', () => {
  state.review.filter = ui.reviewFilter.value;
  renderReview();
});

window.addEventListener('hashchange', () => {
  const doc = hashParam('doc');
  const n = hashPage();
  if (doc && doc !== state.docName && docEntry(doc)) switchDoc(doc, { page: n });
  else if (n && state.doc) scrollToPage(n);
});

if (state.docName) primeView(state.docName, hashPage());
updateZoomLabel();
updateEmpty();
connect();
fetchCaps();
