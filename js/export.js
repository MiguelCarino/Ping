/* export.js — the complete per-sample record, as CSV, XLSX or ODS.

   This is the full log: every probe, with its phase split. The *report*
   (report.js) deliberately prints only the distribution and the extremes,
   because nobody reads sample 300 of 500 — so these three formats are where
   the raw record lives, and the report points at them.

   CSV needs no library at all. SheetJS is vendored and loaded on demand, so a
   page view that never exports a spreadsheet never pays for it. jsPDF is gone
   entirely: the report is HTML that the browser prints, which is how Topo does
   it, and dropping the dependency took ~900 kB of vendored script with it. */

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
