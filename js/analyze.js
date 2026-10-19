/* analyze.js — the Log file mode: read a saved ping log and analyze it.

   The file never leaves the tab. It is read with File.arrayBuffer(), decoded
   and parsed in a worker (parse-worker.js), and everything after that — the
   statistics, the charts, the table — is built from the parsed samples in
   memory, using the same stats.js the live view uses, so a reading means the
   same thing in both modes.

   Filters come in two kinds, on purpose:
     the time range (dragged on the chart) and the target filter scope the
     whole analysis — tiles, cards, charts, table, exports and report agree;
     status, RTT threshold and "around incidents" only filter the table rows.
     Applying a status filter to the statistics would be meaningless: "only
     timeouts" would make every target read 100 % loss.

   The table is virtualized. A week of `ping -t` is 600 000 rows, and the DOM
   only ever holds the few dozen in view. */

import { Series, combine, verdict, extremes, lossEvents } from './stats.js';
import { drawTimeChart, drawHistogram, drawLossBars, drawHeat, sparkline, seriesColor } from './viz.js';
import { exportCSV, exportSheet } from './export.js';
import { reportHtml, openReport } from './report.js';

const $ = (id) => document.getElementById(id);
const t = (k) => (window.t ? window.t(k) : k);

const STORE = 'carino-ping/log-v1';
const ROW_H = 26;
const FORMAT_NAMES = {
  linux: 'Linux (iputils)', busybox: 'BusyBox', bsd: 'macOS / BSD', windows: 'Windows',
  pwsh: 'PowerShell', csv: 'Carino Ping CSV',
};
const LANG_NAMES = {
  en: 'English', es: 'Español', pt: 'Português', ru: 'Русский', ja: '日本語', de: 'Deutsch', fr: 'Français',
};
const STATUS_LABEL = {
  ok: 'OK', timeout: 'TIMEOUT', unreachable: 'UNREACHABLE', ttl: 'TTL EXCEEDED', error: 'ERROR', dup: 'DUP',
};

const A = {
  active: false,
  res: null,             // parse result
  text: null,            // decoded text, kept for re-parsing and the raw-line tooltips
  lines: null,           // split lazily
  file: null,            // { name, size, lastModified }
  opts: { format: '', interval: 1000, dateOrder: '' },
  tab: 'time',
  logScale: false,
  range: null,           // [t0, t1] dragged on the chart
  fTarget: '',
  fStatus: 'all',
  fRtt: '',
  fAround: false,
  fAroundN: 3,
  view: null,
  geom: null,            // what the last chart draw returned, for hover and brush
  busy: false,
};

let notify = () => {};

/* ---- persistence: only the reader's preferences, never the log ----------- */

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ interval: A.opts.interval, tab: A.tab, logScale: A.logScale }));
  } catch { /* private mode */ }
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!s) return;
    if (s.interval) A.opts.interval = s.interval;
    if (s.tab) A.tab = s.tab;
    A.logScale = !!s.logScale;
  } catch { /* ignore */ }
}

/* ---- the parse, off the main thread --------------------------------------- */

let worker = null;
let reqId = 0;
const pending = new Map();

function getWorker() {
  if (worker === false) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./parse-worker.js', import.meta.url), { type: 'module' });
  } catch {
    worker = false;
    return null;
  }
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data); else p.reject(new Error(e.data.error));
  };
  // A module worker that cannot load (an old browser, file://) fails here,
  // not in the constructor. Everything waiting is re-run on the main thread.
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    worker = false;
    const waiting = [...pending.values()];
    pending.clear();
    waiting.forEach((p) => mainThread(p.payload).then(p.resolve, p.reject));
  };
  return worker;
}

async function mainThread(payload) {
  const { decode, parseLog } = await import('./parse.js');
  let text = payload.text, encoding = null;
  if (text == null) ({ text, encoding } = decode(payload.buf));
  const res = parseLog(text, payload.opts);
  res.encoding = encoding || payload.opts.encoding || null;
  return { res, text: payload.text == null ? text : null };
}

function runParse(payload) {
  const w = getWorker();
  if (!w) return mainThread(payload);
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject, payload });
    w.postMessage({ id, ...payload });     // copied, not transferred: the fallback may need it
  });
}

function parseOpts(file = A.file, fresh = false) {
  return {
    format: fresh ? undefined : A.opts.format || undefined,
    interval: A.opts.interval,
    dateOrder: fresh ? undefined : A.opts.dateOrder || undefined,
    // `ts` prints no year; the file's own date is the best guess at one.
    refYear: new Date(file && file.lastModified ? file.lastModified : Date.now()).getFullYear(),
    encoding: !fresh && A.res ? A.res.encoding : null,
  };
}

