const http2 = require('node:http2');

const REMOVABLE_STATUSES = new Set([400, 410]);

class ApnsClient {
  constructor({ authProvider, topic, connect = http2.connect }) {
    this.authProvider = authProvider;
    this.topic = topic;
    this.connect = connect;
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

  async send({ token, environment, payload, pushType = 'liveactivity', topic = this.topic }) {
    const origin = environment === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com';

    const session = this.connect(origin);
    let sessionErrored = false;
    try {
      return await this._sendOnSession(session, { token, payload, pushType, topic });
    } catch (error) {
      sessionErrored = true;
      throw error;
    } finally {
      if (sessionErrored) {
        session.destroy();
      } else {
        session.close();
      }
    }
  }

  _sendOnSession(session, { token, payload, pushType, topic }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const settleResolve = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      session.on('error', settleReject);

      const body = JSON.stringify(payload);
      const stream = session.request({
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
      let responseBody = '';

      stream.on('response', (headers) => {
        status = headers[':status'];
      });
      stream.on('data', (chunk) => {
        responseBody += chunk.toString();
      });
      stream.on('end', () => {
        settleResolve({
          ok: status >= 200 && status < 300,
          status,
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
