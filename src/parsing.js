// The canonical printer key, shared by the poller, the HTTP API, and the printer-id cache.
// Bambuddy names a printer inconsistently across its own surfaces -- sometimes the display name
// ("Vic H2C"), sometimes the raw slug ("vic-h2c") -- and there is no identifier that survives the
// process boundary between this relay and the app. Stripping everything but letters and digits is
// what makes a name computed on either side match. NozzleCast's `PrintActivityAttributes
// .normalizedID` is the Swift twin of this function and must stay behaviourally identical.
function normalizedID(name) {
  return (name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

module.exports = { normalizedID };
