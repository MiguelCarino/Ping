# Ping

Client-side network latency measurement — part of [Carino Systems](https://carino.systems). Live at **ping.carino.systems**.

Round trip, jitter, packet loss and the DNS/TCP/TLS/TTFB split for any set of websites, measured from your own browser. Nothing is uploaded; the only traffic is the probes themselves, going to the hosts you name.

## What it measures, and what it cannot

**A browser cannot send ICMP.** No web API exposes raw sockets, so the `ping` command's actual protocol is unavailable to any web page — and a page claiming otherwise is timing something else. What this does instead:

- **HTTPS round trip.** One `fetch` per probe, `mode: 'no-cors'`, cache and credentials off, aborted at the timeout via `AbortController`. An opaque response means the host answered; a rejection means it did not. That distinction is the measurement.
- **The phase split, where the server permits it.** If a target sends `Timing-Allow-Origin`, the Resource Timing API exposes DNS, TCP, TLS, TTFB and transfer separately, and the headline number becomes **time-to-first-byte** — mostly propagation delay, and the closest thing a browser has to an ICMP RTT. Without that header only the total is visible, which still contains server processing and transfer time. Every card and row says which one it got.
- **Cold vs warm.** The first request to a host pays DNS plus both handshakes — routinely several times the steady-state round trip. It is shown, exported, and excluded from every statistic.
- **STUN baseline.** A STUN binding exchange is UDP with no TLS and no server-side work, so the time to the first server-reflexive candidate is very nearly the raw network round trip to the public internet. It is the floor to compare HTTP readings against: the gap is everything the protocol stack adds on top of distance.

The Resource Timing entry is **not** available the moment `await fetch()` resolves — it lands a beat later, so the probe waits for it through a `PerformanceObserver` with a short grace period. Reading it synchronously is the obvious way to write this and silently downgrades every target to *total only*.

Statistics are **min / p50 / p95 / max, jitter (RFC 3550 mean absolute successive difference) and loss** — not a running mean. Queueing delay is one-sided, so a mean is dragged permanently by a single outlier while the minimum stays the best estimate of the actual path.

**An IP address is not an ICMP ping.** A few answer — `8.8.8.8`, `1.1.1.1` and `9.9.9.9` serve HTTPS with certificates valid for the address, so they return a real number, but it is their web server's round trip rather than the address's reachability. Most other addresses have no HTTPS listener or no certificate for the literal and come back unreachable, which says nothing about whether the host is up.

## Using it

Static site, no build step — serve the folder or open it on GitHub Pages.

Enter comma-separated hostnames, pick an interval and a timeout, press **Start**. Each target runs its own self-correcting loop: the next wait is measured from when the last probe *began*, and a target never has two probes outstanding, so a 500 ms interval against a 900 ms host degrades to back-to-back probes rather than piling up a queue and measuring itself.

The probe path defaults to `/favicon.ico` — small, present almost everywhere, and cheap to serve. Point it at a health endpoint instead if you have one.

Background tabs are paused by default: browsers clamp timers to roughly one second there, so readings taken in a hidden tab measure the throttle rather than the network. The checkbox overrides it for a deliberate long run.

Exports: **CSV** (no library), **XLSX**/**ODS** (SheetJS) and a **PDF report** (jsPDF) that states the method and its limits on the page, with per-target and per-sample tables. Every export carries the phase columns, not just the totals.

## Shape

One screen, no page scroll. The body is exactly the viewport tall with `overflow:hidden`; the shared navbar takes its 60px and the app takes the rest. The target cards and the sample log scroll inside their own panes, and the method notes live in a dialog rather than below a fold. Verified at ten viewport sizes from 1920×1080 down to 360×640 and 740×360 (landscape phone), idle and mid-run, in both axes.

When height runs short the layout degrades in a deliberate order rather than growing a scrollbar: the tiles' caption line goes first, then the panes' minimum heights, then the verdict sentence — which is the one element whose meaning the colour of the loss tile already carries.

## Architecture

Plain ES modules, no framework, no CDN, no build step.

```
index.html · css/ping.css · i18n.js   fixed-viewport shell, method dialog
js/probe.js    the measurement: fetch + Resource Timing + STUN, cold/warm
js/stats.js    Series, quantiles, jitter, loss, verdict bands
js/viz.js      dependency-free canvas chart + SVG sparkline + phase bar
js/export.js   CSV native; SheetJS and jsPDF loaded from ./vendor on demand
js/app.js      targets, per-target loops, rendering
vendor/        xlsx, jspdf, jspdf-autotable (vendored, never a CDN)
fonts/         IBM Plex Sans/Mono + Red Hat Display, self-hosted
carino-navbar.js · carino-clock.js · carino-lang.js   the shared fleet chrome
```

The export libraries are fetched only when someone presses an export button, so a page view that never exports pays none of their 1.3 MB.

Five languages (en / es / pt-BR / ja / ru) through the fleet resolver, `carino-lang.js`; a pick on any Carino subdomain applies across the fleet.

## Licence

AGPL-3.0-or-later — see [LICENSE](LICENSE).
