const { normalizedID } = require('./parsing');

// Resolves an ntfy-reported printer name (already run through parsing.js#normalizedID by the
// caller) to Bambuddy's own numeric printer id, so bambuddyClient.status(id) can be called.
// Cached rather than fetched on every ntfy message -- printers don't get added mid-print, so a
// full re-fetch is only worth doing on an actual cache miss, not continuously.
class PrinterIdCache {
  constructor({ bambuddyClient }) {
    this.bambuddyClient = bambuddyClient;
    this.idsByNormalizedName = null; // null until the first successful fetch
  }

  async _refresh() {
    const printers = await this.bambuddyClient.printers();
    this.idsByNormalizedName = new Map(printers.map((printer) => [normalizedID(printer.name), printer.id]));
  }

  // Returns the Bambuddy printer id for a normalized printer name, or null if no such printer is
  // known even after a refresh. Does NOT catch a Bambuddy request failure itself -- that
  // propagates as a rejected promise, same as bambuddyClient.status() -- so callers have one
  // single fail-open boundary (see index.js's fetchEnrichment) rather than two different ones to
  // reason about.
  async resolve(printerID) {
    if (this.idsByNormalizedName === null) {
      await this._refresh();
    }
    if (this.idsByNormalizedName.has(printerID)) {
      return this.idsByNormalizedName.get(printerID);
    }
    // Cache miss: could be a printer added after the last fetch, so refresh once and check again
    // rather than assuming a permanent miss.
    await this._refresh();
    return this.idsByNormalizedName.has(printerID) ? this.idsByNormalizedName.get(printerID) : null;
  }
}

module.exports = { PrinterIdCache };