function setBusy(on, msg) {
  A.busy = on;
  $('aBusy').hidden = !on;
  if (msg) $('aBusyMsg').textContent = msg;
}

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`);

/* A new file replaces the current log only once it has parsed into something:
   a wrong file dropped on a good analysis leaves the analysis where it was. */
function adopt(out, file, text) {
  if (!usable(out.res)) { refuse(out.res); return; }
  A.file = file;
  A.text = text; A.lines = null;
  A.opts.format = ''; A.opts.dateOrder = '';
  accept(out.res);
}

export async function loadFile(file) {
  if (!file) return;
  setBusy(true, `${t('Reading')} ${file.name} · ${fmtSize(file.size)}…`);
  try {
    const buf = await file.arrayBuffer();
    const meta = { name: file.name, size: file.size, lastModified: file.lastModified };
    const out = await runParse({ buf, opts: parseOpts(meta, true) });
    adopt(out, meta, out.text);
  } catch (err) {
    notify(t('Could not read the file:') + ' ' + err.message, 'err');
  } finally {
    setBusy(false);
  }
}

async function loadText(text, name) {
  setBusy(true, t('Parsing…'));
  try {
    const meta = { name, size: new Blob([text]).size, lastModified: Date.now() };
    const out = await runParse({ text, opts: parseOpts(meta, true) });
    adopt(out, meta, text);
  } catch (err) {
    notify(err.message, 'err');
  } finally {
    setBusy(false);
  }
}

async function reparse() {
  if (A.text == null) return;
  setBusy(true, t('Parsing…'));
  try {
    const out = await runParse({ text: A.text, opts: parseOpts() });
    accept(out.res, true);
  } catch (err) {
    notify(err.message, 'err');
  } finally {
    setBusy(false);
  }
}

const usable = (res) => !!(res.format && res.samples.length);

function refuse(res) {
  notify(res.format
    ? t('The file was read, but no ping replies or timeouts were found in it.')
    : t('This does not look like ping output. Supported: Linux, BusyBox, macOS/BSD, Windows (any language), PowerShell Test-Connection and this tool\'s own CSV.'), 'err');
}

/** Take a parse result in. A fresh file with no samples never gets here (see
    adopt); a forced format that matches nothing does, and is shown empty so
    the format can be switched back. */
function accept(res, keepFilters = false) {
  if (!usable(res)) notify(t('Nothing in this file matches that format — showing it anyway, so you can switch back.'), 'warn');
  else notify('');
  for (const s of res.samples) {
    s.ok = s.status === 'ok';
    s.timedOut = s.status === 'timeout';
  }
  res.targets.forEach((tg, i) => { tg.color = seriesColor(i); });
  A.res = res;
  if (!keepFilters) {
    A.range = null; A.fTarget = ''; A.fStatus = 'all'; A.fRtt = ''; A.fAround = false;
    syncFilterUI();
  }
  if (A.tab === 'hour' && res.basis === 'estimated') A.tab = 'time';
  derive();
  render();
}

/* ---- deriving the view ---------------------------------------------------- */

function extent(res) {
  let lo = Infinity, hi = -Infinity;
  for (const s of res.samples) { if (s.at < lo) lo = s.at; if (s.at > hi) hi = s.at; }
  if (lo === Infinity) return [0, 1];
  if (hi - lo < 1000) hi = lo + 1000;
  return [lo, hi];
}

function derive() {
  const res = A.res;
  if (!res) { A.view = null; return; }
  const full = extent(res);
  const [x0, x1] = A.range || full;
  const inRange = (s) => s.at >= x0 && s.at <= x1;

  const targets = res.targets.map((tg, i) => ({
    i, label: tg.label, ip: tg.ip, color: tg.color, list: [], series: new Series(tg.label, Infinity),
  }));
  for (let k = 0; k < res.samples.length; k++) {
    const s = res.samples[k];
    if (!inRange(s)) continue;
    targets[s.tgt].list.push(k);
  }
  const visible = targets.filter((x) => (A.fTarget === '' || String(x.i) === A.fTarget) && x.list.length);
  for (const tg of visible) {
    tg.list.sort((a, b) => res.samples[a].at - res.samples[b].at || a - b);
    for (const k of tg.list) {
      const s = res.samples[k];
      if (s.status !== 'dup') tg.series.push(s);
    }
  }

  // Table rows: the analysis scope, then the table-only filters.
  let near = null;
  if (A.fAround) {
    near = new Set();
    const N = Math.max(0, A.fAroundN | 0);
    for (const tg of visible) {
      const L = tg.list;
      for (let p = 0; p < L.length; p++) {
        const st = res.samples[L[p]].status;
        if (st === 'ok' || st === 'dup') continue;
        for (let q = Math.max(0, p - N); q <= Math.min(L.length - 1, p + N); q++) near.add(L[q]);
      }
    }
  }
  const vis = new Set(visible.map((x) => x.i));
  const rttMin = A.fRtt === '' ? null : Number(A.fRtt);
  const rows = [];
  for (let k = 0; k < res.samples.length; k++) {
    const s = res.samples[k];
    if (!vis.has(s.tgt) || !inRange(s)) continue;
    if (A.fStatus === 'replies' && s.status !== 'ok') continue;
    if (A.fStatus === 'lost' && (s.status === 'ok' || s.status === 'dup')) continue;
    if (!['all', 'replies', 'lost'].includes(A.fStatus) && s.status !== A.fStatus) continue;
    if (rttMin != null && !Number.isNaN(rttMin) && !(s.rtt != null && s.rtt >= rttMin)) continue;
    if (near && !near.has(k)) continue;
    rows.push(k);
  }
  A.view = { targets, visible, rows, x0, x1, full };
}

/* ---- time formatting by basis ----------------------------------------------- */

const pad2 = (n) => String(n).padStart(2, '0');

function elapsed(ms, withMs = false) {
  const neg = ms < 0; ms = Math.abs(ms);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  const tail = withMs ? '.' + String(Math.floor(ms % 1000)).padStart(3, '0') : '';
  return `${neg ? '-' : '+'}${pad2(h)}:${pad2(m)}:${pad2(s)}${tail}`;
}

function clockParts(at) {
  const d = new Date(at);
  return { day: Math.floor(at / 86400000) + 1, h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

/** A timestamp for the table, tooltips and the report. */
function fmtTime(at) {
  const res = A.res;
  if (!res) return '';
  if (res.basis === 'estimated') return elapsed(at);
  if (res.basis === 'clock') {
    const c = clockParts(at);
    const multi = A.view && A.view.full[1] >= 86400000;
    return `${multi ? `D${c.day} ` : ''}${pad2(c.h)}:${pad2(c.m)}:${pad2(c.s)}`;
  }
  const d = new Date(at);
  const multi = A.view && A.view.full[1] - A.view.full[0] > 20 * 3600000;
  const hms = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return multi ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hms}` : hms;
}

/** Axis labels, coarser the bigger the step. */
function makeFmtX() {
  const res = A.res;
  const lang = document.documentElement.lang || 'en';
  if (res.basis === 'estimated') {
    const f = (v, step) => {
      const s = elapsed(v);
      return step >= 60000 ? s.slice(0, -3) : s;
    };
    f.utc = true;
    return f;
  }
  if (res.basis === 'clock') {
    const f = (v, step) => {
      const c = clockParts(v);
      const hm = `${pad2(c.h)}:${pad2(c.m)}`;
      if (step >= 86400000) return `D${c.day}`;
      return step < 60000 ? `${hm}:${pad2(c.s)}` : (c.h === 0 && c.m === 0 && c.day > 1 ? `D${c.day}` : hm);
    };
    f.utc = true;
    return f;
  }
  return (v, step) => {
    const d = new Date(v);
    if (step >= 86400000) return d.toLocaleDateString(lang, { month: 'short', day: 'numeric' });
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (step < 60000) return `${hm}:${pad2(d.getSeconds())}`;
    if (d.getHours() === 0 && d.getMinutes() === 0) return d.toLocaleDateString(lang, { month: 'short', day: 'numeric' });
    return hm;
  };
}

