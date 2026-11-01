const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizedID } = require('./parsing');
const { renderCover } = require('./coverRender');
const { extractPlateImage, plateFromGcodeFile, platePrediction } = require('./printFile');
const { downloadPrintFile } = require('./printerFtps');

// Each archived print's cover, kept by Bambuddy archive id, for the prints Bambuddy archived
// without one. Bambuddy only stores a thumbnail when it gets the job's 3MF, and it doesn't fetch
// it for an HTTPS-dispatched print (it reads the https:// link as internal storage,
// maziggy/bambuddy#3382), so its print history has no picture for those. The relay reads the same
// print's cover off the printer for the Live Activity anyway; this keeps a copy per print, so
// NozzleCast's print history can show it (GET /cover/archive/:id).
//
// Keyed by archive, not job name: a printer keeps one file per name and a reprint overwrites it,
// so the same name ("0.2mm layer, 2 walls, 10% infill") can be several different models.

// A composed copy (the model on its contrast backdrop, square, as JPEG): tens of KB each, not the
// plate PNG or the 3MF. Oldest beyond MAX_FILES are removed.
const COVER_SIZE = 256;
const MAX_FILES = 3000;
// An archive whose cover couldn't be found isn't looked for again for this long.
const MISS_RETRY_MS = 24 * 60 * 60 * 1000;
// At print start, the archive Bambuddy made for this print started at most this long before the
// relay saw it start (Bambuddy archives as the print begins; the relay polls every few seconds).
const START_SLACK_MS = 15 * 60 * 1000;
// How many of a printer's archives are checked when backfilling, to find whether a newer print
// reused the job name (and so overwrote its file on the printer).
const BACKFILL_ARCHIVE_WINDOW = 500;
// A finished print whose actual run time is this close to the file's predicted time for its plate
// is taken to be the same model (an observed reprint ran 2-5% over the prediction).
const RUN_TIME_TOLERANCE = 0.1;

// Bambuddy's timestamps are UTC without an offset ("2026-10-31T21:11:01"); Date.parse would read
// those as local time.
function parseBambuddyTime(value) {
  if (!value) return null;
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const time = Date.parse(withZone);
  return Number.isNaN(time) ? null : time;
}

class ArchiveCoverStore {
  constructor(dir, { maxFiles = MAX_FILES } = {}) {
    this.dir = dir;
    this.maxFiles = maxFiles;
  }

  file(archiveId) {
    return path.join(this.dir, `${Number(archiveId)}.jpg`);
  }

  async get(archiveId) {
    try {
      return await fs.readFile(this.file(archiveId));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async has(archiveId) {
    return (await this.get(archiveId)) !== null;
  }

  // Saves `png` (a plate render) composed for display, written to a temp file and renamed so a
  // crash never leaves half an image behind. Returns the saved JPEG.
  async save(archiveId, png) {
    const { body } = await renderCover(png, { width: COVER_SIZE, height: COVER_SIZE, format: 'jpeg', quality: 85, background: 'auto' });
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.file(archiveId);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, body);
    await fs.rename(temp, target);
    await this.prune();
    return body;
  }

  async prune() {
    const names = (await fs.readdir(this.dir)).filter((name) => name.endsWith('.jpg'));
    if (names.length <= this.maxFiles) return;
    const files = await Promise.all(names.map(async (name) => {
      const file = path.join(this.dir, name);
      return { file, mtime: (await fs.stat(file)).mtimeMs };
    }));
    files.sort((a, b) => a.mtime - b.mtime);
    await Promise.all(files.slice(0, files.length - this.maxFiles).map(({ file }) => fs.rm(file, { force: true })));
  }
}

class ArchiveCoverService {
  constructor({
    store, bambuddyClient, coverService, downloadFile = downloadPrintFile, now = Date.now,
  }) {
    this.store = store;
    this.bambuddyClient = bambuddyClient;
    this.coverService = coverService;
    this.downloadFile = downloadFile;
    this.now = now;
    this.captured = new Map(); // Bambuddy printer id -> key of the print last saved
    this.misses = new Map(); // archive id -> when it was last looked for in vain
    this.inflight = new Map(); // archive id -> Promise
    this.printerQueues = new Map(); // Bambuddy printer id -> Promise, one FTPS session at a time
  }

  // Saves the running print's cover under the archive Bambuddy made for it, once per print.
  // Called as a print starts, with each correction and at its end: the archive can appear a
  // moment after the start. `startedAt` is when the relay saw the print start (ISO), or null.
  async capture({ printer, status, startedAt = null }) {
    const jobName = status?.subtask_name;
    if (!jobName) return;
    const key = `${jobName}|${startedAt ?? ''}`;
    if (this.captured.get(printer.id) === key) return;

    const archive = await this.archiveFor(printer, jobName, startedAt);
    if (!archive) return; // not archived yet: the next call looks again
    if (archive.thumbnail_path || await this.store.has(archive.id)) {
      this.captured.set(printer.id, key);
      return;
    }
    const { png } = await this.coverService.cover(printer, { status });
    await this.store.save(archive.id, png);
    this.misses.delete(archive.id);
    this.captured.set(printer.id, key);
    console.log(`Saved the cover of archive ${archive.id} ("${jobName}") on printer "${printer.name}"`);
  }

