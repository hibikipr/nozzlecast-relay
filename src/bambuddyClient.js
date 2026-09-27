// Thin REST client for the subset of Bambuddy's own API that the relay needs to drive a Live
// Activity -- printer identity and live status. Mirrors
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

  async _getBinary(path, { authenticated = false } = {}) {
    const response = await this.fetchImpl(
      `${this.baseUrl}${path}`,
      authenticated ? { headers: { Authorization: `Bearer ${this.apiKey}` } } : undefined,
    );
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

  // Mints a short-lived camera stream token, a separate credential from the main API key, needed
  // for camera/snapshot below (confirmed live: the main API key's Authorization header alone
  // isn't accepted there, only this token as a query param). Not cacheable long-term -- mint one
  // immediately before each snapshot fetch rather than reusing an old one.
  //
  // cover() below used to go through this same token too, but Bambuddy changed what it requires
  // (its own OpenAPI description now says: "It used to require camera:view by way of the
  // camera-stream token, which is a different question from 'may this user see what is on the
  // plate' (#3025)") -- it now wants printers:read, the same permission every other printer read
  // in this client already needs, and just the main API key's Authorization header satisfies that
  // (confirmed live: a plain Bearer request succeeds with no token param at all). That's why
  // cover() takes no token argument below despite still fetching one for snapshot.
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

  // GET /api/v1/printers/{id}/cover -> the sliced-plate preview render (PNG), static for the
  // whole job. Bearer-authenticated like every other non-image endpoint in this client -- see the
  // comment on mintCameraStreamToken() above for why this doesn't take a stream token.
  async cover(printerId) {
    return this._getBinary(`/api/v1/printers/${printerId}/cover`, { authenticated: true });
  }

  // GET /api/v1/printers/{id}/camera/snapshot?token=... -> a live camera frame (JPEG).
  async cameraSnapshot(printerId, streamToken) {
    return this._getBinary(`/api/v1/printers/${printerId}/camera/snapshot?token=${streamToken}`);
  }
}

module.exports = { BambuddyClient };
