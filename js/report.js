/* report.js — the deliverable, built the way Topo builds its one.

   Two decisions inherited from topo.carino.systems, both deliberate:

   1. The document is standalone HTML with its styles inline, opened in a new
      tab with a Print button. Turning it into a PDF is the browser's job, which
      is why there is no PDF library here — and why removing jsPDF took ~900 kB
      of vendored script out of this repo. The file survives being emailed,
      archived, or opened on a machine that has never heard of this tool.
   2. No analysis lives in this file. Every number it prints is one the
      statistics module already computed for the screen. If the report and the
      screen ever disagree, one of them is lying.

   What changed from the previous report: it no longer dumps every sample. A
   run at half-second intervals against four targets produces ~500 rows an hour,
   and nobody has ever read row 300. What a reader needs is the distribution —
   average, the spread, and the handful of samples at each extreme, because the
   peaks are where the story is. The full record still exists: that is what the
   CSV and spreadsheet exports are for, and the report says so. */

const A = '#eab308';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ms = (v, dp = 1) => (v == null ? '—' : `${v.toFixed(dp)} ms`);
const pct = (v) => (v == null ? '—' : `${v.toFixed(1)} %`);

function styles() {
  return `
  /* Margins only, and deliberately no paper size: forcing A4 makes a Letter
     printer scale the page, and Carta is what most of this report's readers
     have loaded. */
  @page { margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #f1f5f9; color: #0f172a;
         font: 13px/1.5 "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .sheet { max-width: 210mm; margin: 0 auto; background: #fff; padding: 18mm 16mm; box-shadow: 0 1px 3px rgba(15,23,42,0.15); }
  h1 { font-size: 21px; margin: 0 0 2px; letter-spacing: -0.01em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #475569;
       margin: 26px 0 8px; padding-bottom: 5px; border-bottom: 1px solid #e2e8f0; page-break-after: avoid; }
  p { margin: 0 0 8px; }
  .sub { color: #64748b; font-size: 12px; margin: 0 0 14px; }
  .rule { height: 3px; background: ${A}; margin: 0 0 14px; }

  .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 24px; margin-bottom: 6px; }
  .meta div { display: flex; gap: 8px; font-size: 12px; border-bottom: 1px dotted #e2e8f0; padding: 3px 0; }
  .meta dt { color: #64748b; min-width: 104px; margin: 0; }
  .meta dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }

  /* Grid, not flex: flex items with min-width:auto can total wider than the
     page box and put the last tile's border under the margin. */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; margin: 12px 0 4px; }
  .stat { border: 1px solid #e2e8f0; border-radius: 4px; padding: 8px 10px; min-width: 0; }
  .stat b { display: block; font-size: 19px; line-height: 1.15; }
  .stat span { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: #64748b; }
  .stat.crit { border-color: #fecaca; background: #fef2f2; } .stat.crit b { color: #b91c1c; }
  .stat.adv  { border-color: #fde68a; background: #fffbeb; } .stat.adv b { color: #b45309; }
  .stat.good { border-color: #a7f3d0; background: #ecfdf5; } .stat.good b { color: #065f46; }

  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 4px; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em;
       color: #475569; border-bottom: 1.5px solid #cbd5e1; padding: 5px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  tr { page-break-inside: avoid; }
  td.r, th.r { text-align: right; }
  /* Numbers and verdicts must never wrap: "102 ms" broken over two lines reads
     as two values, and "0.0 %" as a fraction. Only the target column wraps, and
     it is given the room to need to. */
  td.nw, th.nw, .stat b, .sev { white-space: nowrap; }
  table.tgt { table-layout: fixed; }
  table.tgt th:nth-child(1), table.tgt td:nth-child(1) { width: 22px; }
  table.tgt th:nth-child(2), table.tgt td:nth-child(2) { width: 21%; }
  table.tgt th:nth-child(11), table.tgt td:nth-child(11) { width: 9%; }
  table.ext th:nth-child(2), table.ext td:nth-child(2) { width: 34%; }
  .mono { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; overflow-wrap: anywhere; }
  .muted { color: #94a3b8; }
  .num { width: 26px; color: #94a3b8; }

  .sev { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 9.5px;
         font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
  .sev.bad { background: #fee2e2; color: #991b1b; }
  .sev.warn { background: #fef3c7; color: #92400e; }
  .sev.ok { background: #d1fae5; color: #065f46; }

  .clean { border: 1px solid #a7f3d0; background: #ecfdf5; color: #065f46; border-radius: 4px; padding: 10px 12px; }
  .alert { border: 1px solid #fecaca; background: #fef2f2; color: #991b1b; border-radius: 4px; padding: 10px 12px; }
  .note { font-size: 10.5px; color: #475569; background: #f8fafc; border-left: 3px solid #cbd5e1;
          padding: 9px 12px; margin: 8px 0; }
  .note b { color: #0f172a; }
  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #e2e8f0;
           font-size: 10px; color: #94a3b8; display: flex; justify-content: space-between; gap: 12px; }

  .toolbar { max-width: 210mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; }
  .toolbar button { background: #0f172a; color: #fff; border: 0; border-radius: 4px;
                    padding: 8px 16px; font-size: 12px; font-weight: 600; cursor: pointer; }

  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; max-width: none; padding: 0; }
    .toolbar { display: none; }
    h2 { margin-top: 18px; }
  }`;
}

