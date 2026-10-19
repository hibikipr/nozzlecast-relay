const http2 = require('node:http2');

// Only responses that say the TOKEN itself is dead. A 400 covers far more than that -- BadPriority,
// BadTopic, TopicDisallowed, InvalidPushType, MissingTopic, PayloadEmpty and more are all 400s
// about the request, not the token -- and treating every 400 as "remove" meant one relay-side
// config or payload mistake deleted every device's token in a single pass, leaving nothing to push
// to until each app re-registered. So a 400 is removable only for these reasons; any other 400 is
// logged and the token kept.
const REMOVABLE_400_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic']);

function shouldRemoveToken(status, body) {
  if (status === 410) return true;
  if (status !== 400) return false;
  try {
    return REMOVABLE_400_REASONS.has(JSON.parse(body)?.reason);
  } catch {
    return false;
  }
}

// A send that hasn't produced a complete response by then is abandoned. Without a bound, one
// stalled stream held the whole poller tick (and every push queued behind it) open indefinitely.
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

// Errors that mean "the connection was already dead", as opposed to a timeout or a real failure.
const STALE_SESSION_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_INVALID_SESSION',
  'ERR_HTTP2_SESSION_ERROR',
  'ERR_HTTP2_STREAM_ERROR',
]);

class ApnsClient {
  constructor({ authProvider, topic, bundleId = null, connect = http2.connect, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    this.authProvider = authProvider;
    this.topic = topic;
    // Broadcast and channel-management paths are keyed by the bare bundle id, not the
    // `.push-type.liveactivity` topic.
    this.bundleId = bundleId;
    this.connect = connect;
    this.requestTimeoutMs = requestTimeoutMs;
    // One long-lived HTTP/2 session per APNs host. Apple asks providers to keep connections open
    // rather than opening one per notification -- a fresh TCP+TLS handshake per push was both
    // slow and the connect/disconnect pattern APNs documents it may treat as a denial-of-service
    // attempt. A session is dropped from here the moment it errors, closes or receives GOAWAY, and
    // the next send simply opens a new one.
    this.sessions = new Map(); // origin -> session
    // Sessions that have completed at least one request, so a later failure on one means it went
    // stale rather than never worked.
    this.served = new WeakSet();
  }

  // APNs constrains apns-priority by push type: a `background` push (apns-push-type: background,
  // i.e. a content-available wake) MUST be priority 5 -- 10 is rejected outright with a 400
  // BadPriority, it is not merely downgraded. Every other push type here (liveactivity) wants 10
  // so it is delivered immediately. This was previously hardcoded to '10' for every send, which
  // silently broke every background wake push the moment /register-device started working and
  // there was finally a device token to send one to.
  //
  // A liveactivity push may still ask for 5 explicitly (`priority` on send): routine correction
  // updates do, so they don't spend the on-device high-priority Live Activity budget -- see
  // index.js's onCorrection.
  static priorityFor(pushType, priority = null) {
    if (pushType === 'background') return '5';
    return priority === 5 ? '5' : '10';
  }

  _sessionFor(origin) {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const session = this.connect(origin);
    const evict = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on('error', evict);
    session.on('goaway', evict);
    session.on('close', evict);
    // An idle session must not keep the process alive on shutdown.
    session.unref?.();
    this.sessions.set(origin, session);
    return session;
  }

  _discard(session) {
    for (const [origin, cached] of this.sessions) {
      if (cached === session) this.sessions.delete(origin);
    }
    session.destroy?.();
  }

  // Closes every open session -- for a clean shutdown.
  close() {
    for (const session of this.sessions.values()) session.close?.();
    this.sessions.clear();
  }

  async send({ token, environment, payload, pushType = 'liveactivity', topic = this.topic, priority = null }) {
    const origin = environment === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com';

    const response = await this._request(origin, {
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'apns-push-type': pushType,
      'apns-topic': topic,
      'apns-priority': ApnsClient.priorityFor(pushType, priority),
    }, JSON.stringify(payload));
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      // Apple's own correlation id for this push. Worth surfacing because a 2xx from APNs is
      // acceptance, not application: a Live Activity token whose activity has already ended
      // keeps returning 200 through its dismissal window while the device silently discards
      // every push. When a Live Activity visibly stops updating, this is the only handle that
      // ties a relay log line to Apple's own delivery record for that specific push.
      apnsId: response.headers['apns-id'] || null,
      shouldRemoveToken: shouldRemoveToken(response.status, response.body),
      body: response.body,
    };
  }