  async archiveFor(printer, jobName, startedAt) {
    const earliest = startedAt ? Date.parse(startedAt) - START_SLACK_MS : this.now() - MISS_RETRY_MS;
    // Bambuddy names an archive after the part of the job name past its last "/" ("CLICKER
    // VERSION OREO / LOVE" is archived as " LOVE"), so either form is this print's.
    const names = new Set([normalizedID(jobName), normalizedID(jobName.split('/').pop())]);
    const archives = await this.bambuddyClient.archives({ printerId: printer.id, limit: 5 });
    return archives
      .filter((archive) => names.has(normalizedID(archive.print_name ?? '')))
      .filter((archive) => (parseBambuddyTime(archive.started_at ?? archive.created_at) ?? 0) >= earliest)
      .sort((a, b) => b.id - a.id)[0] ?? null;
  }

  // The saved cover of an archive (JPEG), or, for one archived before covers were saved, its job
  // file read off the printer -- or null. A reprint under the same name overwrites the printer's
  // file, so for an archive a newer print reused the name of, the file may be a different model.
  // It's still trusted in two cases, both from a multi-plate project printed plate by plate:
  //  - a plate no newer same-name print used: the file has every plate's render, so this plate's
  //    is the one it printed (unless the project was edited between sends);
  //  - the same plate as a newer print, when this print finished and ran within 10% of the file's
  //    predicted time for that plate.
  // Anything else (a failed reprint of the same plate, a generic name reused for another model)
  // stays without a cover rather than show the wrong one.
  async cover(archiveId) {
    const saved = await this.store.get(archiveId);
    if (saved) return saved;
    const missedAt = this.misses.get(archiveId);
    if (missedAt !== undefined && this.now() - missedAt < MISS_RETRY_MS) return null;

    let lookup = this.inflight.get(archiveId);
    if (!lookup) {
      lookup = this.backfill(archiveId)
        .catch((error) => {
          console.log(`No cover for archive ${archiveId}: ${error.message}`);
          this.misses.set(archiveId, this.now());
          return null;
        })
        .finally(() => this.inflight.delete(archiveId));
      this.inflight.set(archiveId, lookup);
    }
    return lookup;
  }

  async backfill(archiveId) {
    const archive = await this.bambuddyClient.archive(archiveId);
    const jobName = archive.print_name;
    if (!jobName || archive.printer_id == null) throw new Error('the archive names no job or printer');

    const plate = archive.plate_id ?? plateFromGcodeFile(archive.filename);
    const newer = (await this.bambuddyClient.archives({ printerId: archive.printer_id, limit: BACKFILL_ARCHIVE_WINDOW }))
      .filter((other) => other.id > archive.id && normalizedID(other.print_name ?? '') === normalizedID(jobName));
    const nameReused = newer.length > 0;
    if (nameReused && plate === null) throw new Error(`a newer print reused the name "${jobName}" and this one names no plate`);
    const plateReused = newer.some((other) => (other.plate_id ?? plateFromGcodeFile(other.filename)) === plate);
    const ranFor = (parseBambuddyTime(archive.completed_at) ?? 0) - (parseBambuddyTime(archive.started_at) ?? 0);
    if (plateReused && (archive.status !== 'completed' || ranFor <= 0)) {
      throw new Error(`a newer print of "${jobName}" reused plate ${plate}, and this one didn't finish to compare its run time`);
    }

    const printer = (await this.bambuddyClient.printers()).find((candidate) => candidate.id === archive.printer_id);
    if (!printer) throw new Error(`Bambuddy no longer lists printer ${archive.printer_id}`);
    const accessCode = this.coverService.accessCodeFor(printer);
    if (!accessCode || !printer.ip_address) throw new Error(`no access code or IP address to read printer "${printer.name}"`);

    const file = await this.onPrinterQueue(printer.id, () => this.downloadFile({ host: printer.ip_address, accessCode, subtaskName: jobName }));
    if (!file) throw new Error(`printer "${printer.name}" no longer has a file for "${jobName}"`);
    const started = parseBambuddyTime(archive.started_at ?? archive.created_at);
    // A day's slack: the listing's time has no reliable zone. This only rules out a file older
    // than the print; a newer print of the same name was ruled out above.
    if (file.modifiedAt && started && file.modifiedAt.getTime() < started - MISS_RETRY_MS) {
      throw new Error(`${file.path} predates the print`);
    }

    if (plateReused) {
      const predicted = await platePrediction(file.data, plate);
      if (!predicted) throw new Error(`${file.path} has no predicted time for plate ${plate} to compare a reprint's run time with`);
      const off = Math.abs(ranFor / 1000 - predicted) / predicted;
      if (off > RUN_TIME_TOLERANCE) {
        throw new Error(`it ran ${Math.round(ranFor / 1000)} s, ${Math.round(off * 100)}% off the ${predicted} s predicted for plate ${plate}, so the printer's file may be another model`);
      }
    }
    const png = await extractPlateImage(file.data, { plate });
    if (!png) throw new Error(`${file.path} carries no plate render`);
    const saved = await this.store.save(archiveId, png);
    console.log(`Saved the cover of archive ${archiveId} ("${jobName}") from ${file.path} on printer "${printer.name}"`);
    return saved;
  }

  // One FTPS session per printer at a time: a print history scrolling into view asks for many
  // archives at once, and the printers' FTPS servers take few connections.
  onPrinterQueue(printerId, task) {
    const previous = this.printerQueues.get(printerId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    this.printerQueues.set(printerId, run.catch(() => {}));
    return run;
  }
}

module.exports = { ArchiveCoverStore, ArchiveCoverService, parseBambuddyTime };
