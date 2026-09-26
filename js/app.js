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

import { probe, toURL, isMixedContent, stunProbe } from './probe.js';
import { Series, combine, verdict, extremes, lossEvents } from './stats.js';
import { drawChart, sparkline, seriesColor, phaseBar } from './viz.js';
import { exportCSV, exportSheet } from './export.js';
import { measureDownlink, fmtMbps } from './speed.js';
import { environment, connectionLabel, reverseDNS } from './client.js';
import { reportHtml, openReport } from './report.js';

const $ = (id) => document.getElementById(id);
const t = (k) => (window.t ? window.t(k) : k);

const STORE = 'carino-ping/v2';
const STUN_SERVER = 'stun:stun.l.google.com:19302';

/* One timer, not two. A separate timeout selector asked the user to reason
   about the relationship between "how often" and "how long before I give up",
   which has exactly one sensible answer: long enough that a slow-but-alive host
   still counts, short enough that a dead one does not stall the run. Three
   intervals, clamped to a floor and a ceiling, is that answer. */
const timeoutFor = (interval) => Math.min(10000, Math.max(2000, interval * 3));
const LOG_DOM_CAP = 400;     // rows kept in the DOM; the export keeps them all
const CHART_WINDOW = 180;    // samples drawn per series

const state = {
  running: false,
  targets: [],          // { raw, url, series, color, seen }
  log: [],
  seq: 0,
  interval: 2000,
  runHidden: false,
  dropCold: true,        // the first request to a host is a warm-up, not a sample
  logScale: false,
  filter: '',
  startedAt: null,
  endedAt: null,
  waiters: new Set(),   // resolve handles for the cancellable sleeps
};

/* ---- persistence ---------------------------------------------------------- */

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      targets: $('targetInput').value,
      path: $('pathInput').value,
      interval: state.interval,
      runHidden: state.runHidden,
      dropCold: state.dropCold,
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
  state.runHidden = !!saved.runHidden; $('optHidden').checked = state.runHidden;
  // Absent in a store written before this option existed, and the default is
  // on, so `!== false` rather than a truthiness test.
  state.dropCold = saved.dropCold !== false; $('optDropCold').checked = state.dropCold;
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
    const sample = await probe(tg.url, { timeout: timeoutFor(state.interval), cold });
    tg.seen = true;
    if (!state.running) return;

    /* The first request to a host is a warm-up: it pays DNS and both
       handshakes, so it reads three to five times the steady state. It was
       always kept out of the statistics, but it still sat in the log, on the
       card and in the exports, where it reads as a measurement that happens to
       be enormous. With this on it is sent — the connection has to be opened by
       something — and then nothing is recorded: no row, no footnote, no export
       line, and it is not counted in Sent. Turn it off to see what the handshake
       actually cost. */
    if (cold && state.dropCold) {
      const spentWarm = performance.now() - began;
      await sleep(Math.max(0, state.interval - spentWarm));
      continue;
    }

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

async function start() {
  const targets = parseTargets();
  if (!targets.length) { notice(t('Add at least one website to measure.'), 'err'); return; }
  state.targets = targets;
  state.running = true;
  state.startedAt = Date.now();
  state.endedAt = null;
  setRunUI(true);
  renderCards();

  // Bandwidth first, on purpose: probing during a saturated download measures
  // the queue it created. Only once this returns is the line idle enough for
  // the latency numbers to mean anything.
  if (!conn.speed) await measureConnection();
  else if (!conn.stun) await measureStun();
  if (!state.running) return;               // stopped while the speed test ran

  targets.forEach((tg) => { runTarget(tg); });
}

