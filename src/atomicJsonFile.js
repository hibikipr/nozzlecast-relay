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
//
// Durability: the relay runs on a Raspberry Pi's SD card, where a power cut is a realistic way to
// stop it. Renaming a tmp file that was never fsynced can leave a zero-length or partial file
// behind after one, and the stores used to treat an unparseable file as "start with an empty
// list" -- which the next save then made permanent, dropping every registered token until each
// device's app re-registered. So the tmp file is fsynced before the rename, the previous good
// file is kept as `<file>.bak`, and read() falls back to that backup when the main file won't
// parse.
class AtomicJsonFile {
  constructor(filePath) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this._queue = Promise.resolve();
  }

  write(getData) {
    const run = async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      const handle = await fs.open(tmpPath, 'w');
      try {
        await handle.writeFile(JSON.stringify(getData(), null, 2), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.copyFile(this.filePath, this.backupPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.rename(tmpPath, this.filePath);
    };
    // .then(run, run) so one failed write doesn't permanently wedge the queue for later callers.
    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  // Returns the parsed contents, or undefined when the file doesn't exist yet. When the main file
  // exists but won't parse, returns the backup's contents instead (logged); throws the original
  // SyntaxError only when neither is usable.
  async read() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      try {
        const backup = JSON.parse(await fs.readFile(this.backupPath, 'utf8'));
        console.error(`${path.basename(this.filePath)} is corrupt (${error.message}); loaded ${path.basename(this.backupPath)} instead`);
        return backup;
      } catch {
        throw error;
      }
    }
  }
}

module.exports = { AtomicJsonFile };
