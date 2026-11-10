/* preview.js — the report, shown before it is printed.

   Every Carino report opens as a preview first, in the fleet's report
   preview (carino-ui.css 18b): every control in the left column, Print at its
   foot, and on the right the very document that will print, on a sheet at
   paper width with the report's own @page margins, grey around it, and a
   dashed line where each page should end. Print / Save as PDF prints that
   frame (its document, nothing added that survives print media); the ✕, Esc
   or a click on the backdrop drops it and nothing is kept.

   The frame's document is the report exactly as reportHtml() wrote it, with
   one <style> added whose rules are all `@media screen` (the sheet laid out
   at the paper's content width, the report's own toolbar hidden because the
   dialog does its job) plus a print rule hiding the page-end lines. Its own
   script still runs: the Basic/Advanced switch here presses the report's own
   buttons, so the level printed is the one the report would have printed.

   Where pages end is the browser's decision at print time and depends on
   the paper loaded. The lines are an estimate for the paper chosen here,
   moved up to the top of anything the report asks not to split (a table
   row, a chart, a heading with what follows it), and the dialog says so.
   The paper choice only places the lines: the report still sets no paper
   size, for the reason report.js gives. */

import { PAGE_MARGIN_MM } from './report.js';

const $ = (id) => document.getElementById(id);
const t = (k) => (window.t ? window.t(k) : k);

const MM = 96 / 25.4;                                   // CSS px per mm
const PAPER = { letter: { w: 215.9, h: 279.4 }, a4: { w: 210, h: 297 } };
const PAPER_KEY = 'ping.reportPaper';
const LEVEL_KEY = 'ping.reportLevel';                   // the report's own key
const GUTTER = 16;                                      // grey either side of the sheet, px

/* Letter is what the Americas load (Carta in Mexico); A4 everywhere else. */
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'CR', 'GT', 'PA', 'DO', 'PR', 'SV', 'NI', 'HN']);

function defaultPaper() {
  try {
    const saved = localStorage.getItem(PAPER_KEY);
    if (PAPER[saved]) return saved;
  } catch (e) { /* storage blocked: fall through */ }
  const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
  const region = String(langs[0] || '').split(/[-_]/)[1];
  return region && LETTER_REGIONS.has(region.toUpperCase()) ? 'letter' : 'a4';
}

const pv = { html: '', build: null, paper: 'a4', level: '', seq: 0, back: null, bound: false, title: null };

const pageWidthPx = () => Math.round(PAPER[pv.paper].w * MM) + 2 * GUTTER;

/** The report with the preview's own style added: screen rules only, plus a
    print rule that hides the page-end lines. Pure, so it is tested in node. */
export function framedHtml(html, paper = 'a4') {
  const p = PAPER[paper] || PAPER.a4;
  const cw = (p.w - 2 * PAGE_MARGIN_MM.side).toFixed(1);
  const css = `<style id="pvStyle">
@media screen {
  html { background: #d6d8dc; }
  body { background: transparent; padding: 16px ${GUTTER}px 24px; }
  .toolbar { display: none !important; }
  .sheet { box-sizing: content-box; width: ${cw}mm; max-width: none; margin: 0 auto;
           padding: ${PAGE_MARGIN_MM.top}mm ${PAGE_MARGIN_MM.side}mm; position: relative;
           box-shadow: 0 1px 6px rgba(0,0,0,.28); }
  h2 { margin-top: 18px; }     /* the print value, so the page ends land where print puts them */
  .pv-break { position: absolute; left: 0; right: 0; height: 0; border-top: 1.5px dashed #9aa0a8; pointer-events: none; }
  .pv-break span { position: absolute; left: 8px; top: 3px; font: 10px "IBM Plex Mono", ui-monospace, monospace; color: #6b7280; }
}
@media print { .pv-break { display: none !important; } }
</style>`;
  return html.includes('</head>') ? html.replace('</head>', `${css}</head>`) : css + html;
}

function status(text) { const el = $('pvStatus'); if (el) el.textContent = text || ''; }

/* The sheet as it prints: content height per page is the paper less the
   @page margins. A cut that would fall inside something the report keeps
   whole moves up to that thing's top. Returns the cuts in sheet coordinates. */