function stop() {
  state.running = false;
  state.endedAt = Date.now();
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

  // The verdict lives in the navbar now: the badge names the conclusion, the
  // tooltip carries the sentence that explains it.
  const v = verdict(sum);
  const vEl = $('verdict');
  vEl.textContent = t(v.short);
  vEl.title = t(v.text);
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

/* ---- the connection ------------------------------------------------------

   Three facts about the line, gathered before the latency run rather than
   during it.

   The throughput test is the reason the ordering matters. A saturated link has
   a full queue, and a full queue adds delay to everything behind it — so
   measuring bandwidth while probing would not reveal "latency under load", it
   would silently corrupt every sample taken during it. Start therefore runs the
   speed test to completion first and only then begins probing, on an idle line.

   The STUN exchange is the one packet this page sends to a host the user did
   not name, so it never fires on page load, and the server it talks to is
   printed next to the reading rather than buried in the source. It returns the
   public address as a side effect, because that is literally what a
   server-reflexive candidate is.

   The interface is not here because it cannot be. See client.js. */

const conn = { speed: null, stun: null, hostname: null, env: null, testing: false };

function renderConnection() {
  const e = conn.env || environment();
  conn.env = e;
  $('connType').textContent = e.connection.type || t('not published');
  $('connEff').textContent = connectionLabel(e.connection, t);
  // Hostname when the PTR resolves, the address when it does not — a bare
  // number says far less than "…prod-infinitum.com.mx", which names the ISP.
  const ip = conn.stun && conn.stun.publicIP;
  const el = $('connHost');
  el.textContent = conn.hostname || ip || t('not measured');
  el.title = ip ? (conn.hostname ? `${conn.hostname} · ${ip}` : ip) : '';
  $('stStun').textContent = conn.stun && conn.stun.rtt != null ? ms(conn.stun.rtt) : '—';
  $('connSpeed').textContent = conn.speed && conn.speed.mbps != null
    ? fmtMbps(conn.speed.mbps)
    : (conn.testing ? t('testing…') : t('not measured'));
  $('clientId').textContent = e.id;
}

async function measureStun() {
  $('stStun').textContent = t('…');
  conn.stun = await stunProbe(STUN_SERVER);
  renderConnection();
  // Reverse lookup is a separate third-party request, so it happens here —
  // inside the step the user asked for — and never blocks the numbers.
  if (conn.stun && conn.stun.publicIP) {
    conn.hostname = await reverseDNS(conn.stun.publicIP);
    renderConnection();
  }
}

/** Throughput first, then STUN. Returns when the line is idle again. */
async function measureConnection({ quiet = false } = {}) {
  if (conn.testing) return;
  conn.testing = true;
  $('btnSpeed').disabled = true;
  renderConnection();
  try {
    if (!quiet) notice(t('Measuring downlink — the latency run starts when this finishes, so the line is idle for it.'), 'warn');
    conn.speed = await measureDownlink({
      onProgress: (_, frac) => { $('connSpeed').textContent = `${Math.round(frac * 100)} %`; },
    });
    if (conn.speed && conn.speed.mbps == null) {
      $('connSpeed').textContent = t('unavailable');
    }
    await measureStun();
  } finally {
    conn.testing = false;
    $('btnSpeed').disabled = false;
    renderConnection();
    if (!quiet) notice('');
  }
}

/* ---- exports and the report ----------------------------------------------- */

/* Concrete, because the abstract version invites the obvious complaint — that
   these numbers read higher than `ping` from a terminal. Measured on the
   machine this was written on, same minute, same network:

       host              ICMP min/avg     this tool (TTFB)
       carino.systems    40.6 / 42.2 ms   43 ms
       github.com        96.3 / 98.4 ms   102 ms
       cloudflare.com     4.9 /  7.0 ms   34 ms      <-- the odd one out

   The first two agree with ICMP to within a few percent, which is the answer
   to "is this thing accurate". The third is five times high, and the reason is
   not the measurement: `cloudflare.com/favicon.ico` answers 301 and redirects
   to `www.cloudflare.com/favicon.ico`. The browser follows it, so every probe
   pays a second request to a second host — a fresh DNS lookup, TCP handshake
   and TLS handshake the first time, and an extra round trip every time after.
   Probing the final URL instead reads 22 ms.

   So when a reading looks too high, in order of likelihood:
     1. the target redirects — probe the URL it redirects TO;
     2. the figure is a total, not TTFB, because the server sends no
        Timing-Allow-Origin, so it includes the server's own think time and the
        transfer;
     3. ICMP is answered by the kernel at the first anycast node that sees the
        packet, while HTTPS has to reach something that can serve the path —
        for a CDN those can be different machines in different cities. */
const METHOD = 'Measured from a web browser, which cannot send ICMP: no browser API exposes raw sockets. '
  + 'Each sample is an HTTPS request to the target with cache and credentials disabled, aborted at the '
  + 'configured timeout. Where the server sends a Timing-Allow-Origin header, the Resource Timing API gives '
  + 'the real phase split and the figure is time-to-first-byte; where it does not, only the total round '
  + 'trip is visible and the figure is that total, which also contains server processing and transfer time. '
  + 'The first request to each host is recorded but excluded from the statistics because it carries DNS and '
  + 'the TLS handshake. A target that redirects is followed, so every probe against it pays the extra hop — '
  + 'probe the final URL to avoid that. Downlink was measured before the run, not during it, so the latency '
  + 'samples were taken on an idle line. Figures describe what this browser experienced over HTTPS from this '
  + 'network at this time; they are an upper bound on path latency, never an ICMP round trip.';

function exportGuard() {
  if (!state.log.length) { notice(t('Nothing measured yet — run at least one probe before exporting.'), 'warn'); return false; }
  return true;
}

async function doExport(kind) {
  if (!exportGuard()) return;
  try {
    if (kind === 'csv') exportCSV(state.log);
    else await exportSheet(state.log, kind);
    notice('');
  } catch (err) {
    notice(t('Export failed:') + ' ' + err.message, 'err');
  }
}

function buildReport() {
  const list = state.targets.map((x) => x.series);
  const sum = combine(list);
  return reportHtml({
    summary: sum,
    targets: list.map((s) => s.snapshot()),
    extremes: extremes(list, 5),
    lossEvents: lossEvents(list),
    verdict: t(verdict(sum).text),
    method: t(METHOD),          // translated like everything else on the sheet
    env: conn.env || environment(),
    speed: conn.speed,
    stun: conn.stun,
    hostname: conn.hostname,
    run: {
      started: state.startedAt || Date.now(),
      ended: state.endedAt || Date.now(),
      interval: state.interval,
      timeout: timeoutFor(state.interval),
      path: $('pathInput').value,
      samples: state.log.length,
      targetsLabel: state.targets.map((x) => x.raw).join(', '),
    },
  }, t);
}

function doReport() {
  if (!exportGuard()) return;
  try { openReport(buildReport(), t); notice(''); }
  catch (err) { notice(err.message, 'err'); }
}

/* ---- wiring --------------------------------------------------------------- */

function init() {
  restore();

  $('btnRun').addEventListener('click', () => (state.running ? stop() : start()));
  $('btnClear').addEventListener('click', clearAll);
  $('intervalSel').addEventListener('change', (e) => {
    state.interval = +e.target.value;
    $('intervalSel').title = `${t('Time between probes')} · ${t('gives up after')} ${timeoutFor(state.interval)} ms`;
    save();
  });
  $('optHidden').addEventListener('change', (e) => { state.runHidden = e.target.checked; save(); wakeAll(); });
  $('optDropCold').addEventListener('change', (e) => { state.dropCold = e.target.checked; save(); });
  $('targetInput').addEventListener('change', save);
  $('pathInput').addEventListener('change', save);
  $('logFilter').addEventListener('input', applyFilter);
  $('btnLogScale').addEventListener('click', (e) => {
    state.logScale = !state.logScale;
    e.currentTarget.classList.toggle('active', state.logScale);
    save(); paint();
  });

  // The method text lives in a dialog so the app itself never needs a
  // scrollbar. <dialog> gives Escape-to-close and focus trapping for free.
  const dlg = $('dlgMethod');
  $('btnMethod').addEventListener('click', () => dlg.showModal());
  $('btnMethodClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('btnCsv').addEventListener('click', () => doExport('csv'));
  $('btnXlsx').addEventListener('click', () => doExport('xlsx'));
  $('btnOds').addEventListener('click', () => doExport('ods'));
  $('btnReport').addEventListener('click', doReport);
  $('btnSpeed').addEventListener('click', () => measureConnection({ quiet: true }));

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
  window.addEventListener('carino:langchange', () => { setRunUI(state.running); renderConnection(); paint(); });

  $('stunHost').textContent = STUN_SERVER;
  $('intervalSel').title = `${t('Time between probes')} · ${t('gives up after')} ${timeoutFor(state.interval)} ms`;
  state.targets = parseTargets();
  paint();
  renderConnection();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
