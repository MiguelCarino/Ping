/* app.js — Carino Ping.

   Holds the targets, runs one self-correcting loop per target, and keeps the
   cards, chart, log and statistics in step.

   Scheduling note. The previous version used a single `setInterval` that fired
   every target at once and never waited for the last round to finish, so an
   interval shorter than the round trip piled requests up and every reading
   after that measured the queue rather than the network. Each target here runs
   its own loop that starts the next wait from the moment the last probe
   *began*, and never has two probes outstanding. Set a 500 ms interval against
   a 900 ms host and it degrades to back-to-back probes instead of lying. */

import { probe, toURL, isMixedContent, stunRTT, connectionHint } from './probe.js';
import { Series, combine, verdict } from './stats.js';
import { drawChart, sparkline, seriesColor, phaseBar } from './viz.js';
import { exportCSV, exportSheet, exportPDF } from './export.js';

const $ = (id) => document.getElementById(id);
const t = (k) => (window.t ? window.t(k) : k);

const STORE = 'carino-ping/v1';
const STUN_SERVER = 'stun:stun.l.google.com:19302';
const LOG_DOM_CAP = 400;     // rows kept in the DOM; the export keeps them all
const CHART_WINDOW = 180;    // samples drawn per series

const state = {
  running: false,
  targets: [],          // { raw, url, series, color, seen }
  log: [],
  seq: 0,
  interval: 2000,
  timeout: 5000,
  runHidden: false,
  logScale: false,
  filter: '',
  waiters: new Set(),   // resolve handles for the cancellable sleeps
};

/* ---- persistence ---------------------------------------------------------- */

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      targets: $('targetInput').value,
      path: $('pathInput').value,
      interval: state.interval,
      timeout: state.timeout,
      runHidden: state.runHidden,
      logScale: state.logScale,
    }));
  } catch { /* private mode: the app still works, it just forgets */ }
}

function restore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { /* ignore */ }
  if (!saved) return;
  if (saved.targets) $('targetInput').value = saved.targets;
  if (saved.path) $('pathInput').value = saved.path;
  if (saved.interval) { state.interval = saved.interval; $('intervalSel').value = String(saved.interval); }
  if (saved.timeout) { state.timeout = saved.timeout; $('timeoutSel').value = String(saved.timeout); }
  state.runHidden = !!saved.runHidden; $('optHidden').checked = state.runHidden;
  state.logScale = !!saved.logScale; $('btnLogScale').classList.toggle('active', state.logScale);
}

/* ---- helpers -------------------------------------------------------------- */

const ms = (v, dp = 1) => (v == null ? '—' : `${v.toFixed(dp)} ms`);

function sleep(msec) {
  return new Promise((resolve) => {
    const id = setTimeout(() => { state.waiters.delete(cancel); resolve(); }, msec);
    const cancel = () => { clearTimeout(id); resolve(); };
    state.waiters.add(cancel);
  });
}
function wakeAll() { state.waiters.forEach((c) => c()); state.waiters.clear(); }

function notice(text, kind = 'warn') {
  const el = $('notice');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = `notice ${kind}`;
  el.textContent = text;
}

/* ---- targets -------------------------------------------------------------- */

function parseTargets() {
  const path = ($('pathInput').value || '/favicon.ico').trim();
  const raws = $('targetInput').value.split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  const bad = [];
  let mixed = false;
  for (const raw of raws) {
    if (seen.has(raw.toLowerCase())) continue;
    seen.add(raw.toLowerCase());
    let url;
    try { url = toURL(raw, path); } catch { bad.push(raw); continue; }
    if (isMixedContent(url)) { mixed = true; continue; }
    const existing = state.targets.find((x) => x.raw === raw && x.url.href === url.href);
    out.push(existing || { raw, url, series: new Series(raw), color: '', seen: false });
  }
  out.forEach((tg, i) => { tg.color = seriesColor(i); });
  if (bad.length) notice(t('Could not read these targets:') + ' ' + bad.join(', '), 'err');
  else if (mixed) notice(t('http:// targets are blocked on an https:// page (mixed content) and were skipped.'), 'warn');
  else notice('');
  return out;
}

