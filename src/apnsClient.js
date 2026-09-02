const http2 = require('node:http2');

const REMOVABLE_STATUSES = new Set([400, 410]);

class ApnsClient {
  constructor({ authProvider, topic, connect = http2.connect }) {
    this.authProvider = authProvider;
    this.topic = topic;
    this.connect = connect;
  }

  async send({ token, environment, payload }) {
    const origin = environment === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com';

    const session = this.connect(origin);
    try {
      return await this._sendOnSession(session, { token, payload });
    } finally {
      session.close();
    }
  }

  _sendOnSession(session, { token, payload }) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const stream = session.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        'apns-push-type': 'liveactivity',
        'apns-topic': this.topic,
        'apns-priority': '10',
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
        resolve({
          ok: status >= 200 && status < 300,
          status,
          shouldRemoveToken: REMOVABLE_STATUSES.has(status),
          body: responseBody,
        });
      });
      stream.on('error', reject);

      stream.end(body);
    });
  }
}

module.exports = { ApnsClient };