function pageCuts(d) {
  const sheet = d.querySelector('.sheet');
  if (!sheet) return [];
  const sr = sheet.getBoundingClientRect();
  const pad = PAGE_MARGIN_MM.top * MM;
  const top0 = sr.top + pad, end = sr.bottom - pad;
  const pageH = (PAPER[pv.paper].h - 2 * PAGE_MARGIN_MM.top) * MM;
  const keep = [];
  d.querySelectorAll('tr, figure, .stat, .clean, .alert, .note, .meta > div, .legend, h1, h2, p, footer').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    // A heading is not left alone at the foot of a page (page-break-after: avoid).
    keep.push({ top: r.top, bottom: el.tagName === 'H2' ? r.bottom + 40 : r.bottom });
  });
  const cuts = [];
  let start = top0;
  while (start + pageH < end - 1 && cuts.length < 500) {
    const lim = start + pageH;
    let cut = lim;
    for (const b of keep) if (b.top > start + 1 && b.top < cut && b.bottom > lim) cut = b.top;
    cuts.push(cut);
    start = cut;
  }
  return cuts.map((c) => c - sr.top);
}

function markPages() {
  const frame = $('pvFrame');
  let d;
  try { d = frame.contentDocument; } catch (e) { d = null; }
  if (!d || !d.body) { status(''); return; }
  d.querySelectorAll('.pv-break').forEach((el) => el.remove());
  const sheet = d.querySelector('.sheet');
  const cuts = pageCuts(d);
  cuts.forEach((y, i) => {
    const line = d.createElement('div');
    line.className = 'pv-break';
    line.style.top = `${y}px`;
    const tag = d.createElement('span');
    tag.textContent = t('Page {n}').replace('{n}', i + 2);
    line.append(tag);
    sheet.append(line);
  });
  const n = cuts.length + 1;
  const paper = pv.paper === 'letter' ? t('Letter') : 'A4';
  status(`≈ ${n === 1 ? t('1 page') : t('{n} pages').replace('{n}', n)} · ${paper}`);
}

/* A stage narrower than a sheet shows the sheet scaled down, as it will
   print, rather than the report reflowed to a phone's width. Only the frame
   element is scaled; its document, which is what prints, is untouched. */
function fit() {
  const frame = $('pvFrame'), stage = $('pvStage');
  if (!frame || !stage) return;
  Object.assign(frame.style, { width: '', height: '', transform: '', transformOrigin: '' });
  const page = pageWidthPx();
  const w = stage.clientWidth;
  if (!w || w >= page) return;
  const k = w / page;
  Object.assign(frame.style, { width: `${page}px`, height: `${Math.round(stage.clientHeight / k)}px`,
    transform: `scale(${k})`, transformOrigin: '0 0' });
}

function frameLevel() {
  try { return $('pvFrame').contentDocument.body.getAttribute('data-level') || 'basic'; } catch (e) { return 'basic'; }
}