/* ---- the run loop --------------------------------------------------------- */

async function runTarget(tg) {
  while (state.running) {
    if (document.hidden && !state.runHidden) { await sleep(400); continue; }
    const began = performance.now();

    const cold = !tg.seen;
    const sample = await probe(tg.url, { timeout: state.timeout, cold });
    tg.seen = true;
    if (!state.running) return;

    tg.series.push(sample);
    state.seq++;
    const row = { seq: state.seq, target: tg.raw, ...sample };
    state.log.push(row);
    appendLogRow(row, tg.color);
    schedulePaint();

    const spent = performance.now() - began;
    await sleep(Math.max(0, state.interval - spent));
  }
}

function start() {
  const targets = parseTargets();
  if (!targets.length) { notice(t('Add at least one website to measure.'), 'err'); return; }
  state.targets = targets;
  state.running = true;
  setRunUI(true);
  renderCards();
  targets.forEach((tg) => { runTarget(tg); });
  measureStun();
}

function stop() {
  state.running = false;
  wakeAll();
  setRunUI(false);
  schedulePaint();
}

function setRunUI(on) {
  const b = $('btnRun');
  b.classList.toggle('running', on);
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('.btn-label').textContent = on ? t('Stop') : t('Start');
  $('modeChip').textContent = on ? t('MEASURING') : t('IDLE');
  $('modeChip').classList.toggle('live', on);
  ['targetInput', 'pathInput'].forEach((id) => { $(id).disabled = on; });
}

function clearAll() {
  if (state.running) stop();
  state.targets.forEach((tg) => { tg.series.reset(); tg.seen = false; });
  state.log = [];
  state.seq = 0;
  $('logBody').innerHTML = '';
  $('logEmpty').hidden = false;
  renderCards();
  paint();
}

/* ---- rendering ------------------------------------------------------------ */

let painting = false;
function schedulePaint() {
  if (painting) return;
  painting = true;
  requestAnimationFrame(() => { painting = false; paint(); });
}

function paint() {
  const list = state.targets.map((x) => x.series);
  const sum = combine(list);

  $('stTargets').textContent = String(sum.targets);
  $('stBest').textContent = ms(sum.min);
  $('stP50').textContent = ms(sum.p50);
  $('stP95').textContent = ms(sum.p95);
  $('stJitter').textContent = ms(sum.jitter);
  $('stLoss').textContent = sum.sent ? `${sum.loss.toFixed(1)} %` : '—';
  $('stSent').textContent = `${sum.sent}`;
  $('stLossSub').textContent = sum.sent ? `${sum.lost} ${t('of')} ${sum.sent}` : t('none sent');

  const lossTile = $('tileLoss');
  lossTile.classList.toggle('bad', sum.loss >= 5);
  lossTile.classList.toggle('warn', sum.loss > 0 && sum.loss < 5);

  const v = verdict(sum);
  const vEl = $('verdict');
  vEl.textContent = t(v.text);
  vEl.dataset.key = v.key;

  renderCards();
  // Cold samples are dropped from the series rather than mapped to null: null
  // means "this probe never came back" and is drawn as a loss rule, which a
  // successful handshake is emphatically not.
  drawChart($('chart'), state.targets.map((tg) => ({
    label: tg.raw,
    color: tg.color,
    points: tg.series.all.filter((s) => !s.cold).slice(-CHART_WINDOW).map((s) => (s.ok ? s.rtt : null)),
  })), { log: state.logScale });
}