function exportStamp(at) {
  const res = A.res;
  if (res.basis === 'estimated') return elapsed(at, true);
  if (res.basis === 'clock') {
    const c = clockParts(at);
    return `D${c.day} ${pad2(c.h)}:${pad2(c.m)}:${pad2(c.s)}.${String(Math.floor(at % 1000)).padStart(3, '0')}`;
  }
  return new Date(at).toISOString();
}

function spanText(a, b) {
  const ms = Math.max(0, b - a);
  if (ms < 120000) return `${Math.round(ms / 1000)} s`;
  if (ms < 7200000) return `${Math.round(ms / 60000)} min`;
  if (ms < 172800000) return `${(ms / 3600000).toFixed(1)} h`;
  return `${(ms / 86400000).toFixed(1)} d`;
}

function basisText(res) {
  if (res.basis === 'absolute') return t('Time: from the log');
  if (res.basis === 'clock') return t('Time: time of day only');
  return t('Time: estimated');
}
function basisTitle(res) {
  if (res.basis === 'absolute') return t('Every line carried a date and time (ping -D, or a timestamp added by a wrapper), so the time axis is real.');
  if (res.basis === 'clock') return t('The lines carry a time of day but no date. Days are counted from the first line, rolling over at midnight.');
  return t('This log has no clock: the time axis is the sequence number times the interval you choose here. Durations are close; times of day are unknown.');
}

/* ---- rendering ------------------------------------------------------------ */

const ms = (v, dp = 1) => (v == null ? '—' : `${v.toFixed(dp)} ms`);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render() {
  const has = !!A.res;
  $('aEmpty').hidden = has;
  $('aLoaded').hidden = !has;
  if (!has) { setVerdict(null); return; }
  renderSource();
  renderTiles();
  renderCards();
  renderChartHead();
  drawChartNow();
  renderTableHead();
  renderRows(true);
}

function setVerdict(sum) {
  if (!A.active) return;
  const el = $('verdict');
  if (!sum) { el.textContent = t('No data'); el.title = t('No data yet.'); el.dataset.key = 'idle'; return; }
  const v = verdict(sum);
  el.textContent = t(v.short);
  el.title = t(v.text);
  el.dataset.key = v.key;
}

function renderSource() {
  const res = A.res;
  $('aFile').textContent = A.file ? A.file.name : '';
  $('aFile').title = A.file ? `${A.file.name} · ${fmtSize(A.file.size)} · ${res.encoding || 'UTF-8'} · ${res.lineCount} ${t('lines')}` : '';
  $('aFileMeta').textContent = A.file ? `${fmtSize(A.file.size)} · ${res.encoding || 'UTF-8'}` : '';

  const sel = $('aFormat');
  const det = res.format ? FORMAT_NAMES[res.format] + (res.lang ? ` · ${LANG_NAMES[res.lang] || res.lang}` : '') : '—';
  sel.options[0].textContent = A.opts.format ? t('Auto') : `${t('Auto')}: ${det}`;
  sel.value = A.opts.format;

  $('aBasis').textContent = basisText(res);
  $('aBasis').title = basisTitle(res);
  $('aBasis').dataset.basis = res.basis;
  $('aInterval').hidden = res.basis !== 'estimated';
  $('aInterval').value = String(A.opts.interval);
  $('aDateOrder').hidden = !res.dateAmbiguous;
  $('aDateOrder').value = A.opts.dateOrder || res.dateOrder || 'dmy';

  const checks = checkStats();
  const chk = $('aCheck');
  chk.hidden = !checks.checked;
  chk.classList.toggle('bad', checks.checked > checks.matched);
  chk.classList.toggle('good', checks.checked > 0 && checks.checked === checks.matched);
  chk.textContent = checks.checked === checks.matched
    ? `✓ ${t('Summary check')} ${checks.matched}/${checks.checked}`
    : `⚠ ${checks.checked - checks.matched} ${t('of')} ${checks.checked} ${t('summaries disagree')}`;
  chk.title = t('Where ping printed its own summary, the parsed counts and min/avg/max are compared against it. Click for details.');

  const un = $('aUnparsed');
  un.hidden = !res.unparsedCount;
  un.textContent = `${res.unparsedCount} ${t('unrecognised')}`;
}

function checkStats() {
  const res = A.res;
  let checked = 0, matched = 0;
  const issues = [];
  for (const s of res.sessions) {
    if (!s.check) continue;
    checked++;
    if (s.check.ok) { matched++; continue; }
    issues.push({
      line: s.startLine,
      target: s.label,
      text: s.check.issues.map((x) => `${t(x.what)}: ping ${fmtNum(x.ping)} · ${t('parsed')} ${fmtNum(x.ours)}`).join('; '),
    });
  }
  return { checked, matched, issues };
}
const fmtNum = (v) => (v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(3));

function renderTiles() {
  const v = A.view;
  const sum = combine(v.visible.map((x) => x.series));
  $('aBest').textContent = ms(sum.min);
  $('aP50').textContent = ms(sum.p50);
  $('aP95').textContent = ms(sum.p95);
  $('aJitter').textContent = ms(sum.jitter);
  $('aLoss').textContent = sum.sent ? `${sum.loss.toFixed(sum.loss && sum.loss < 0.1 ? 2 : 1)} %` : '—';
  $('aLossSub').textContent = sum.sent ? `${sum.lost} ${t('of')} ${sum.sent}` : t('none sent');
  $('aSent').textContent = String(sum.sent);
  $('aSpan').textContent = spanText(v.x0, v.x1);
  $('aSpanSub').textContent = A.range ? t('selected range') : (A.res.basis === 'estimated' ? t('estimated') : t('whole log'));
  const tile = $('aTileLoss');
  tile.classList.toggle('bad', sum.loss >= 5);
  tile.classList.toggle('warn', sum.loss > 0 && sum.loss < 5);
  setVerdict(sum);
}

