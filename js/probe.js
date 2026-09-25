/* probe.js — what a browser can honestly measure, and how.

   A browser cannot send ICMP. There is no API for it and there never has been:
   raw sockets are not exposed to page script. So "ping" here is a round trip
   over a real protocol, and the job of this file is to make that round trip as
   close to the network's own latency as the platform allows, and to say so
   when it cannot.

   Three things the old image-tag trick got wrong, which this fixes:

   1. `new Image()` fires `onerror` for a host that does not exist, for a 404,
      for a TLS failure and for a blocked request. Handling onload and onerror
      the same way — as the previous version did — turns every one of those
      into a *successful* sub-millisecond reading. A dead host scored better
      than a live one. `fetch(..., {mode:'no-cors'})` splits the two cases
      apart: an opaque response means bytes came back from somewhere, and a
      rejection means the request never completed. That distinction is the
      whole measurement.

   2. Wall-clock around the request measures DNS + TCP + TLS + request +
      server + transfer, all at once. The Resource Timing entry breaks that
      apart, and `responseStart - requestStart` (TTFB) is the one phase that is
      mostly propagation delay — the closest thing here to an ICMP RTT. Cross
      origin those fields read 0 unless the server sends `Timing-Allow-Origin`,
      so every sample records whether it got the detail or only a total, and
      the UI never mixes the two silently.

   3. The first request to a host pays DNS, the TCP handshake and the TLS
      handshake — routinely 3-5x the steady-state round trip. Averaging it in
      with the rest, as before, poisons the mean for the whole session. Every
      sample is tagged cold or warm, and the statistics only ever consider warm
      ones.

   A timeout is a real abort via AbortController, not `img.src = ''`, which
   does not reliably cancel an in-flight load. */

const DEFAULT_PATH = '/favicon.ico';

// Resource Timing keeps a bounded buffer (250 entries by default) and silently
// drops everything after it fills. Raise it, and sweep it when the field is
// quiet rather than mid-flight, since clearing is all-or-nothing.
let inflight = 0;
try { performance.setResourceTimingBufferSize(1000); } catch { /* not fatal */ }

function sweep() {
  if (inflight === 0 && performance.getEntriesByType('resource').length > 400) {
    performance.clearResourceTimings();
  }
}

/**
 * Resolve the PerformanceResourceTiming entry for a request that has just
 * finished, or null if it does not arrive in time.
 *
 * The grace period costs wall-clock time after the response, never inside the
 * measurement: every number reported comes from the entry itself or from the
 * clock reading taken before this is called.
 */
function awaitEntry(href, grace = 400) {
  return new Promise((resolve) => {
    const already = performance.getEntriesByName(href, 'resource').pop();
    if (already) return resolve(already);
    let obs, timer;
    const done = (entry) => {
      clearTimeout(timer);
      try { obs && obs.disconnect(); } catch { /* already gone */ }
      resolve(entry || null);
    };
    try {
      obs = new PerformanceObserver((list) => {
        const hit = list.getEntries().find((x) => x.name === href);
        if (hit) done(hit);
      });
      obs.observe({ type: 'resource', buffered: true });
    } catch {
      return resolve(null);                      // no PerformanceObserver here
    }
    timer = setTimeout(() => done(null), grace);
  });
}

/** Normalise user input into an absolute URL, or throw with a readable reason. */
export function toURL(target, path = DEFAULT_PATH) {
  let raw = String(target || '').trim();
  if (!raw) throw new Error('empty target');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  const u = new URL(raw);
  // A bare host gets the probe path; a target that already names a resource
  // keeps it, so "example.com/health" probes the health endpoint.
  if (u.pathname === '/' || u.pathname === '') u.pathname = path;
  return u;
}

/** True when this page is https: and the target is http: — the browser will
    block the request as mixed content before it reaches the network. Worth
    saying out loud, because the failure otherwise looks like packet loss. */
export function isMixedContent(url) {
  return location.protocol === 'https:' && url.protocol === 'http:';
}

/**
 * One probe.
 * @returns {Promise<Sample>} never rejects; failure is reported in the sample.
 *
 * Sample = {
 *   ok, timedOut, reason,
 *   rtt,            // the headline number: TTFB when detailed, else total
 *   detail,         // true when Timing-Allow-Origin gave us the phase split
 *   cold,           // first contact with this origin: includes the handshakes
 *   dns, tcp, tls, ttfb, transfer, total,
 *   at              // epoch ms the probe settled
 * }
 */
