/* client.js — who and what took the measurement.

   A latency report with no idea where it was taken from is an anecdote. When
   three sites send back readings for the same target, the thing that makes them
   comparable is knowing which machine, which browser and which connection each
   one came from.

   The identifier is generated here, in the browser, and never leaves it except
   inside a report the user exports themselves. It is a random value — not a
   fingerprint, not derived from hardware, not stable across browsers or
   profiles, and clearable by clearing site data. Its whole job is to let one
   person say "these four reports are from the same laptop".

   What this file will NOT tell you is the network interface. There is no web
   API for it, and that is deliberate rather than an oversight: Chrome and
   Firefox replace WebRTC host candidates with a random `<uuid>.local` mDNS name
   precisely so a page cannot enumerate the local network. `navigator.connection.type`
   is the nearest thing, and only Chromium on Android and ChromeOS actually
   populates it — on desktop it is undefined, and Firefox and Safari do not ship
   the API at all. Everything here reports "not published" rather than guessing. */

const KEY = 'carino-ping/client';

/** Stable-per-browser random id, e.g. "CP-4F2A-91C7". */
export function clientId() {
  let id = null;
  try { id = localStorage.getItem(KEY); } catch { /* private mode */ }
  if (id) return id;
  const rnd = new Uint8Array(4);
  (crypto.getRandomValues ? crypto : { getRandomValues: (a) => a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); }) })
    .getRandomValues(rnd);
  const hex = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  id = `CP-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
  try { localStorage.setItem(KEY, id); } catch { /* not fatal, id is per-session then */ }
  return id;
}

/** Best-effort platform name from UA-CH, falling back to the UA string. */
function platform() {
  const ua = navigator.userAgentData;
  if (ua && ua.platform) return ua.platform;
  const s = navigator.userAgent;
  if (/Windows NT/.test(s)) return 'Windows';
  if (/Mac OS X/.test(s)) return 'macOS';
  if (/Android/.test(s)) return 'Android';
  if (/(iPhone|iPad|iPod)/.test(s)) return 'iOS';
  if (/Linux/.test(s)) return 'Linux';
  return 'Unknown';
}

/** Browser name and major version, from UA-CH brands where available. */
function browser() {
  const ua = navigator.userAgentData;
  if (ua && Array.isArray(ua.brands)) {
    // Skip the deliberate padding entry. Its exact spelling is intentionally
    // random per browser build — "Not)A;Brand", "Not_A Brand", "Not.A/Brand" —
    // so the match has to ignore whatever punctuation it was given this time.
    const real = ua.brands.filter((b) => !/not.{0,2}a.{0,2}brand/i.test(b.brand));
    const pick = real.find((b) => !/Chromium/i.test(b.brand)) || real[0];
    if (pick) return `${pick.brand} ${pick.version}`;
  }
  const s = navigator.userAgent;
  const m = s.match(/(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/);
  if (!m) return 'Unknown';
  const name = { Edg: 'Edge', OPR: 'Opera' }[m[1]] || m[1];
  return `${name} ${m[2]}`;
}

/**
 * Connection facts the browser is willing to publish. Every field is either a
 * real value or null — nothing here is inferred.
 */
export function connection() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  return {
    // 'wifi' | 'cellular' | 'ethernet' | 'none' | … — Chromium on Android and
    // ChromeOS only. Undefined everywhere else, which is why it is surfaced as
    // "not published" rather than guessed at from the effective type.
    type: (c && c.type) || null,
    effectiveType: (c && c.effectiveType) || null,
    downlinkHint: (c && typeof c.downlink === 'number') ? c.downlink : null,
    rttHint: (c && typeof c.rtt === 'number') ? c.rtt : null,
    saveData: c ? !!c.saveData : null,
    supported: !!c,
  };
}

export function environment() {
  const nav = navigator;
  return {
    id: clientId(),
    browser: browser(),
    platform: platform(),
    languages: (nav.languages && nav.languages.slice(0, 3).join(', ')) || nav.language || '',
    timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || '',
    utcOffsetMin: -new Date().getTimezoneOffset(),
    screen: `${screen.width}x${screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio || 1,
    cores: nav.hardwareConcurrency || null,
    memoryGB: nav.deviceMemory || null,
    online: nav.onLine,
    connection: connection(),
  };
}

/** One-line human summary for the status strip. */
export function connectionLabel(conn, t = (x) => x) {
  if (!conn.supported) return t('not published by this browser');
  const bits = [];
  if (conn.type) bits.push(conn.type);
  if (conn.effectiveType) bits.push(conn.effectiveType);
  if (conn.rttHint != null) bits.push(`~${conn.rttHint} ms`);
  return bits.length ? bits.join(' · ') : t('not published by this browser');
}

/* ---- reverse DNS --------------------------------------------------------- */

/**
 * PTR lookup for the public address, so the strip can say
 * "acceso-201-103-33-159.prod-infinitum.com.mx" rather than a bare number —
 * the hostname usually names the ISP and the access technology, which is the
 * part a reader of the report can actually act on.
 *
 * A browser has no resolver API, so this goes over DNS-over-HTTPS. That is a
 * request to a third party, which is why it runs only inside the connection
 * step the user already triggered (Start or Test), never on page load, and why
 * the resolver is named on screen next to the result.
 *
 * Cloudflare first, Google as fallback. Failure is not an error: plenty of
 * addresses have no PTR at all, and the caller simply keeps showing the IP.
 */
export async function reverseDNS(ip, { timeout = 3500 } = {}) {
  if (!ip) return null;
  const name = ip.includes(':') ? ip6Arpa(ip) : ip4Arpa(ip);
  if (!name) return null;

  const endpoints = [
    { url: `https://cloudflare-dns.com/dns-query?name=${name}&type=PTR`, headers: { accept: 'application/dns-json' } },
    { url: `https://dns.google/resolve?name=${name}&type=PTR`, headers: { accept: 'application/json' } },
  ];

  for (const ep of endpoints) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(ep.url, { headers: ep.headers, signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
      if (!res.ok) continue;
      const j = await res.json();
      const ans = (j.Answer || []).filter((a) => a.type === 12 && a.data);
      if (ans.length) return String(ans[0].data).replace(/\.$/, '');
      if (j.Status === 3 || j.Status === 0) return null;   // NXDOMAIN, or no PTR
    } catch {
      // try the next resolver
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function ip4Arpa(ip) {
  const p = ip.split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x))) return null;
  return `${p[3]}.${p[2]}.${p[1]}.${p[0]}.in-addr.arpa`;
}

// IPv6 PTR is the 32 nibbles reversed. Expand the :: shorthand first.
function ip6Arpa(ip) {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts[1] !== undefined ? (parts[1] ? parts[1].split(':') : []) : null;
  let groups;
  if (tail === null) groups = head;
  else groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const nibbles = groups.map((g) => g.padStart(4, '0')).join('');
  if (!/^[0-9a-f]{32}$/i.test(nibbles)) return null;
  return nibbles.split('').reverse().join('.').toLowerCase() + '.ip6.arpa';
}
