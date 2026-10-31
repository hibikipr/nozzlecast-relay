const crypto = require('node:crypto');
const { normalizedID } = require('./parsing');
const { downloadPrintFile } = require('./printerFtps');
const { extractPlateImage, plateFromGcodeFile } = require('./printFile');

// After a failed lookup, how long until the same job is tried again: doubles per failure up to
// the cap. A client polling every few seconds then costs at most one Bambuddy call (and maybe one
// FTPS listing) per backoff window, not one per request, while a render that turns up a few
// moments into a print still appears soon after.
const FAILURE_BACKOFF_MS = 30 * 1000;
const MAX_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

class CoverUnavailableError extends Error {}

// Parses PRINTER_ACCESS_CODES: comma-separated "<serial or printer name>:<access code>" pairs.
// Keys go through normalizedID, so "Vic H2C", "vic-h2c" and a serial in any case all match.
function parseAccessCodes(value) {
  const codes = new Map();
  for (const pair of (value || '').split(',')) {
    const separator = pair.lastIndexOf(':');
    if (separator <= 0) continue;
    const key = normalizedID(pair.slice(0, separator));
    const code = pair.slice(separator + 1).trim();
    if (key && code) codes.set(key, code);
  }
  return codes;
}

// The cover image (the sliced plate's PNG render) of a printer's current or last job. Bambuddy's
// own /cover is asked first -- it caches, and it is the only source when no access code is
// configured. When it has none, the 3MF is read straight off the printer over FTPS. That second
// path is what covers cloud prints and job names with a "/", which Bambuddy doesn't look for (see
// printerFtps.js).
//
// One image is kept per printer and view, keyed by the job: a new job's first request replaces
// it. Concurrent requests for the same job share one lookup.
class PrinterCoverService {
  constructor({
    bambuddyClient, accessCodes = new Map(), downloadFile = downloadPrintFile, now = Date.now,
  }) {
    this.bambuddyClient = bambuddyClient;
    this.accessCodes = accessCodes;
    this.downloadFile = downloadFile;
    this.now = now;
    this.images = new Map(); // `${printerKey}|${view}` -> { jobKey, png, source, etag }
    this.failures = new Map(); // `${printerKey}|${view}` -> { jobKey, count, retryAt, reason }
    this.inflight = new Map(); // jobKey -> Promise
  }

  // A printer by normalized name or serial, from Bambuddy's printer list. Listed fresh on every
  // call: it is one cheap request, and a cached list would miss a printer added since.
  async findPrinter(printerID) {
    const key = normalizedID(printerID);
    if (!key) return null;
    const printers = await this.bambuddyClient.printers();
    return printers.find((printer) => normalizedID(printer.name) === key || normalizedID(printer.serial_number) === key) ?? null;
  }

  accessCodeFor(printer) {
    return this.accessCodes.get(normalizedID(printer.serial_number)) ?? this.accessCodes.get(normalizedID(printer.name)) ?? null;
  }

  // { png, etag, source, jobKey, jobName } for the printer's job, or throws CoverUnavailableError
  // when the printer has no job or no render could be found. `printer` is a Bambuddy printer
  // record; `status`, when the caller already has it, saves a request.
  async cover(printer, { view = null, status = null } = {}) {
    const currentStatus = status ?? await this.bambuddyClient.status(printer.id);
    const jobName = currentStatus.subtask_name;
    if (!jobName) throw new CoverUnavailableError(`printer "${printer.name}" has no current or last job`);

    const viewKey = view === 'top' ? 'top' : 'default';
    const slot = `${normalizedID(printer.serial_number || printer.name)}|${viewKey}`;
    const gcodeFile = currentStatus.gcode_file || '';
    const jobKey = `${printer.id}|${jobName}|${gcodeFile}|${viewKey}`;

    // A job that finishes drops its gcode_file from Bambuddy's status ("" from then on) but is
    // still the same job, so its cover stays. Looking it up again right then is what failed: the
    // cover was there all print long and gone (404, then backoff) the moment it finished.
    const cached = this.images.get(slot);
    if (cached?.jobKey === jobKey || (!gcodeFile && cached?.jobName === jobName && cached?.printerId === printer.id)) {
      return { ...cached, jobName };
    }

    const failed = this.failures.get(slot);
    if (failed?.jobKey === jobKey && this.now() < failed.retryAt) {
      throw new CoverUnavailableError(failed.reason);
    }

    let lookup = this.inflight.get(jobKey);
    if (!lookup) {
      lookup = this.lookUp(printer, currentStatus, viewKey).finally(() => this.inflight.delete(jobKey));
      this.inflight.set(jobKey, lookup);
    }

    try {
      const { png, source } = await lookup;
      const etag = `"${crypto.createHash('sha256').update(png).digest('hex').slice(0, 32)}"`;
      const image = { jobKey, jobName, printerId: printer.id, png, source, etag };
      this.images.set(slot, image);
      this.failures.delete(slot);
      return { ...image, jobName };
    } catch (error) {
      const latest = this.failures.get(slot);
      const count = latest?.jobKey === jobKey ? latest.count + 1 : 1;
      const backoff = Math.min(FAILURE_BACKOFF_MS * 2 ** (count - 1), MAX_FAILURE_BACKOFF_MS);
      this.failures.set(slot, { jobKey, count, retryAt: this.now() + backoff, reason: error.message });
      // Once per backoff window (requests inside one get the stored reason above). Only successes
      // were logged, which left a 404 with no trace of which source failed or why.
      console.log(`Cover for printer "${printer.name}" unavailable (retry in ${backoff / 1000}s): ${error.message}`);
      throw error instanceof CoverUnavailableError ? error : new CoverUnavailableError(error.message);
    }
  }

  async lookUp(printer, status, viewKey) {
    const view = viewKey === 'top' ? 'top' : null;
    let bambuddyFailure;
    try {
      return { png: await this.bambuddyClient.cover(printer.id, { view }), source: 'bambuddy' };
    } catch (error) {
      bambuddyFailure = error.message;
    }

    const noCover = `Bambuddy has no cover for "${status.subtask_name}" (${bambuddyFailure})`;
    const accessCode = this.accessCodeFor(printer);
    if (!accessCode) throw new CoverUnavailableError(`${noCover}, and no access code is configured to read it from the printer`);
    if (!printer.ip_address) throw new CoverUnavailableError(`${noCover}, and Bambuddy lists no IP address for the printer`);

    const file = await this.downloadFile({ host: printer.ip_address, accessCode, subtaskName: status.subtask_name });
    if (!file) throw new CoverUnavailableError(`${noCover}, and the printer has no file for that job`);

    const plate = status.current_plate_id ?? plateFromGcodeFile(status.gcode_file);
    const png = await extractPlateImage(file.data, { plate, view });
    if (!png) throw new CoverUnavailableError(`${file.path} on the printer carries no plate render`);
    console.log(`Cover for printer "${printer.name}" read from the printer (${file.path}): ${noCover}`);
    return { png, source: 'printer' };
  }
}

module.exports = { PrinterCoverService, CoverUnavailableError, parseAccessCodes };