export async function probe(url, { timeout = 5000, cold = false } = {}) {
  // Unique per probe so the Resource Timing lookup is an exact match and no
  // cache — HTTP or preflight — can answer it in 0 ms.
  const u = new URL(url.href);
  u.searchParams.set('_cp', Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const href = u.href;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = performance.now();
  inflight++;

  let ok = false, timedOut = false, reason = '';
  try {
    await fetch(href, {
      mode: 'no-cors',          // opaque response: reached is all we need to know
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: ctrl.signal,
    });
    ok = true;
  } catch (err) {
    if (err && err.name === 'AbortError') { timedOut = true; reason = 'timeout'; }
    else { reason = 'unreachable'; }
  } finally {
    clearTimeout(timer);
    inflight--;
  }

  const total = performance.now() - t0;
  const s = {
    ok, timedOut, reason, cold,
    rtt: null, detail: false,
    dns: null, tcp: null, tls: null, ttfb: null, transfer: null,
    total: ok ? total : null,
    at: Date.now(),
  };
  if (!ok) { sweep(); return s; }

  // The entry is NOT there the instant the fetch settles — measured, not
  // assumed: immediately after `await fetch()` the buffer holds nothing, and
  // the entry turns up a moment later. Reading it synchronously (the obvious
  // way to write this) silently loses the phase split on every single probe
  // and quietly downgrades every target to "total only". So wait for it.
  const e = await awaitEntry(href);
  if (e) {
    s.total = e.duration || total;
    // requestStart is 0 for a cross-origin entry with no Timing-Allow-Origin.
    if (e.requestStart > 0 && e.responseStart > 0) {
      s.detail = true;
      s.dns = Math.max(0, e.domainLookupEnd - e.domainLookupStart);
      s.tcp = Math.max(0, e.connectEnd - e.connectStart);
      s.tls = e.secureConnectionStart > 0 ? Math.max(0, e.connectEnd - e.secureConnectionStart) : 0;
      s.ttfb = Math.max(0, e.responseStart - e.requestStart);
      s.transfer = Math.max(0, e.responseEnd - e.responseStart);
    }
  }
  s.rtt = s.detail ? s.ttfb : s.total;
  sweep();
  return s;
}

/* ---- STUN round trip -------------------------------------------------------
   The one place a browser gets genuinely close to ICMP. A STUN binding request
   is a small UDP exchange with no TLS, no HTTP and no server-side application
   work, so the time until the server-reflexive candidate arrives is very nearly
   the raw network round trip to that STUN server.

   It says nothing about any particular target — there is no peer to connect to,
   so `currentRoundTripTime` on a candidate pair never exists. What it does give
   is an honest floor for this machine's path to the public internet, which is
   the right thing to compare an HTTP reading against: the gap between them is
   everything HTTP adds on top of the wire. */
export function stunRTT(server = 'stun:stun.l.google.com:19302', timeout = 4000) {
  return new Promise((resolve) => {
    let pc, timer, done = false;
    const finish = (ms) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { pc && pc.close(); } catch { /* already closed */ }
      resolve(ms);
    };
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: server }], iceCandidatePoolSize: 0 });
    } catch {
      return resolve(null);                       // no WebRTC in this browser
    }
    pc.createDataChannel('probe');
    const t0 = performance.now();
    pc.onicecandidate = (ev) => {
      // srflx is the candidate the STUN server told us about; host candidates
      // are local and cost no round trip, so they are not the signal.
      if (ev.candidate && ev.candidate.candidate.includes('typ srflx')) {
        finish(performance.now() - t0);
      } else if (!ev.candidate) {
        finish(null);                             // gathering ended, no srflx
      }
    };
    timer = setTimeout(() => finish(null), timeout);
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(() => finish(null));
  });
}

/** The browser's own transport estimate, where it is published. Context, not a
    measurement we made: Chromium rounds it to 25 ms and Firefox omits it. */
export function connectionHint() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return null;
  return {
    rtt: typeof c.rtt === 'number' ? c.rtt : null,
    downlink: typeof c.downlink === 'number' ? c.downlink : null,
    effectiveType: c.effectiveType || null,
    saveData: !!c.saveData,
  };
}
