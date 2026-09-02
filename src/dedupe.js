class StartEventDedupe {
  constructor({ windowMs = 60000, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.lastTriggeredAt = new Map();
  }

  shouldTrigger(printerID) {
    const currentTime = this.now();
    const lastTime = this.lastTriggeredAt.get(printerID);
    if (lastTime !== undefined && currentTime - lastTime < this.windowMs) {
      return false;
    }
    this.lastTriggeredAt.set(printerID, currentTime);
    return true;
  }
}

module.exports = { StartEventDedupe };
