function isStartEvent(title) {
  return (title || '').toLowerCase().includes('start');
}

function isProgressEvent(title) {
  return /\d+\s*%/.test(title || '');
}

// Deliberately conservative: Bambuddy sends other "...Complete" titles on this same topic that
// aren't print completions at all (e.g. "Bed Cooldown Complete"), so bare "complete"/"finish"
// only counts as a print-ending event when "print" also appears in the title. "fail"/"cancel"
// don't need that guard -- nothing else on this topic uses those words.
function isEndEvent(title) {
  const text = title || '';
  if (isProgressEvent(text)) return false;
  const lower = text.toLowerCase();
  if (lower.includes('fail') || lower.includes('cancel')) return true;
  return lower.includes('print') && (lower.includes('complete') || lower.includes('finish'));
}

function progressFraction(title) {
  const match = (title || '').match(/(\d+)\s*%/);
  return match ? Number(match[1]) / 100 : null;
}

function endStateLabel(title) {
  const lower = (title || '').toLowerCase();
  if (lower.includes('fail')) return 'Failed';
  if (lower.includes('cancel')) return 'Cancelled';
  return 'Complete';
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

module.exports = {
  isStartEvent,
  isProgressEvent,
  isEndEvent,
  progressFraction,
  endStateLabel,
  printerName,
  normalizedID,
};