/** Who answered, and whether the route changed: both visible in the samples. */
function targetFacts(tg) {
  const res = A.res;
  const from = new Map();
  const ttls = [];
  let prevTtl = null, ttlChanges = 0;
  for (const k of tg.list) {
    const s = res.samples[k];
    if (s.from) from.set(s.from, (from.get(s.from) || 0) + 1);
    if (s.status === 'ok' && s.ttl != null) {
      if (prevTtl != null && s.ttl !== prevTtl) { ttlChanges++; if (ttls.length < 6) ttls.push(`${prevTtl}→${s.ttl}`); }
      prevTtl = s.ttl;
    }
  }
  return { from: [...from.entries()].sort((a, b) => b[1] - a[1]), ttlChanges, ttls };
}

function renderCards() {
  const res = A.res;
  const v = A.view;
  const wrap = $('aCards');
  if (!v.visible.length) {
    wrap.innerHTML = `<p class="muted">${esc(t('No samples in the selected range.'))}</p>`;
    return;
  }
  const sessByTgt = new Map();
  for (const s of res.sessions) {
    if (!sessByTgt.has(s.tgt)) sessByTgt.set(s.tgt, []);
    sessByTgt.get(s.tgt).push(s);
  }
  wrap.innerHTML = v.visible.map((tg) => {
    const s = tg.series.snapshot();
    const lossCls = s.loss >= 5 ? 'bad' : s.loss > 0 ? 'warn' : '';
    const facts = targetFacts(tg);
    const sess = sessByTgt.get(tg.i) || [];
    const chk = sess.filter((x) => x.check);
    const bad = chk.filter((x) => !x.check.ok);
    const devs = chk.map((x) => x.check.dev).filter((x) => x != null);
    // 60 buckets of the in-range samples, mean per bucket, null when a bucket
    // only lost — the sparkline breaks there, as on the live cards.
    const pts = [];
    const L = tg.list;
    const B = Math.min(60, L.length);
    for (let b = 0; b < B; b++) {
      const a = Math.floor((b * L.length) / B), e = Math.floor(((b + 1) * L.length) / B);
      let sum = 0, n = 0;
      for (let q = a; q < e; q++) { const x = res.samples[L[q]]; if (x.status === 'ok' && x.rtt != null) { sum += x.rtt; n++; } }
      pts.push(n ? sum / n : null);
    }
    const others = facts.from.filter(([addr]) => addr && addr !== tg.ip && !addr.includes(`(${tg.ip})`) && !addr.endsWith(tg.ip));
    const fromTitle = facts.from.slice(0, 8).map(([a, n]) => `${a} · ${n}`).join('\n');
    return `<article class="tcard">
      <header>
        <span class="dot" style="background:${tg.color}"></span>
        <span class="tname" title="${esc(tg.label)}${tg.ip ? ' · ' + esc(tg.ip) : ''}">${esc(tg.label)}</span>
        ${tg.ip && tg.ip !== tg.label ? `<span class="chip" title="${esc(t('Address the log resolved this target to'))}">${esc(tg.ip)}</span>` : ''}
      </header>
      <div class="tgrid">
        <div><label>${t('Best')}</label><b class="num">${ms(s.min)}</b></div>
        <div><label>p50</label><b class="num">${ms(s.p50)}</b></div>
        <div><label>p95</label><b class="num">${ms(s.p95)}</b></div>
        <div><label>${t('Jitter')}</label><b class="num">${ms(s.jitter)}</b></div>
        <div class="${lossCls}"><label>${t('Loss')}</label><b class="num">${s.sent ? s.loss.toFixed(1) + ' %' : '—'}</b></div>
        <div><label>${t('Sent')}</label><b class="num">${s.sent}</b></div>
      </div>
      ${sparkline(pts, tg.color)}
      <ul class="facts">
        <li title="${esc(t('Standard deviation of the replies. ping prints this as mdev (Linux) or stddev (macOS); the Jitter above is RFC 3550 — the mean change between consecutive replies — and is a different number.'))}">${t('Std dev')} <b>${ms(s.stdev, 2)}</b>${devs.length ? ` · ping mdev <b>${ms(devs.reduce((a, b) => a + b, 0) / devs.length, 2)}</b>` : ''}</li>
        ${sess.length > 1 ? `<li>${sess.length} ${t('runs in this log')}</li>` : ''}
        ${chk.length ? `<li class="${bad.length ? 'bad' : 'good'}" title="${esc(bad.length ? bad.map((x) => `${t('line')} ${x.startLine}: ` + x.check.issues.map((i) => `${t(i.what)} ping ${fmtNum(i.ping)} / ${fmtNum(i.ours)}`).join(', ')).join('\n') : t('Parsed counts and min/avg/max agree with what ping printed.'))}">${bad.length ? `⚠ ${bad.length} ${t('of')} ${chk.length} ${t('summaries disagree')}` : `✓ ${t('matches ping\'s summary')}${chk.length > 1 ? ` (${chk.length})` : ''}`}</li>` : ''}
        ${others.length ? `<li class="warn" title="${esc(fromTitle)}">${t('Also answered by')} <b>${esc(others[0][0])}</b>${others.length > 1 ? ` +${others.length - 1}` : ''}</li>` : ''}
        ${facts.ttlChanges ? `<li class="warn" title="${esc(t('A change in TTL means the replies took a different number of hops — the route changed.'))}">${t('TTL changed')} ${facts.ttlChanges}× <b>${esc(facts.ttls.slice(0, 3).join(', '))}</b></li>` : ''}
      </ul>
    </article>`;
  }).join('');
}

/* ---- chart ---------------------------------------------------------------- */

function renderChartHead() {
  const res = A.res;
  document.querySelectorAll('#aTabs [data-tab]').forEach((b) => {
    const on = b.dataset.tab === A.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    if (b.dataset.tab === 'hour') {
      b.disabled = res.basis === 'estimated';
      b.title = b.disabled ? t('Needs a log with times of day — this one has none.') : t('Median round trip and loss by hour of day');
    }
  });
  $('aLogScale').hidden = !(A.tab === 'time');
  $('aLogScale').classList.toggle('active', A.logScale);
  const chip = $('aRange');
  chip.hidden = !A.range;
  if (A.range) $('aRangeText').textContent = `${fmtTime(A.range[0])} – ${fmtTime(A.range[1])}`;

  // Legend: identity is never colour alone, and the cards may be scrolled away.
  const lg = $('aLegend');
  lg.textContent = '';
  if (A.view.visible.length > 1 && A.tab !== 'hour') {
    for (const tg of A.view.visible) {
      const it = document.createElement('span');
      it.className = 'lg-item';
      const key = document.createElement('i');
      key.style.background = tg.color;
      it.append(key, document.createTextNode(tg.label));
      lg.append(it);
    }
  }
}

