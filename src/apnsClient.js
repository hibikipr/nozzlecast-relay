const http2 = require('node:http2');

const REMOVABLE_STATUSES = new Set([400, 410]);

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
  constructor({ authProvider, topic, connect = http2.connect, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    this.authProvider = authProvider;
    this.topic = topic;
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
  static priorityFor(pushType) {
    return pushType === 'background' ? '5' : '10';
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

  async send({ token, environment, payload, pushType = 'liveactivity', topic = this.topic }) {
    const origin = environment === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com';

    const session = this._sessionFor(origin);
    try {
      const result = await this._sendOnSession(session, { token, payload, pushType, topic });
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
        return this._sendOnFreshSession(origin, { token, payload, pushType, topic });
      }
      throw error;
    }
  }

  async _sendOnFreshSession(origin, { token, payload, pushType, topic }) {
    const session = this._sessionFor(origin);
    try {
      const result = await this._sendOnSession(session, { token, payload, pushType, topic });
      this.served.add(session);
      return result;
    } catch (error) {
      this._discard(session);
      throw error;
    }
  }

  _sendOnSession(session, { token, payload, pushType, topic }) {
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

      const body = JSON.stringify(payload);
      stream = session.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        'apns-push-type': pushType,
        'apns-topic': topic,
        'apns-priority': ApnsClient.priorityFor(pushType),
        authorization: `bearer ${this.authProvider.getToken()}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });

      let status = null;
      let apnsId = null;
      let responseBody = '';

      stream.on('response', (headers) => {
        status = headers[':status'];
        // Apple's own correlation id for this push. Worth surfacing because a 2xx from APNs is
        // acceptance, not application: a Live Activity token whose activity has already ended
        // keeps returning 200 through its dismissal window while the device silently discards
        // every push. When a Live Activity visibly stops updating, this is the only handle that
        // ties a relay log line to Apple's own delivery record for that specific push.
        apnsId = headers['apns-id'] || null;
      });
      stream.on('data', (chunk) => {
        responseBody += chunk.toString();
      });
      stream.on('end', () => {
        settleResolve({
          ok: status >= 200 && status < 300,
          status,
          apnsId,
          shouldRemoveToken: REMOVABLE_STATUSES.has(status),
          body: responseBody,
        });
      });
      stream.on('error', settleReject);

      stream.end(body);
    });
  }
}

module.exports = { ApnsClient };
