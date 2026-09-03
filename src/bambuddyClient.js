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

  async _getBinary(path) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`);
    if (!response.ok) {
      throw new Error(`Bambuddy request to ${path} failed with status ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  // GET /api/v1/printers/ -> [{ id, name, model, ... }]
  async printers() {
    return this._get('/api/v1/printers/');
  }

  // GET /api/v1/printers/{id}/status -> full status DTO. Only progress, subtask_name, layer_num,
  // total_layers, remaining_time, and temperatures.{nozzle,bed} are used (see
  // bambuddyEnrichment.js -- confirmed against a live deploy that these are snake_case, not
  // camelCase) -- the rest of Bambuddy's response is passed through untouched.
  async status(printerId) {
    return this._get(`/api/v1/printers/${printerId}/status`);
  }

  // Mints a short-lived camera stream token, a separate credential from the main API key
  // (confirmed live: the main API key's Authorization header isn't even needed on the two
  // endpoints below once you have this token, just the token itself as a query param). Not
  // cacheable long-term -- mint one immediately before each cover/snapshot fetch rather than
  // reusing an old one.
  async mintCameraStreamToken() {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/printers/camera/stream-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) {
      throw new Error(`Bambuddy stream-token request failed with status ${response.status}`);
    }
    const { token } = await response.json();
    return token;
  }

  // GET /api/v1/printers/{id}/cover?token=... -> the sliced-plate preview render (PNG), static
  // for the whole job.
  async cover(printerId, streamToken) {
    return this._getBinary(`/api/v1/printers/${printerId}/cover?token=${streamToken}`);
  }

  // GET /api/v1/printers/{id}/camera/snapshot?token=... -> a live camera frame (JPEG).
  async cameraSnapshot(printerId, streamToken) {
    return this._getBinary(`/api/v1/printers/${printerId}/camera/snapshot?token=${streamToken}`);
  }
}

module.exports = { BambuddyClient };