function lossBucket(span) {
  const steps = [5, 10, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 86400].map((s) => s * 1000);
  const floor = A.res.interval * 5;
  return steps.find((s) => s >= floor && span / s <= 240) || steps[steps.length - 1];
}
const bucketName = (b) => (b < 60000 ? `${b / 1000} s` : b < 3600000 ? `${b / 60000} min` : b < 86400000 ? `${b / 3600000} h` : t('day'));

function drawChartNow() {
  const res = A.res, v = A.view;
  if (!res || !v) return;
  const canvas = $('aChart');
  const fmtX = makeFmtX();
  const empty = t('No samples in the selected range.');
  hideTip();
  if (A.tab === 'time' || A.tab === 'ttl') {
    const ttl = A.tab === 'ttl';
    const series = v.visible.map((tg) => {
      const T = [], V = [];
      for (const k of tg.list) {
        const s = res.samples[k];
        if (s.status === 'dup') continue;
        if (ttl) { if (s.status === 'ok' && s.ttl != null) { T.push(s.at); V.push(s.ttl); } continue; }
        T.push(s.at);
        V.push(s.status === 'ok' && s.rtt != null ? s.rtt : NaN);
      }
      return { label: tg.label, color: tg.color, t: T, v: V };
    });
    A.geom = drawTimeChart(canvas, series, {
      x0: v.x0, x1: v.x1, log: !ttl && A.logScale, unit: ttl ? 'TTL' : 'ms', integer: ttl, loss: !ttl,
      fmtX, sel: A.drag ? [A.drag.a, A.drag.b] : null,
      empty: ttl ? t('This log records no TTL.') : empty,
    });
    A.geom && (A.geom.kind = ttl ? 'ttl' : 'time');
    $('aChartNote').textContent = ttl
      ? t('TTL of each reply. A step means the replies crossed a different number of routers.')
      : (series.some((s) => s.t.length > 2 * canvas.clientWidth)
        ? t('Each pixel column is a bucket: the band is its min–max, the line its mean. Red rules mark lost probes.')
        : t('Red rules mark lost probes. Drag across the chart to zoom into a time range.'));
  } else if (A.tab === 'dist') {
    const series = v.visible.map((tg) => ({ label: tg.label, color: tg.color, values: tg.series.rtts }));
    A.geom = drawHistogram(canvas, series, { empty });
    A.geom && (A.geom.kind = 'dist');
    $('aChartNote').textContent = t('Share of each target\'s replies per round-trip bin. The last bin collects everything above the 99th percentile.');
  } else if (A.tab === 'loss') {
    const b = lossBucket(v.x1 - v.x0);
    const start = Math.floor(v.x0 / b) * b;
    const n = Math.max(1, Math.ceil((v.x1 - start) / b) + 1);
    const buckets = Array.from({ length: n }, (_, i) => ({ t0: start + i * b, t1: start + (i + 1) * b, sent: 0, lost: 0 }));
    for (const tg of v.visible) for (const k of tg.list) {
      const s = res.samples[k];
      if (s.status === 'dup') continue;
      const bi = Math.floor((s.at - start) / b);
      if (bi < 0 || bi >= n) continue;
      buckets[bi].sent++;
      if (s.status !== 'ok') buckets[bi].lost++;
    }
    A.geom = drawLossBars(canvas, buckets, { x0: v.x0, x1: v.x1, fmtX, empty });
    A.geom && (A.geom.kind = 'loss');
    $('aChartNote').textContent = `${t('Share of probes lost per')} ${bucketName(b)}, ${t('all shown targets pooled.')}`;
  } else if (A.tab === 'hour') {
    const hourOf = res.basis === 'clock'
      ? (at) => Math.floor((((at % 86400000) + 86400000) % 86400000) / 3600000)
      : (at) => new Date(at).getHours();
    const rows = v.visible.map((tg) => {
      const cells = Array.from({ length: 24 }, () => ({ n: 0, lost: 0, rtts: [] }));
      for (const k of tg.list) {
        const s = res.samples[k];
        if (s.status === 'dup') continue;
        const c = cells[hourOf(s.at)];
        c.n++;
        if (s.status === 'ok' && s.rtt != null) c.rtts.push(s.rtt); else if (s.status !== 'ok') c.lost++;
      }
      for (const c of cells) {
        c.rtts.sort((a, b) => a - b);
        c.p50 = c.rtts.length ? c.rtts[Math.ceil(c.rtts.length / 2) - 1] : null;
        c.p95 = c.rtts.length ? c.rtts[Math.min(c.rtts.length - 1, Math.ceil(c.rtts.length * 0.95) - 1)] : null;
        delete c.rtts;
      }
      return { label: tg.label, color: tg.color, cells };
    });
    A.geom = drawHeat(canvas, rows, { empty });
    A.geom && (A.geom.kind = 'hour');
    $('aChartNote').textContent = t('Median round trip by hour of day — brighter is slower than that target usually is. A red outline means that hour lost probes; the figure is the share lost.');
  }
}

/* hover + brush */

function hideTip() {
  $('aTip').hidden = true;
  $('aCross').hidden = true;
}

function tipRow(color, value, label) {
  const r = document.createElement('div');
  r.className = 'tip-row';
  const k = document.createElement('i');
  k.style.background = color;
  const b = document.createElement('b');
  b.textContent = value;
  const s = document.createElement('span');
  s.textContent = label;
  r.append(k, b, s);
  return r;
}

