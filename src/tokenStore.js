const fs = require('node:fs/promises');
const path = require('node:path');

class TokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tokens = new Map();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const entries = JSON.parse(raw);
      this.tokens = new Map(entries.map((entry) => [entry.token, entry]));
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.tokens = new Map();
        return;
      }
      if (error instanceof SyntaxError || error instanceof TypeError) {
        console.error(`tokens.json is corrupt (${error.message}); starting with an empty token list`);
        this.tokens = new Map();
        return;
      }
      throw error;
    }
  }

  async upsert({ token, environment }) {
    const existing = this.tokens.get(token);
    this.tokens.set(token, {
      token,
      environment,
      registeredAt: existing ? existing.registeredAt : new Date().toISOString(),
    });
    await this.save();
  }

  async remove(token) {
    this.tokens.delete(token);
    await this.save();
  }

  list() {
    return Array.from(this.tokens.values());
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(this.list(), null, 2), 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }
}

module.exports = { TokenStore };
