const fs = require('node:fs/promises');
const path = require('node:path');

// Serializes writes to the same file behind a promise queue. Both token stores previously wrote
// straight to a fixed `<file>.tmp` path and renamed it with no serialization: two concurrent
// save() calls (e.g. a burst of rapid /register-device retries) could both write that same tmp
// path, and whichever rename ran second threw ENOENT -- the first rename had already consumed
// it -- as an unhandled rejection that crashed the whole process. Confirmed live 2026-09-06.
//
// Queuing preserves correctness, not just avoids the crash: `getData` is a function, not a
// precomputed value, so each queued write reads the caller's *current* in-memory state at its
// own turn rather than a stale snapshot taken when it was enqueued -- no update is ever lost to
// an earlier write finishing after a later one.
class AtomicJsonFile {
  constructor(filePath) {
    this.filePath = filePath;
    this._queue = Promise.resolve();
  }

  write(getData) {
    const run = async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(getData(), null, 2), 'utf8');
      await fs.rename(tmpPath, this.filePath);
    };
    // .then(run, run) so one failed write doesn't permanently wedge the queue for later callers.
    this._queue = this._queue.then(run, run);
    return this._queue;
  }
}

module.exports = { AtomicJsonFile };