const stat = (value, label, cls) =>
  `<div class="stat${cls ? ' ' + cls : ''}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

const row = (label, value) => (value ? `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>` : '');

/** Per-target distribution. The table the reader actually needs. */
function targetsTable(targets, t) {
  if (!targets.length) return `<p class="muted">${esc(t('No targets were measured.'))}</p>`;
  const rows = targets.map((s, i) => {
    const sev = s.loss >= 5 ? 'bad' : s.loss > 0 ? 'warn' : 'ok';
    const word = s.loss >= 5 ? t('Critical') : s.loss > 0 ? t('Advisory') : t('Clean');
    return `<tr>
      <td class="num">${i + 1}</td>
      <td class="mono">${esc(s.label)}</td>
      <td class="r nw">${esc(s.sent)}</td>
      <td class="r nw">${esc(pct(s.loss))}</td>
      <td class="r nw">${esc(ms(s.min))}</td>
      <td class="r nw"><b>${esc(ms(s.mean))}</b></td>
      <td class="r nw">${esc(ms(s.p50))}</td>
      <td class="r nw">${esc(ms(s.p95))}</td>
      <td class="r nw">${esc(ms(s.max))}</td>
      <td class="r nw">${esc(ms(s.jitter))}</td>
      <td>${esc(s.detail ? 'TTFB' : t('total only'))}</td>
      <td><span class="sev ${sev}">${esc(word)}</span></td>
    </tr>`;
  }).join('');
  return `<table class="tgt">
    <thead><tr>
      <th></th><th>${esc(t('Target'))}</th><th class="r">${esc(t('Sent'))}</th><th class="r">${esc(t('Loss'))}</th>
      <th class="r">${esc(t('Min'))}</th><th class="r">${esc(t('Average'))}</th><th class="r">p50</th>
      <th class="r">p95</th><th class="r">${esc(t('Max'))}</th><th class="r">${esc(t('Jitter'))}</th>
      <th>${esc(t('Timing'))}</th><th>${esc(t('Verdict'))}</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

/** Peaks (biggest excursion above that target's own median) and per-target lows. */
function extremesTable(extremes, t) {
  if (!extremes.length) return '';
  const rows = extremes.map((e) => `<tr>
    <td><span class="sev ${e.kind === 'high' ? 'warn' : 'ok'}">${esc(e.kind === 'high' ? t('Peak') : t('Low'))}</span></td>
    <td class="mono">${esc(e.target)}</td>
    <td class="r nw">${esc(ms(e.rtt))}</td>
    <td class="r nw">${e.over != null ? '+' + esc(ms(e.over)) : '<span class="muted">—</span>'}</td>
    <td class="mono nw">${esc(new Date(e.at).toLocaleTimeString())}</td>
  </tr>`).join('');
  return `<table class="ext"><thead><tr>
      <th>${esc(t('Extreme'))}</th><th>${esc(t('Target'))}</th>
      <th class="r">${esc(t('Round trip'))}</th><th class="r">${esc(t('Over median'))}</th><th>${esc(t('Time'))}</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p class="muted" style="font-size:10.5px">${esc(t("Peaks are ranked by how far a sample sat above its own target's median, so a spike on a fast host still appears next to a slow host's normal traffic. Lows are each target's best sample."))}</p>`;
}

