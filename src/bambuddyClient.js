// Thin REST client for the subset of Bambuddy's own API that the relay needs to enrich a Live
// Activity beyond what ntfy's alert text carries -- printer identity and live status. Mirrors
// only the fields NozzleCast's own BambuddyAPIClient.swift actually uses for this, not
// Bambuddy's full status shape.
class BambuddyClient {
  constructor({ baseUrl, apiKey, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async _get(path) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`Bambuddy request to ${path} failed with status ${response.status}`);
    }
    return response.json();
  }

  // GET /api/v1/printers/ -> [{ id, name, model, ... }]
  async printers() {
    return this._get('/api/v1/printers/');
  }

  // GET /api/v1/printers/{id}/status -> full status DTO. Only progress, subtaskName, layerNum,
  // totalLayers, remainingTime, and temperatures.{nozzle,bed} are used (see
  // bambuddyEnrichment.js) -- the rest of Bambuddy's response is passed through untouched.
  async status(printerId) {
    return this._get(`/api/v1/printers/${printerId}/status`);
  }
}

module.exports = { BambuddyClient };
