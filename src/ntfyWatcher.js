function parseSseChunk(buffer) {
  const parts = buffer.split('\n\n');
  const remainder = parts.pop();
  const messages = [];

  for (const part of parts) {
    const dataLine = part.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) continue;
    const jsonText = dataLine.slice('data:'.length).trim();
    try {
      messages.push(JSON.parse(jsonText));
    } catch {
      // Skip malformed lines rather than crashing the watcher.
    }
  }

  return { messages, remainder };
}

class NtfyWatcher {
  constructor({ server, topic, authToken, onMessage, fetchImpl = fetch, backoff = {} }) {
    this.server = server;
    this.topic = topic;
    this.authToken = authToken;
    this.onMessage = onMessage;
    this.fetchImpl = fetchImpl;
    this.minBackoffMs = backoff.minMs ?? 1000;
    this.maxBackoffMs = backoff.maxMs ?? 30000;
    this.stopped = false;
    this.currentBackoffMs = this.minBackoffMs;
    this.abortController = null;
    this._cancelSleep = null;
  }

  start() {
    this.stopped = false;
    this._connectLoop();
  }

  stop() {
    this.stopped = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this._cancelSleep) {
      this._cancelSleep();
    }
  }

  async _connectLoop() {
    let hasConnectedBefore = false;
    while (!this.stopped) {
      try {
        await this._connectOnce(hasConnectedBefore);
        hasConnectedBefore = true;
        this.currentBackoffMs = this.minBackoffMs; // reset on a clean connect+stream
      } catch (error) {
        if (!this.stopped) {
          console.error(
            `ntfy watcher connection attempt failed: ${error && error.message ? error.message : error}; retrying in ${this.currentBackoffMs}ms`,
          );
        }
        // fall through to backoff/retry below
      }
      if (this.stopped) return;
      await this._sleep(this.currentBackoffMs);
      this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs);
    }
  }

  async _connectOnce(isReconnect) {
    const url = `${this.server}/${this.topic}/sse`;
    this.abortController = new AbortController();
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.authToken}` },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`ntfy connection failed with status ${response.status}`);
    }

    console.log(
      isReconnect
        ? `ntfy watcher reconnected to ${this.server}/${this.topic}`
        : `ntfy watcher connected to ${this.server}/${this.topic}`,
    );

    // `chunk` here is a raw Uint8Array from the fetch Response body stream, NOT a Node Buffer —
    // Buffer overrides toString() to UTF-8 decode, but plain Uint8Array doesn't, so
    // `chunk.toString()` silently produced a comma-joined list of byte values instead of text,
    // meaning parseSseChunk never matched a real `data:` line and onMessage was never called for
    // ANY message. A TextDecoder with `{ stream: true }` both decodes correctly and correctly
    // reassembles a multibyte UTF-8 character that lands split across two chunks.
    const decoder = new TextDecoder('utf-8');
    let remainder = '';
    for await (const chunk of response.body) {
      if (this.stopped) return;
      const { messages, remainder: nextRemainder } = parseSseChunk(remainder + decoder.decode(chunk, { stream: true }));
      remainder = nextRemainder;
      for (const message of messages) {
        if (message.event === 'message') {
          this.onMessage(message);
        }
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this._cancelSleep = null;
        resolve();
      }, ms);
      this._cancelSleep = () => {
        clearTimeout(timeoutId);
        this._cancelSleep = null;
        resolve();
      };
    });
  }
}

module.exports = { parseSseChunk, NtfyWatcher };
