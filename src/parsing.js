function isStartEvent(title) {
  return (title || '').toLowerCase().includes('start');
}

function printerName(message) {
  const text = message || '';
  const colonIndex = text.indexOf(':');
  if (colonIndex === -1) return null;
  const name = text.slice(0, colonIndex).trim();
  return name.length > 0 ? name : null;
}

function normalizedID(name) {
  return (name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

module.exports = { isStartEvent, printerName, normalizedID };
