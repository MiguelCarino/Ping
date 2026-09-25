/* export.js — CSV, XLSX, ODS and a PDF report, from vendored libraries only.

   The fleet does not load script from a CDN, so SheetJS and jsPDF live in
   ./vendor and are loaded on demand: a page that never exports never pays the
   1.3 MB. The previous version pulled both (plus Tailwind and Chart.js) on
   every single load, whether or not anyone pressed a button.

   The exported rows carry the phase columns too. An export that only says
   "142 ms" throws away the one thing that makes the reading actionable —
   whether those 142 ms were DNS, the TLS handshake, or the path itself. */

const loaded = new Set();

function loadScript(src) {
  if (loaded.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { loaded.add(src); resolve(); };
    s.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
}

export const COLUMNS = [
  'Seq', 'Timestamp', 'Target', 'Status', 'RTT (ms)', 'Source',
  'DNS (ms)', 'TCP (ms)', 'TLS (ms)', 'TTFB (ms)', 'Transfer (ms)', 'Total (ms)', 'Phase',
];

const n1 = (v) => (v == null ? '' : Number(v.toFixed(1)));

export function toRows(log) {
  return log.map((r) => [
    r.seq,
    new Date(r.at).toISOString(),
    r.target,
    r.ok ? 'OK' : (r.timedOut ? 'TIMEOUT' : 'UNREACHABLE'),
    n1(r.rtt),
    r.ok ? (r.detail ? 'TTFB (Timing-Allow-Origin)' : 'total (no timing permission)') : '',
    n1(r.dns), n1(r.tcp), n1(r.tls), n1(r.ttfb), n1(r.transfer), n1(r.total),
    r.cold ? 'cold (includes handshake)' : (r.ok ? 'warm' : ''),
  ]);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV needs no library at all — RFC 4180 quoting is four lines. */
export function exportCSV(log) {
  const rows = [COLUMNS, ...toRows(log)];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `carino-ping-${stamp()}.csv`);
}

export async function exportSheet(log, format /* 'xlsx' | 'ods' */) {
  await loadScript('vendor/xlsx.full.min.js');
  const ws = XLSX.utils.aoa_to_sheet([COLUMNS, ...toRows(log)]);
  ws['!cols'] = COLUMNS.map((c) => ({ wch: Math.max(10, c.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Latency');
  XLSX.writeFile(wb, `carino-ping-${stamp()}.${format}`, { bookType: format });
}

/**
 * The PDF report. Written as a document someone can hand to a provider, so it
 * states the method and its limits on the page rather than implying a browser
 * measured ICMP. The old report asserted "routing and connection stability
 * appear nominal" off a mean that counted no failures at all.
 */
export async function exportPDF(log, { summary, perTarget, method, verdict }) {
  await loadScript('vendor/jspdf.umd.min.js');
  await loadScript('vendor/jspdf.plugin.autotable.min.js');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const GOLD = [234, 179, 8];
  const M = 14;
  let y = 20;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  doc.text('Carino Ping — latency report', M, y);
  y += 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(110);
  doc.text(`Generated ${new Date().toLocaleString()} · ping.carino.systems`, M, y);
  y += 10;

  doc.setTextColor(0); doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  doc.text('Summary', M, y); y += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  const f = (v, u = ' ms') => (v == null ? '—' : v.toFixed(1) + u);
  const lines = [
    `Targets: ${summary.targets}   Requests sent: ${summary.sent}   Lost: ${summary.lost} (${summary.loss.toFixed(1)}%)`,
    `Best (min): ${f(summary.min)}    Median (p50): ${f(summary.p50)}    95th percentile: ${f(summary.p95)}`,
    `Worst: ${f(summary.max)}    Jitter: ${f(summary.jitter)}`,
  ];
  for (const l of lines) { doc.text(l, M, y); y += 5.5; }
  y += 2;

  doc.setFont('helvetica', 'bold');
  doc.text('Assessment', M, y); y += 5.5;
  doc.setFont('helvetica', 'normal');
  for (const l of doc.splitTextToSize(verdict, 182)) { doc.text(l, M, y); y += 5; }
  y += 3;

  doc.setFont('helvetica', 'bold');
  doc.text('Method and limits', M, y); y += 5.5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90);
  for (const l of doc.splitTextToSize(method, 182)) { doc.text(l, M, y); y += 4; }
  doc.setTextColor(0); doc.setFontSize(10);
  y += 4;

  doc.autoTable({
    startY: y,
    head: [['Target', 'Sent', 'Loss %', 'Min', 'p50', 'p95', 'Max', 'Jitter', 'Timing']],
    body: perTarget.map((t) => [
      t.label, t.sent, t.loss.toFixed(1),
      f(t.min, ''), f(t.p50, ''), f(t.p95, ''), f(t.max, ''), f(t.jitter, ''),
      t.detail ? 'TTFB' : 'total only',
    ]),
    theme: 'grid',
    headStyles: { fillColor: GOLD, textColor: [0, 0, 0], fontStyle: 'bold' },
    styles: { fontSize: 8, cellPadding: 1.8 },
    margin: { left: M, right: M },
  });

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 8,
    head: [COLUMNS],
    body: toRows(log),
    theme: 'striped',
    headStyles: { fillColor: GOLD, textColor: [0, 0, 0], fontStyle: 'bold' },
    styles: { fontSize: 6.5, cellPadding: 1.1 },
    margin: { left: M, right: M },
  });

  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5); doc.setTextColor(140);
    doc.text(`Carino Systems · page ${p} of ${pages}`, M, doc.internal.pageSize.getHeight() - 8);
  }
  doc.save(`carino-ping-${stamp()}.pdf`);
}