function lossTable(lossEvents, t) {
  if (!lossEvents.length) {
    return `<div class="clean"><b>${esc(t('No probe went unanswered.'))}</b><br>${esc(t('Every request issued during this run came back.'))}</div>`;
  }
  const rows = lossEvents.map((e) => `<tr>
    <td class="mono">${esc(e.target)}</td>
    <td class="r">${esc(e.count)}</td>
    <td>${esc(e.kinds.join(', '))}</td>
    <td class="mono">${esc(e.firstAt ? new Date(e.firstAt).toLocaleTimeString() : '—')}</td>
    <td class="mono">${esc(e.lastAt ? new Date(e.lastAt).toLocaleTimeString() : '—')}</td>
  </tr>`).join('');
  return `<table><thead><tr>
      <th>${esc(t('Target'))}</th><th class="r">${esc(t('Unanswered'))}</th>
      <th>${esc(t('Kind'))}</th><th>${esc(t('First'))}</th><th>${esc(t('Last'))}</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * @param model {{
 *   summary, targets, extremes, lossEvents, verdict,
 *   env, speed, stun, run: {started, ended, interval, timeout, path, samples}
 * }}
 */
export function reportHtml(model, t = (x) => x) {
  const { summary, env, speed, stun, run } = model;
  const conn = env.connection;
  const title = t('Network latency report');
  const when = new Date(run.started);

  const dur = run.ended && run.started
    ? Math.max(1, Math.round((run.ended - run.started) / 1000))
    : null;

  const body = `<div class="sheet">
  <div class="rule"></div>
  <h1>${esc(title)}</h1>
  <p class="sub">${esc(run.targetsLabel || '')}</p>

  <dl class="meta">
    ${row(t('Client'), env.id)}
    ${row(t('Date'), when.toLocaleString())}
    ${row(t('Browser'), env.browser)}
    ${row(t('Platform'), env.platform)}
    ${row(t('Time zone'), `${env.timezone} (UTC${env.utcOffsetMin >= 0 ? '+' : ''}${Math.round(env.utcOffsetMin / 60)})`)}
    ${row(t('Public address'), stun && stun.publicIP ? `${stun.publicIP} (${stun.family})` : t('not determined'))}
    ${row(t('Run length'), dur ? `${dur} s` : '—')}
    ${row(t('Probe interval'), `${run.interval} ms`)}
    ${row(t('Probe path'), run.path)}
    ${row(t('Timeout'), `${run.timeout} ms`)}
  </dl>

  <h2>${esc(t('Summary'))}</h2>
  <div class="stats">
    ${stat(summary.sent, t('Requests'))}
    ${stat(ms(summary.min, 0), t('Best'))}
    ${stat(ms(summary.mean, 0), t('Average'))}
    ${stat(ms(summary.p95, 0), t('95th pct'))}
    ${stat(ms(summary.max, 0), t('Worst'))}
    ${stat(pct(summary.loss), t('Loss'), summary.loss >= 5 ? 'crit' : summary.loss > 0 ? 'adv' : 'good')}
  </div>
  <div class="${summary.loss >= 5 || (summary.p95 != null && summary.p95 > 250) ? 'alert' : 'clean'}">
    <b>${esc(t('Assessment'))}:</b> ${esc(model.verdict)}
  </div>

  <h2>${esc(t('Connection'))}</h2>
  <div class="stats">
    ${stat(speed && speed.mbps != null ? (speed.mbps >= 100 ? Math.round(speed.mbps) : speed.mbps.toFixed(1)) : '—', t('Mbit/s down'))}
    ${stat(stun && stun.rtt != null ? ms(stun.rtt, 0) : '—', t('STUN round trip'))}
    ${stat(conn.effectiveType || '—', t('Effective type'))}
    ${stat(conn.type || t('not published'), t('Interface'))}
  </div>
  <div class="note">
    <b>${esc(t('Downlink'))}:</b> ${esc(speed && speed.mbps != null
    ? t('measured before the latency run, over {n} parallel streams from a CDN, on an otherwise idle link. A lower bound on the line, not a substitute for a speed test with a nearby server.').replace('{n}', speed.streams)
    : t('not measured for this run.'))}<br>
    <b>${esc(t('Interface'))}:</b> ${esc(t('No web API reports the network interface in use. Browsers replace the local address with a random .local name specifically so a page cannot enumerate the network, so a wired/wireless answer is only available where the operating system publishes it — Chromium on Android and ChromeOS. Everywhere else this field reads "not published" rather than guessing.'))}
  </div>

  <h2>${esc(t('Per target'))}</h2>
  ${targetsTable(model.targets, t)}
  <p class="muted" style="font-size:10.5px">${esc(t('Average is the arithmetic mean of answered probes. The first request to each host is excluded throughout: it pays DNS and the TLS handshake and is not representative of the steady state.'))}</p>

  <h2>${esc(t('Peaks and lows'))}</h2>
  ${extremesTable(model.extremes, t)}

  <h2>${esc(t('Unanswered probes'))}</h2>
  ${lossTable(model.lossEvents, t)}

  <h2>${esc(t('Method and limits'))}</h2>
  <div class="note">${esc(model.method)}</div>
  <p class="muted" style="font-size:10.5px">${esc(t('This report summarises {n} samples. The complete per-sample record is not printed here by design — export CSV, XLSX or ODS from the tool for that.').replace('{n}', run.samples))}</p>

  <footer>
    <span>${esc(env.id)}</span>
    <span>${esc(t('Generated with Ping · ping.carino.systems'))}</span>
  </footer>
</div>`;

  return `<!DOCTYPE html>
<html lang="${esc(document.documentElement.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}${run.targetsLabel ? ' — ' + esc(run.targetsLabel) : ''}</title>
<style>${styles()}</style>
</head>
<body>
<div class="toolbar"><button onclick="window.print()">${esc(t('Print / Save as PDF'))}</button></div>
${body}
</body>
</html>`;
}

/** Open the report in a new tab, the way Topo does. */
export function openReport(html, t = (x) => x) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const tab = window.open(url, '_blank');
  if (!tab) {
    URL.revokeObjectURL(url);
    throw new Error(t('The report opens in a new tab — allow pop-ups for this site and try again.'));
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
