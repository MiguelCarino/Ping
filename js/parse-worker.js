/* parse-worker.js — runs parse.js off the main thread.

   A week of `ping -t` is ~600 000 lines. Parsing that is fast (a few hundred
   milliseconds) but not free, and on the main thread it would freeze the page
   for exactly the moment someone is watching it. Progress goes back as
   `{ id, progress }` messages along the way, so the page can show where the
   parse is. The first message carries
   the file's bytes, decoded here; a re-parse after an override sends the text
   back instead, so the decode is not repeated. */

import { decode, parseLog } from './parse.js';

self.onmessage = (e) => {
  const { id, buf, text: given, opts } = e.data;
  const progress = (p) => self.postMessage({ id, progress: p });
  try {
    let text = given, encoding = null;
    if (text == null) {
      progress({ phase: 'decode' });
      ({ text, encoding } = decode(buf));
    }
    const res = parseLog(text, { ...opts, onProgress: progress });
    res.encoding = encoding || opts.encoding || null;
    // Copying the result back is its own pause on a big log; say so.
    progress({ phase: 'send', rows: res.samples.length });
    self.postMessage({ id, ok: true, res, text: given == null ? text : null });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
