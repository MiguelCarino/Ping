/* arrive.js: a host handed over by another Carino page.

   Carino Topo's "Check in Ping" opens this page with the host after the
   hash: ping.carino.systems/#host=example.com. The hash is never sent to a
   server, and it is taken off the address once read. Nothing is probed until
   the person presses Start, as on any visit. */

/** A host name or an IP address, nothing else: no scheme, path, port list or spaces. */
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[?[0-9A-Fa-f:.]{2,45}\]?)$/;

/** "#host=example.com" -> "example.com"; anything else -> "". */
export function hostFromHash(hash) {
  const m = /^#host=([^&#]{1,255})$/.exec(String(hash || ''));
  if (!m) return '';
  let host = '';
  try { host = decodeURIComponent(m[1]).trim(); } catch { return ''; }
  return host.length <= 253 && HOST_RE.test(host) ? host : '';
}

/** The targets field with `host` first, once: "a, b" + "c" -> "c, a, b". */
export function withHostFirst(targets, host) {
  if (!host) return String(targets || '');
  const rest = String(targets || '').split(',').map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== host.toLowerCase());
  return [host, ...rest].join(', ');
}