function showTip(px, py) {
  const g = A.geom;
  if (!g || A.drag) return;
  const h = g.hit(px, py);
  const tip = $('aTip');
  if (!h) { hideTip(); return; }
  tip.textContent = '';
  const head = document.createElement('div');
  head.className = 'tip-head';
  if (g.kind === 'time' || g.kind === 'ttl') {
    head.textContent = `${fmtTime(h.t0)} – ${fmtTime(h.t1)}`;
    tip.append(head);
    for (const r of h.rows) {
      if (!r.cnt && !r.lost) continue;
      const val = g.kind === 'ttl'
        ? (r.cnt ? (r.mn === r.mx ? `TTL ${r.mn}` : `TTL ${r.mn}–${r.mx}`) : '—')
        : (r.cnt ? ms(r.mean) : t('lost'));
      const extra = g.kind === 'ttl' ? r.label
        : `${r.label}${r.cnt > 1 ? ` · ${r.mn.toFixed(1)}–${r.mx.toFixed(1)}` : ''}${r.lost ? ` · ${r.lost} ${t('lost')}` : ''}`;
      tip.append(tipRow(r.color, val, extra));
    }
    const cross = $('aCross');
    cross.hidden = false;
    cross.style.left = `${h.x}px`;
  } else if (g.kind === 'dist') {
    head.textContent = h.b === Infinity ? `≥ ${h.a.toFixed(1)} ms` : `${h.a.toFixed(1)} – ${h.b.toFixed(1)} ms`;
    tip.append(head);
    for (const r of h.rows) tip.append(tipRow(r.color, `${r.share.toFixed(1)} %`, r.label));
    $('aCross').hidden = true;
  } else if (g.kind === 'loss') {
    const b = h.bucket;
    head.textContent = `${fmtTime(b.t0)} – ${fmtTime(b.t1)}`;
    tip.append(head, tipRow(getComputedStyle(document.documentElement).getPropertyValue('--err').trim() || '#ef4444',
      `${((b.lost / b.sent) * 100).toFixed(1)} %`, `${b.lost} ${t('of')} ${b.sent} ${t('lost')}`));
    $('aCross').hidden = true;
  } else if (g.kind === 'hour') {
    const c = h.cell;
    head.textContent = `${pad2(h.hour)}:00 – ${pad2(h.hour)}:59`;
    tip.append(head, tipRow(h.row.color, c.p50 != null ? ms(c.p50) : '—', `${h.row.label} · p50`));
    if (c.p95 != null) tip.append(tipRow(h.row.color, ms(c.p95), 'p95'));
    tip.append(tipRow('transparent', `${c.lost} / ${c.n}`, t('lost')));
    $('aCross').hidden = true;
  }
  tip.hidden = false;
  const wrap = $('aChartWrap').getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = px + 14, y = py - th - 10;
  if (x + tw > wrap.width - 4) x = px - tw - 14;
  if (y < 4) y = py + 16;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, Math.min(wrap.height - th - 4, y))}px`;
}

function bindChart() {
  const canvas = $('aChart');
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    const g = A.geom;
    if (!g || !g.toT || e.button !== 0) return;
    const [px] = pos(e);
    if (px < g.plot.l || px > g.plot.r) return;
    canvas.setPointerCapture(e.pointerId);
    A.drag = { px, a: g.toT(px), b: g.toT(px) };
    hideTip();
  });
  canvas.addEventListener('pointermove', (e) => {
    const [px, py] = pos(e);
    if (A.drag) {
      A.drag.b = A.geom.toT(px);
      A.drag.moved = Math.abs(px - A.drag.px) > 4;
      if (A.drag.moved) drawChartNow();
      return;
    }
    showTip(px, py);
  });
  const end = () => {
    if (!A.drag) return;
    const d = A.drag;
    A.drag = null;
    if (d.moved) {
      const a = Math.min(d.a, d.b), b = Math.max(d.a, d.b);
      if (b - a >= 1000) { A.range = [a, b]; refresh(); return; }
    }
    drawChartNow();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!A.drag) hideTip(); });
  canvas.addEventListener('dblclick', () => { if (A.range) { A.range = null; refresh(); } });
}

/* ---- the table -------------------------------------------------------------- */

function renderTableHead() {
  const v = A.view;
  $('aCount').textContent = `${v.rows.length.toLocaleString()} ${t('rows')}`;
  $('aSpacer').style.height = `${v.rows.length * ROW_H}px`;
  $('aRowsEmpty').hidden = v.rows.length > 0;
}

function rawLine(n) {
  if (A.text == null) return '';
  if (!A.lines) A.lines = A.text.split(/\r?\n/);
  return A.lines[n - 1] || '';
}

let lastFirst = -1;
function renderRows(force = false) {
  const v = A.view;
  if (!v) return;
  const pane = $('aPane');
  const first = Math.max(0, Math.floor(pane.scrollTop / ROW_H) - 8);
  const count = Math.ceil(pane.clientHeight / ROW_H) + 16;
  if (!force && first === lastFirst) return;
  lastFirst = first;
  const res = A.res;
  const out = [];
  for (let r = first; r < Math.min(v.rows.length, first + count); r++) {
    const s = res.samples[v.rows[r]];
    const tg = res.targets[s.tgt];
    const lost = s.status !== 'ok' && s.status !== 'dup';
    const why = s.inferred
      ? (s.tail ? t('Inferred: ping\'s summary counts more packets sent than the log shows.') : t('Inferred: this sequence number never appears in the log, so the packet got no reply.'))
      : rawLine(s.line);
    const rtt = s.rtt == null ? '—' : (s.lt ? '<1 ms' : ms(s.rtt, s.rtt < 10 ? 2 : 1));
    out.push(`<div class="lrow arow${lost ? ' lost' : ''}${s.status === 'dup' ? ' dup' : ''}" style="top:${r * ROW_H}px" title="${esc(why)}">`
      + `<span class="c-line num">${s.line}</span>`
      + `<span class="c-time num">${fmtTime(s.at)}</span>`
      + `<span class="c-tgt"><i class="dot" style="background:${tg.color}"></i>${esc(tg.label)}</span>`
      + `<span class="c-from">${esc(s.from || '')}</span>`
      + `<span class="c-seq num">${s.seq != null ? s.seq : ''}</span>`
      + `<span class="c-ttl num">${s.ttl != null ? s.ttl : ''}</span>`
      + `<span class="c-rtt num">${rtt}</span>`
      + `<span class="c-st ${s.status === 'ok' ? 'ok' : s.status === 'dup' ? 'dupst' : 'err'}">${t(STATUS_LABEL[s.status])}${s.inferred ? ` <i class="inf">${t('inferred')}</i>` : ''}</span>`
      + '</div>');
  }
  $('aRows').innerHTML = out.join('');
}

function syncFilterUI() {
  const sel = $('aFTarget');
  const res = A.res;
  sel.textContent = '';
  const all = document.createElement('option');
  all.value = ''; all.textContent = t('All targets');
  sel.append(all);
  if (res) res.targets.forEach((tg, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = tg.label;
    sel.append(o);
  });
  sel.value = A.fTarget;
  $('aFStatus').value = A.fStatus;
  $('aFRtt').value = A.fRtt;
  $('aFAround').checked = A.fAround;
  $('aFAroundN').value = String(A.fAroundN);
  $('aFAroundN').disabled = !A.fAround;
}

function refresh() {
  derive();
  $('aPane').scrollTop = 0;
  render();
}

/* ---- the parse-details dialog ------------------------------------------------ */

function openDetails(section) {
  const res = A.res;
  const body = $('aDetailsBody');
  body.textContent = '';
  const h = (txt) => { const e = document.createElement('h3'); e.textContent = txt; body.append(e); };
  const p = (txt, cls) => { const e = document.createElement('p'); e.textContent = txt; if (cls) e.className = cls; body.append(e); };
  const pre = (items) => {
    const e = document.createElement('pre');
    e.className = 'rawlines';
    e.textContent = items.map((x) => `${String(x.line).padStart(6)}  ${x.text}`).join('\n');
    body.append(e);
  };

  h(t('How the file was read'));
  p(`${FORMAT_NAMES[res.format] || '—'}${res.lang ? ' · ' + (LANG_NAMES[res.lang] || res.lang) : ''} · ${res.encoding || 'UTF-8'} · ${res.lineCount} ${t('lines')} · ${res.sessions.length} ${t('runs')} · ${res.targets.length} ${t('targets')}`);
  p(basisTitle(res), 'muted');
  const inferred = res.samples.filter((s) => s.inferred).length;
  if (inferred) p(`${inferred} ${t('lost probes were inferred from gaps in the sequence numbers or from ping\'s summary — Linux ping prints nothing for a packet that never came back.')}`, 'muted');
  if (res.dups) p(`${res.dups} ${t('duplicate replies were kept in the table and left out of every statistic.')}`, 'muted');

  const checks = checkStats();
  h(t('Cross-check against ping'));
  if (!checks.checked) p(t('This log carries no summary blocks, so there was nothing to cross-check against.'), 'muted');
  else if (!checks.issues.length) p(`✓ ${checks.matched}/${checks.checked} — ${t('every summary matches the parsed samples.')}`);
  else {
    p(`⚠ ${checks.issues.length} ${t('of')} ${checks.checked} ${t('summaries disagree')}:`);
    pre(checks.issues.map((x) => ({ line: x.line, text: `${x.target} — ${x.text}` })));
  }
  if (res.format === 'windows') p(t('Windows counts "Destination host unreachable" as a received reply; this tool counts it as lost, and the check compares the Windows way.'), 'muted');

  h(`${t('Unrecognised lines')} (${res.unparsedCount})`);
  if (!res.unparsedCount) p(t('Every line was understood.'), 'muted');
  else {
    if (res.unparsedCount > res.unparsed.length) p(`${t('Showing the first')} ${res.unparsed.length}.`, 'muted');
    pre(res.unparsed);
  }
  h(`${t('Lines read but not counted')} (${res.noteCount})`);
  p(t('Error messages, hex dumps, table headers and summary text: understood, but not samples.'), 'muted');
  if (res.notes.length) pre(res.notes.slice(0, 300));

  const dlg = $('dlgDetails');
  dlg.showModal();
  if (section) {
    const target = [...body.querySelectorAll('h3')].find((x) => x.textContent.startsWith(t(section)));
    if (target) target.scrollIntoView();
  }
}

/* ---- exports and the report --------------------------------------------------- */

const IMPORT_COLUMNS = ['Seq', 'Timestamp', 'Time basis', 'Target', 'Target IP', 'Responder', 'Status',
  'RTT (ms)', 'TTL', 'Bytes', 'Session', 'Line'];

function schema() {
  const res = A.res;
  return {
    columns: IMPORT_COLUMNS,
    sheet: 'Ping log',
    prefix: 'carino-ping-log',
    rows: (idx) => idx.map((k) => {
      const s = res.samples[k];
      const tg = res.targets[s.tgt];
      return [
        s.seq ?? '', exportStamp(s.at), s.inferred ? `${res.basis} (inferred)` : res.basis,
        tg.label, tg.ip || '', s.from || '', STATUS_LABEL[s.status],
        s.rtt == null ? '' : Number(s.rtt.toFixed(3)), s.ttl ?? '', s.bytes ?? '', s.sess + 1, s.line,
      ];
    }),
  };
}

export async function exportAs(kind) {
  if (!A.res || !A.view.rows.length) { notify(t('Nothing to export — load a log first.'), 'warn'); return; }
  try {
    if (kind === 'csv') exportCSV(A.view.rows, schema());
    else await exportSheet(A.view.rows, kind, schema());
    notify('');
  } catch (err) {
    notify(t('Export failed:') + ' ' + err.message, 'err');
  }
}

const METHOD = 'Read from a saved ping log, not measured by this browser: these are real ICMP round trips, taken by '
  + 'whatever machine ran the ping command. Lost probes are counted from what the log shows — Windows and macOS '
  + 'print a line for each timeout; Linux prints nothing, so a missing sequence number is counted as lost, and '
  + 'packets lost after the last reply are recovered from the summary\'s "packets transmitted". Duplicate replies '
  + 'are left out of every statistic. Where the log has no clock, the time axis is the sequence number times the '
  + 'interval chosen on screen, so durations are close but times of day are unknown. Where ping printed its own '
  + 'summary, the parsed counts and min/avg/max were checked against it. Windows counts "Destination host '
  + 'unreachable" as a received reply; this report counts it as lost. Statistics are min, p50, p95 and max, jitter '
  + 'is the RFC 3550 mean absolute difference between consecutive replies, and loss is pooled over probes.';

export function report() {
  if (!A.res) { notify(t('Nothing to export — load a log first.'), 'warn'); return; }
  const v = A.view;
  const list = v.visible.map((x) => x.series);
  const sum = combine(list);
  const res = A.res;
  const chk = checkStats();
  try {
    openReport(reportHtml({
      summary: sum,
      targets: list.map((s) => s.snapshot()),
      extremes: extremes(list, 5),
      lossEvents: lossEvents(list),
      verdict: t(verdict(sum).text),
      method: t(METHOD),
      fmtTime,
      source: {
        file: A.file ? A.file.name : '',
        size: A.file ? fmtSize(A.file.size) : '',
        format: `${FORMAT_NAMES[res.format] || '—'}${res.lang ? ' · ' + (LANG_NAMES[res.lang] || res.lang) : ''}`,
        encoding: res.encoding || 'UTF-8',
        basis: { absolute: t('from the log'), clock: t('time of day only'), estimated: t('estimated from sequence numbers') }[res.basis],
        span: `${fmtTime(v.x0)} – ${fmtTime(v.x1)} (${spanText(v.x0, v.x1)})`,
        sessions: res.sessions.length,
        lines: res.lineCount,
        unparsed: res.unparsedCount,
        range: A.range ? t('a selected time range, not the whole log') : '',
        checks: chk,
      },
    }, t), t);
    notify('');
  } catch (err) {
    notify(err.message, 'err');
  }
}

export function clear() {
  A.res = null; A.text = null; A.lines = null; A.file = null; A.view = null; A.range = null;
  $('aPaste').value = '';
  notify('');
  render();
}

/* ---- the example ---------------------------------------------------------- */

/** An hour of `ping -D` against two hosts, with the things worth finding in
    it: a 40-second outage, a stretch of congestion and a route change. */
function exampleLog() {
  const out = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const t0 = Math.floor(Date.now() / 1000) - 3 * 3600;
  const run = (host, ip, base, ttl0, from) => {
    out.push(`PING ${host} (${ip}) 56(84) bytes of data.`);
    let rx = 0, sum = 0, sq = 0, mn = Infinity, mx = 0;
    for (let i = 1; i <= 1800; i++) {
      const at = t0 + from + i * 2 + rnd() * 0.004;
      if (i > 700 && i < 721) continue;                         // the outage
      if (rnd() < 0.004) continue;                              // stray loss
      let v = base + rnd() * base * 0.12 + (rnd() < 0.03 ? rnd() * base * 2 : 0);
      if (i > 1100 && i < 1350) v += 30 + rnd() * 50;           // congestion
      const ttl = i > 1500 ? ttl0 - 2 : ttl0;                   // route change
      v = Math.round(v * 100) / 100;
      rx++; sum += v; sq += v * v; mn = Math.min(mn, v); mx = Math.max(mx, v);
      out.push(`[${at.toFixed(6)}] 64 bytes from ${ip}: icmp_seq=${i} ttl=${ttl} time=${v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)} ms`);
    }
    out.push('', `--- ${host} ping statistics ---`,
      `1800 packets transmitted, ${rx} received, ${(((1800 - rx) / 1800) * 100).toFixed(4).replace(/\.?0+$/, '')}% packet loss, time 3599000ms`,
      `rtt min/avg/max/mdev = ${mn.toFixed(3)}/${(sum / rx).toFixed(3)}/${mx.toFixed(3)}/${Math.sqrt(sq / rx - (sum / rx) ** 2).toFixed(3)} ms`);
  };
  run('carino.systems', '185.199.108.153', 40, 57, 0);
  run('1.1.1.1', '1.1.1.1', 6, 58, 0.5);
  return out.join('\n') + '\n';
}

/* ---- wiring --------------------------------------------------------------- */

export function activate() {
  A.active = true;
  if (A.res) { derive(); render(); requestAnimationFrame(() => { drawChartNow(); renderRows(true); }); }
  else render();
}
export function deactivate() { A.active = false; hideTip(); }
export function isLoaded() { return !!A.res; }

export function init({ notice }) {
  notify = notice;
  restore();

  $('aFileInput').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  $('aChoose').addEventListener('click', () => $('aFileInput').click());
  $('aAnalyzePaste').addEventListener('click', () => {
    const text = $('aPaste').value;
    if (!text.trim()) { notify(t('Paste some ping output first.'), 'warn'); return; }
    loadText(text, t('pasted text'));
  });
  $('aExample').addEventListener('click', () => loadText(exampleLog(), 'example-ping-D.log'));

  $('aFormat').addEventListener('change', (e) => { A.opts.format = e.target.value; reparse(); });
  $('aInterval').addEventListener('change', (e) => { A.opts.interval = +e.target.value; save(); reparse(); });
  $('aDateOrder').addEventListener('change', (e) => { A.opts.dateOrder = e.target.value; reparse(); });
  $('aCheck').addEventListener('click', () => openDetails('Cross-check against ping'));
  $('aUnparsed').addEventListener('click', () => openDetails('Unrecognised lines'));
  $('aDetails').addEventListener('click', () => openDetails());
  const dlg = $('dlgDetails');
  $('aDetailsClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  $('aTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b || b.disabled) return;
    A.tab = b.dataset.tab; save();
    renderChartHead(); drawChartNow();
  });
  $('aLogScale').addEventListener('click', () => { A.logScale = !A.logScale; save(); renderChartHead(); drawChartNow(); });
  $('aRangeClear').addEventListener('click', () => { A.range = null; refresh(); });

  $('aFTarget').addEventListener('change', (e) => { A.fTarget = e.target.value; refresh(); });
  $('aFStatus').addEventListener('change', (e) => { A.fStatus = e.target.value; derive(); $('aPane').scrollTop = 0; renderTableHead(); renderRows(true); });
  let rttTimer;
  $('aFRtt').addEventListener('input', (e) => {
    clearTimeout(rttTimer);
    rttTimer = setTimeout(() => { A.fRtt = e.target.value.trim(); derive(); $('aPane').scrollTop = 0; renderTableHead(); renderRows(true); }, 200);
  });
  const around = () => {
    A.fAround = $('aFAround').checked;
    A.fAroundN = Math.max(0, Math.min(500, +$('aFAroundN').value || 0));
    $('aFAroundN').disabled = !A.fAround;
    derive(); $('aPane').scrollTop = 0; renderTableHead(); renderRows(true);
  };
  $('aFAround').addEventListener('change', around);
  $('aFAroundN').addEventListener('change', around);

  $('aPane').addEventListener('scroll', () => renderRows(), { passive: true });
  bindChart();

  let resizeTimer;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (A.active && A.res) { drawChartNow(); renderRows(true); } }, 120);
  };
  window.addEventListener('resize', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  window.addEventListener('carino:langchange', () => { if (A.res) { syncFilterUI(); render(); } });
}