function renderCards() {
  const wrap = $('cards');
  if (!state.targets.length) {
    wrap.innerHTML = `<p class="muted" data-i18n>${t('Nothing measured yet. Enter one or more websites and press Start.')}</p>`;
    return;
  }
  wrap.innerHTML = state.targets.map((tg) => {
    const s = tg.series.snapshot();
    const pts = tg.series.all.filter((x) => !x.cold).slice(-60).map((x) => (x.ok ? x.rtt : null));
    const last = [...tg.series.all].reverse().find((x) => x.ok && x.detail);
    const lossCls = s.loss >= 5 ? 'bad' : s.loss > 0 ? 'warn' : '';
    return `<article class="tcard">
      <header>
        <span class="dot" style="background:${tg.color}"></span>
        <span class="tname" title="${tg.url.href}">${escapeHtml(tg.raw)}</span>
        <span class="chip ${s.detail ? 'good' : ''}" title="${s.detail
        ? t('This server sends Timing-Allow-Origin, so the reading is true time-to-first-byte.')
        : t('No Timing-Allow-Origin header, so only the total round trip is visible — not the phase split.')}">${s.detail ? 'TTFB' : t('total only')}</span>
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
      ${last ? phaseBar(last) : ''}
      ${s.cold != null ? `<p class="coldnote">${t('First request')}: ${ms(s.cold)} — ${t('includes DNS and the TLS handshake, excluded from the numbers above.')}</p>` : ''}
    </article>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function appendLogRow(row, color) {
  const body = $('logBody');
  $('logEmpty').hidden = true;
  const el = document.createElement('div');
  el.className = 'lrow' + (row.ok ? '' : ' lost');
  el.dataset.target = row.target;
  if (state.filter && !row.target.toLowerCase().includes(state.filter)) el.hidden = true;
  const status = row.ok ? 'OK' : (row.timedOut ? t('TIMEOUT') : t('UNREACHABLE'));
  const when = new Date(row.at).toLocaleTimeString([], { hour12: false });
  el.innerHTML = `<span class="c-seq num">${row.seq}</span>`
    + `<span class="c-time num">${when}</span>`
    + `<span class="c-tgt"><i class="dot" style="background:${color}"></i>${escapeHtml(row.target)}</span>`
    + `<span class="c-rtt num">${row.ok ? ms(row.rtt) : '—'}</span>`
    + `<span class="c-ph num">${row.detail ? `${t('DNS')} ${row.dns.toFixed(0)} · TLS ${row.tls.toFixed(0)} · TTFB ${row.ttfb.toFixed(0)}` : (row.ok ? t('total only') : '')}</span>`
    + `<span class="c-st ${row.ok ? 'ok' : 'err'}">${row.cold && row.ok ? `<i class="cold" title="${t('First request to this host — includes the handshakes.')}">cold</i> ` : ''}${status}</span>`;
  body.appendChild(el);
  while (body.childElementCount > LOG_DOM_CAP) body.removeChild(body.firstElementChild);
  const pane = $('logPane');
  if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 60) pane.scrollTop = pane.scrollHeight;
}

function applyFilter() {
  state.filter = $('logFilter').value.trim().toLowerCase();
  for (const el of $('logBody').children) {
    el.hidden = !!state.filter && !el.dataset.target.toLowerCase().includes(state.filter);
  }
}

/* ---- baselines ------------------------------------------------------------ */

/* Two readings that put the HTTP numbers in context.

   navigator.connection.rtt is free and local — the browser already knows it,
   reading it contacts nobody, so it is filled in on load.

   The STUN round trip is not free in that sense: it sends a binding request to
   a third-party STUN server, which is the one packet this page emits that does
   not go to a host the user named. So it never fires on page load. It runs
   when the user presses Re-measure, or when they press Start and have
   therefore asked for a measurement, and the server it talks to is printed
   next to the number rather than buried in the source. */

function showConnectionHint() {
  const c = connectionHint();
  $('connVal').textContent = c && c.rtt != null
    ? `${c.rtt} ms${c.effectiveType ? ` · ${c.effectiveType}` : ''}`
    : t('not published by this browser');
}

let stunBusy = false;
async function measureStun() {
  if (stunBusy) return;
  stunBusy = true;
  $('stunVal').textContent = t('measuring…');
  try {
    const r = await stunRTT(STUN_SERVER);
    $('stunVal').textContent = r == null ? t('blocked or unavailable') : ms(r);
  } finally {
    stunBusy = false;
  }
}

/* ---- exports -------------------------------------------------------------- */

const METHOD = 'Measured from a web browser, which cannot send ICMP: no browser API exposes raw sockets. '
  + 'Each sample is an HTTPS request to the target with cache and credentials disabled, aborted at the '
  + 'configured timeout. Where the server sends a Timing-Allow-Origin header, the Resource Timing API gives '
  + 'the real phase split and the RTT column is time-to-first-byte; where it does not, only the total round '
  + 'trip is visible and the RTT column is that total, which also contains server processing and transfer '
  + 'time. The first request to each host is recorded but excluded from the statistics because it carries '
  + 'DNS and the TLS handshake. Figures therefore describe what this browser experienced over HTTPS from '
  + 'this network at this time; they are an upper bound on the path latency, never an ICMP round trip.';

function exportGuard() {
  if (!state.log.length) { notice(t('Nothing measured yet — run at least one probe before exporting.'), 'warn'); return false; }
  return true;
}

async function doExport(kind) {
  if (!exportGuard()) return;
  try {
    if (kind === 'csv') exportCSV(state.log);
    else if (kind === 'xlsx' || kind === 'ods') await exportSheet(state.log, kind);
    else {
      const sum = combine(state.targets.map((x) => x.series));
      await exportPDF(state.log, {
        summary: sum,
        perTarget: state.targets.map((x) => x.series.snapshot()),
        method: METHOD,
        verdict: verdict(sum).text,
      });
    }
    notice('');
  } catch (err) {
    notice(t('Export failed:') + ' ' + err.message, 'err');
  }
}

/* ---- wiring --------------------------------------------------------------- */

function init() {
  restore();

  $('btnRun').addEventListener('click', () => (state.running ? stop() : start()));
  $('btnClear').addEventListener('click', clearAll);
  $('intervalSel').addEventListener('change', (e) => { state.interval = +e.target.value; save(); });
  $('timeoutSel').addEventListener('change', (e) => { state.timeout = +e.target.value; save(); });
  $('optHidden').addEventListener('change', (e) => { state.runHidden = e.target.checked; save(); wakeAll(); });
  $('targetInput').addEventListener('change', save);
  $('pathInput').addEventListener('change', save);
  $('logFilter').addEventListener('input', applyFilter);
  $('btnLogScale').addEventListener('click', (e) => {
    state.logScale = !state.logScale;
    e.currentTarget.classList.toggle('active', state.logScale);
    save(); paint();
  });
  $('btnBaseline').addEventListener('click', measureStun);

  // The method text lives in a dialog so the app itself never needs a
  // scrollbar. <dialog> gives Escape-to-close and focus trapping for free.
  const dlg = $('dlgMethod');
  $('btnMethod').addEventListener('click', () => dlg.showModal());
  $('btnMethodClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('btnCsv').addEventListener('click', () => doExport('csv'));
  $('btnXlsx').addEventListener('click', () => doExport('xlsx'));
  $('btnOds').addEventListener('click', () => doExport('ods'));
  $('btnPdf').addEventListener('click', () => doExport('pdf'));

  $('targetInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !state.running) start();
  });

  // A hidden tab has its timers clamped to roughly one second, so readings
  // taken there measure the throttle, not the network. Pausing is the default;
  // the checkbox exists for someone deliberately leaving a run going.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeAll(); });

  let resizeTimer;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(paint, 120); };
  window.addEventListener('resize', onResize);
  // Phone URL-bar show/hide changes the height without firing a resize in some
  // browsers; the visual viewport does report it.
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  window.addEventListener('carino:langchange', () => { setRunUI(state.running); showConnectionHint(); paint(); });

  $('stunHost').textContent = STUN_SERVER;
  state.targets = parseTargets();
  paint();
  showConnectionHint();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
