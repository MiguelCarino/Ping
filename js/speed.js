/* speed.js — downlink throughput, measured before the latency run.

   Why before, and not during: a saturated link is a link with a full queue, and
   a full queue is exactly what adds delay to everything behind it. Running a
   throughput test while probing would not "measure latency under load", it
   would quietly corrupt every sample taken during it. So the test runs to
   completion first, the result is held as context for the run, and the probing
   starts on an idle line.

   How it works without a server of our own: a handful of CDN assets of known
   size are fetched in parallel and the bytes are read back from the Resource
   Timing entries. `encodedBodySize` is the number actually pulled over the
   wire (post-compression), and it is only exposed when the origin sends
   `Timing-Allow-Origin` — cdnjs does, which is why the assets come from there
   rather than from somewhere prettier.

   Three details that separate this from a naive "time one download":

   - Parallel streams. A single TCP/QUIC stream on a long path is limited by
     its congestion window, not by the line, and will under-report a fast
     connection badly. Six concurrent streams is what the public speed tests
     settle on for the same reason.
   - Slow start is discarded. The first stretch of a connection is the
     congestion window ramping, not the link's capacity, so the measurement
     window opens only after a warm-up period.
   - Reported as a floor, not a headline. This measures what the browser
     managed to pull from one CDN over a few seconds. It is a reasonable lower
     bound on the line, and it is not a substitute for a dedicated speed test
     with a nearby server — the UI says so rather than implying otherwise. */

const ASSETS = [
  // ~1.2 MB each, stable URLs, all with Timing-Allow-Origin.
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tensorflow/4.22.0/tf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.1/echarts.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs/editor/editor.main.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js',
];

const STREAMS = 6;
const WARMUP_MS = 600;     // congestion window ramp, excluded from the maths
const WINDOW_MS = 3500;    // measurement window after the warm-up

/**
 * @param onProgress  called with (mbps, elapsedFraction) while running
 * @returns {Promise<{mbps:number|null, bytes:number, seconds:number, streams:number, partial:boolean, reason?:string}>}
 */
export async function measureDownlink({ onProgress, signal } = {}) {
  if (!('fetch' in window)) return { mbps: null, bytes: 0, seconds: 0, streams: 0, partial: true, reason: 'unsupported' };

  const marks = [];               // { href, started }
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', stop, { once: true });

  const t0 = performance.now();
  const deadline = t0 + WARMUP_MS + WINDOW_MS;

  // Each stream loops over the asset list until the deadline, so a fast line
  // does not simply run out of bytes half a second in.
  const runStream = async (i) => {
    let n = i;
    while (performance.now() < deadline && !ctrl.signal.aborted) {
      const base = ASSETS[n++ % ASSETS.length];
      const u = new URL(base);
      u.searchParams.set('_cp', Math.random().toString(36).slice(2));
      const href = u.href;
      const started = performance.now();
      try {
        await fetch(href, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
        marks.push({ href, started });
      } catch {
        if (ctrl.signal.aborted) return;
        // A single failed asset is not a failed test; the other streams carry it.
      }
    }
  };

  let ticker;
  if (onProgress) {
    ticker = setInterval(() => {
      const el = performance.now() - t0;
      onProgress(null, Math.min(1, el / (WARMUP_MS + WINDOW_MS)));
    }, 200);
  }

  await Promise.all(Array.from({ length: STREAMS }, (_, i) => runStream(i)));
  clearInterval(ticker);
  if (signal) signal.removeEventListener('abort', stop);

  // Resource Timing entries arrive a beat after their fetch settles, same as in
  // probe.js. Give them a moment before reading the buffer.
  await new Promise((r) => setTimeout(r, 300));

  let bytes = 0, counted = 0, taoMissing = 0;
  let first = Infinity, last = 0;
  for (const m of marks) {
    const e = performance.getEntriesByName(m.href, 'resource').pop();
    if (!e) continue;
    // Only transfers that finished after the warm-up count toward the rate.
    if (e.responseEnd < WARMUP_MS) continue;
    const size = e.encodedBodySize || e.transferSize || 0;
    if (!size) { taoMissing++; continue; }
    bytes += size;
    counted++;
    first = Math.min(first, e.startTime);
    last = Math.max(last, e.responseEnd);
  }

  if (!counted || !isFinite(first) || last <= first) {
    return {
      mbps: null, bytes: 0, seconds: 0, streams: STREAMS, partial: true,
      reason: taoMissing ? 'no-timing-permission' : 'no-data',
    };
  }

  const seconds = (last - first) / 1000;
  const mbps = (bytes * 8) / 1e6 / seconds;
  return { mbps, bytes, seconds, streams: STREAMS, partial: ctrl.signal.aborted };
}

export function fmtMbps(v) {
  if (v == null) return '—';
  if (v >= 100) return `${Math.round(v)} Mbit/s`;
  if (v >= 10) return `${v.toFixed(1)} Mbit/s`;
  return `${v.toFixed(2)} Mbit/s`;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'kB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
