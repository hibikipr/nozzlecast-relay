const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const TOKEN_LIFETIME_MS = 20 * 60 * 1000;

class ApnsAuthProvider {
  constructor({ keyPath, keyId, teamId, now = () => Date.now(), readKeyFile = (path) => fs.readFileSync(path, 'utf8') }) {
    this.keyPath = keyPath;
    this.keyId = keyId;
    this.teamId = teamId;
    this.now = now;
    this.readKeyFile = readKeyFile;
    this.cachedToken = null;
    this.cachedAt = null;
  }

  getToken() {
    const currentTime = this.now();
    if (this.cachedToken && currentTime - this.cachedAt < TOKEN_LIFETIME_MS) {
      return this.cachedToken;
    }

    const privateKey = this.readKeyFile(this.keyPath);
    this.cachedToken = jwt.sign(
      { iss: this.teamId, iat: Math.floor(currentTime / 1000) },
      privateKey,
      { algorithm: 'ES256', header: { alg: 'ES256', kid: this.keyId } }
    );
    this.cachedAt = currentTime;
    return this.cachedToken;
  }
}

module.exports = { ApnsAuthProvider };
