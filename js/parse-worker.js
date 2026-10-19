/* parse-worker.js — runs the parse engine off the main thread.

   A log can be hundreds of megabytes. The worker is handed the File itself
   (cloning a File copies a handle, not its bytes), reads and decodes it in a
   stream, parses it, and keeps the decoded text: the page receives only the
   sample columns, transferred rather than copied, and asks for individual
   lines when it needs them (the row tooltips). A re-parse after an override
   reuses the text already here.

   Messages in:   { id, op: 'file', file, opts } | { id, op: 'text', text, opts }
                  | { id, op: 'reparse', opts }  | { id, op: 'lines', nums }
   Messages out:  { id, progress } along the way, then { id, ok, res | lines }
                  or { id, ok: false, error }. */

import { createEngine, transferables } from './parse.js';

const engine = createEngine();

self.onmessage = async (e) => {
  const { id, op, opts } = e.data;
  const progress = (p) => self.postMessage({ id, progress: p });
  try {
    if (op === 'lines') {
      self.postMessage({ id, ok: true, lines: engine.lines(e.data.nums) });
      return;
    }
    if (op === 'file') await engine.loadFile(e.data.file, progress);
    else if (op === 'text') engine.loadText(e.data.text);
    const res = engine.parse(opts, progress);
    progress({ phase: 'send', rows: res.n });
    self.postMessage({ id, ok: true, res }, transferables(res));
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