  // Broadcast push: one Live Activity update/end published to a channel, which APNs fans out to
  // every activity subscribed to it (iOS 18+). A channel-backed activity has no per-activity
  // token, so this is the only way to reach it -- and it needs no app code to run on the device
  // first, which is the point: a phone in Low Power Mode, or with the app force-quit, never ran
  // the background wake that registers a token, so token-only updates never reached it.
  //
  // apns-expiration is 0 because channels are created with the No Message Stored policy (see
  // createChannel), and Apple rejects a nonzero expiration on those.
  async broadcast({ channelId, environment, payload, priority = null }) {
    const origin = environment === 'sandbox'
      ? 'https://api-broadcast.sandbox.push.apple.com'
      : 'https://api-broadcast.push.apple.com';

    const response = await this._request(origin, {
      ':method': 'POST',
      ':path': `/4/broadcasts/apps/${this.bundleId}`,
      'apns-channel-id': channelId,
      'apns-push-type': 'liveactivity',
      'apns-priority': ApnsClient.priorityFor('liveactivity', priority),
      'apns-expiration': '0',
    }, JSON.stringify(payload));
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      // Broadcasts answer with apns-unique-id rather than apns-id; it's the handle Apple asks for
      // when troubleshooting a specific broadcast.
      apnsId: response.headers['apns-unique-id'] || response.headers['apns-id'] || null,
      body: response.body,
    };
  }

  // Channel management lives on its own host and port, separate from both the device and the
  // broadcast endpoints. Returns the new channel id, or throws with APNs' status/body.
  //
  // message-storage-policy 0 (No Message Stored): Apple gives that policy the higher publishing
  // budget and recommends it for frequently updated activities. A print pushes every correction
  // interval, so a device that misses one update while offline gets the next one shortly anyway.
  async createChannel({ environment }) {
    const response = await this._request(ApnsClient.channelOrigin(environment), {
      ':method': 'POST',
      ':path': `/1/apps/${this.bundleId}/channels`,
    }, JSON.stringify({ 'message-storage-policy': 0, 'push-type': 'LiveActivity' }));
    const channelId = response.headers['apns-channel-id'];
    if (response.status !== 201 || !channelId) {
      throw new Error(`APNs channel create failed (status ${response.status}): ${response.body}`);
    }
    return channelId;
  }

  async deleteChannel({ environment, channelId }) {
    const response = await this._request(ApnsClient.channelOrigin(environment), {
      ':method': 'DELETE',
      ':path': `/1/apps/${this.bundleId}/channels`,
      'apns-channel-id': channelId,
    });
    if (response.status !== 204) {
      throw new Error(`APNs channel delete failed (status ${response.status}): ${response.body}`);
    }
  }

  async listChannels({ environment }) {
    const response = await this._request(ApnsClient.channelOrigin(environment), {
      ':method': 'GET',
      ':path': `/1/apps/${this.bundleId}/all-channels`,
    });
    if (response.status !== 200) {
      throw new Error(`APNs channel list failed (status ${response.status}): ${response.body}`);
    }
    return JSON.parse(response.body || '{}').channels ?? [];
  }

  static channelOrigin(environment) {
    return environment === 'sandbox'
      ? 'https://api-manage-broadcast.sandbox.push.apple.com:2195'
      : 'https://api-manage-broadcast.push.apple.com:2196';
  }

  // One request on the cached session for `origin`, returning { status, headers, body } for any
  // HTTP response; only a transport failure or timeout throws.
  async _request(origin, headers, body = null) {
    const session = this._sessionFor(origin);
    try {
      const result = await this._sendOnSession(session, headers, body);
      this.served.add(session);
      return result;
    } catch (error) {
      // A session-level failure (or a timed-out stream) says nothing good about the connection:
      // tear it down so the next send starts from a fresh one instead of reusing a broken channel.
      this._discard(session);

      // APNs closes an idle connection without telling us, and the first push after that hits the
      // dead socket (ECONNRESET). Between prints that first push is the push-to-start, so dropping
      // it meant a device never got its Live Activity until the app was opened by hand (seen
      // 2026-10-03: one of two devices missed the print-start push, the other was fine). Retry
      // once on a fresh session -- but only when the failed session had already served requests,
      // i.e. it went stale. A brand-new session that fails is a real network problem, and a
      // timeout or an APNs rejection is not a stale socket, so neither is retried.
      if (this.served.has(session) && STALE_SESSION_ERROR_CODES.has(error?.code)) {
        return this._sendOnFreshSession(origin, headers, body);
      }
      throw error;
    }
  }

  async _sendOnFreshSession(origin, headers, body) {
    const session = this._sessionFor(origin);
    try {
      const result = await this._sendOnSession(session, headers, body);
      this.served.add(session);
      return result;
    } catch (error) {
      this._discard(session);
      throw error;
    }
  }

  _sendOnSession(session, requestHeaders, body) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let stream = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        session.off?.('error', settleReject);
      };
      function settleReject(error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
      const settleResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      session.on('error', settleReject);
      timer = setTimeout(() => {
        stream?.close?.(http2.constants.NGHTTP2_CANCEL);
        settleReject(new Error(`APNs request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      const headers = {
        ...requestHeaders,
        authorization: `bearer ${this.authProvider.getToken()}`,
      };
      if (body !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(body);
      }
      stream = session.request(headers);

      let status = null;
      let responseHeaders = {};
      let responseBody = '';

      stream.on('response', (received) => {
        status = received[':status'];
        responseHeaders = received;
      });
      stream.on('data', (chunk) => {
        responseBody += chunk.toString();
      });
      stream.on('end', () => {
        settleResolve({ status, headers: responseHeaders, body: responseBody });
      });
      stream.on('error', settleReject);

      if (body !== null) stream.end(body);
      else stream.end();
    });
  }
}

module.exports = { ApnsClient };
