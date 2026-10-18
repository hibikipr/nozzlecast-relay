const { AtomicJsonFile } = require('./atomicJsonFile');

class TokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tokens = new Map();
    this._file = new AtomicJsonFile(filePath);
  }

  async load() {
    try {
      // Falls back to the .bak copy if the main file is corrupt -- see AtomicJsonFile.read().
      const entries = (await this._file.read()) ?? [];
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

  save() {
    return this._file.write(() => this.list());
  }
}

module.exports = { TokenStore };