function syncOptions() {
  const level = frameLevel();
  document.querySelectorAll('#pvOpts [data-pv-level]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pvLevel === level)));
  document.querySelectorAll('#pvOpts [data-pv-paper]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pvPaper === pv.paper)));
}

function render() {
  const frame = $('pvFrame');
  const seq = ++pv.seq;
  $('pvPrint').disabled = true;
  status(t('Preparing the report…'));
  return new Promise((done) => {
    const shown = () => {
      frame.onload = null;
      if (seq !== pv.seq) { done(); return; }
      let d = null;
      try { d = frame.contentDocument; } catch (e) { /* not readable */ }
      const name = d ? d.title : '';
      $('pvName').textContent = name;
      $('pvName').title = name;
      if (d) {
        // Focus moves into the frame on a click or after Print; Esc there
        // never reaches the dialog, so the frame passes it on.
        d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
        // A rebuilt frame (paper or language change) reads the level from
        // storage; if storage is blocked, put back the level chosen here.
        if (pv.level && frameLevel() !== pv.level) {
          const btn = d.querySelector(`.toolbar [data-l="${pv.level}"]`);
          if (btn) btn.click();
        }
      }
      fit();
      syncOptions();
      markPages();
      $('pvPrint').disabled = false;
      done();
    };
    frame.onload = shown;
    // A frame that never says it loaded: go on only once the new document
    // (the one carrying the preview's style) is complete; otherwise the
    // onload handler stays attached and the real load still finishes the job.
    setTimeout(() => {
      if (frame.onload !== shown) return;
      let d = null;
      try { d = frame.contentDocument; } catch (e) { /* not readable */ }
      if (d && d.readyState === 'complete' && d.getElementById('pvStyle')) shown();
    }, 5000);
    frame.srcdoc = framedHtml(pv.html, pv.paper);
  });
}

function setLevel(level) {
  let d;
  try { d = $('pvFrame').contentDocument; } catch (e) { d = null; }
  const btn = d && d.querySelector(`.toolbar [data-l="${level}"]`);
  pv.level = level;
  if (btn) btn.click();                       // the report's own switch, so it prints what it shows
  else try { localStorage.setItem(LEVEL_KEY, level); } catch (e) { /* storage blocked */ }
  syncOptions();
  markPages();
}

function setPaper(paper) {
  if (!PAPER[paper] || paper === pv.paper) return;
  pv.paper = paper;
  try { localStorage.setItem(PAPER_KEY, paper); } catch (e) { /* storage blocked */ }
  render();
}

/* Chrome names the saved PDF after the tab's title, not the frame's, so the
   tab carries the report's title while the print dialog is up (the name the
   old new-tab report gave). print() blocks in Chrome; afterprint covers the
   browsers where it does not. */
function restoreTitle() {
  if (pv.title == null) return;
  document.title = pv.title;
  pv.title = null;
}

function printIt() {
  const frame = $('pvFrame');
  const w = frame.contentWindow;
  if (!w) return;
  let name = '';
  try { name = frame.contentDocument.title; } catch (e) { /* not readable */ }
  if (name) {
    if (pv.title == null) pv.title = document.title;
    document.title = name;
    w.addEventListener('afterprint', restoreTitle, { once: true });
  }
  w.focus();
  try { w.print(); }
  finally {
    if (!w.matchMedia || !w.matchMedia('print').matches) restoreTitle();
    $('pvPrint').focus();                   // back to the dialog, so Esc still closes it
  }
}

const isOpen = () => { const ov = $('dlgReport'); return !!ov && !ov.hidden; };

function close() {
  if (!isOpen()) return;
  $('dlgReport').hidden = true;
  onClosed();
}

function onKey(e) {
  if (e.key === 'Escape' && isOpen()) { e.preventDefault(); close(); }
}

/* The scrim sits under the pinned navbar, which stays usable; focus going
   anywhere else on the page while the preview is up comes back to it (what
   the modal <dialog> it replaced did by making the page inert). */
function onFocusIn(e) {
  const ov = $('dlgReport');
  if (!isOpen() || ov.contains(e.target)) return;
  if (e.target.closest && e.target.closest('#carinoNav, #cnAbout, #cnMoreMenu')) return;
  $('pvClose').focus();
}

function onClosed() {
  pv.seq++;
  pv.html = '';
  pv.build = null;
  pv.level = '';
  restoreTitle();
  const frame = $('pvFrame');
  if (frame) { frame.onload = null; frame.removeAttribute('srcdoc'); frame.style.cssText = ''; }
  $('pvName').textContent = '';
  status('');
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('focusin', onFocusIn);
  const back = pv.back;
  pv.back = null;
  try { if (back && back.isConnected) back.focus(); } catch (e) { /* gone */ }
}

function bind() {
  if (pv.bound) return;
  pv.bound = true;
  const ov = $('dlgReport');
  $('pvClose').addEventListener('click', close);
  $('pvPrint').addEventListener('click', printIt);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });     // the backdrop
  $('pvOpts').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pvLevel) setLevel(b.dataset.pvLevel);
    else if (b.dataset.pvPaper) setPaper(b.dataset.pvPaper);
  });
  window.addEventListener('resize', () => { if (isOpen()) fit(); });
  // The report is written in the page's language when it is built, so a
  // language change rebuilds it; a plain document can only re-mark its pages.
  window.addEventListener('carino:langchange', () => {
    if (!isOpen()) return;
    if (!pv.build) { markPages(); return; }
    try { pv.html = pv.build(); } catch (e) { markPages(); return; }
    if (!pv.level) pv.level = frameLevel();
    render();
  });
}

/** Show a report in the preview dialog. Pass the function that builds it
    with reportHtml() (rebuilt on a language change), or the built HTML. */
export function previewReport(report) {
  const ov = $('dlgReport');
  if (!ov) throw new Error('The report preview is missing from this page.');
  const build = typeof report === 'function' ? report : null;
  const html = build ? build() : String(report);      // a builder that throws leaves the dialog shut
  bind();
  pv.html = html;
  pv.build = build;
  pv.level = '';
  pv.paper = defaultPaper();
  pv.back = document.activeElement;
  // The menu item closes with its menu; focus goes back to the button that opened it.
  if (pv.back && pv.back.closest && pv.back.closest('#exportMenu')) pv.back = $('btnExport') || pv.back;
  $('pvName').textContent = '';
  if (ov.hidden) {
    ov.hidden = false;
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
  }
  $('pvClose').focus();
  return render();
}
