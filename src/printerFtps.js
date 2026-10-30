const { Writable } = require('node:stream');
const ftp = require('basic-ftp');
const { PRINT_FILE_DIRS, findPrintFile } = require('./printFile');

const DEFAULT_TIMEOUT_MS = 20000;
// A 3MF past this is not worth pulling over the printer's Wi-Fi for one cover image.
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

// Downloads the 3MF a printer is printing straight from the printer, over the implicit FTPS it
// serves on port 990 (user "bblp", the LAN access code). This is the path for the prints Bambuddy
// can't find a cover for: it reads a cloud print's S3 download link as "internal storage" and
// never looks, and it searches for a name with a "/" under the raw name (maziggy/bambuddy#3382,
// closed as out of scope). The file is on the printer all the same.
//
// The printer's certificate is self-signed, so it isn't verified -- the access code is the only
// credential, same as for Bambuddy and the slicer. basic-ftp reuses the control connection's TLS
// session for each data connection, which the printers' vsFTPd requires. A1-series firmware that
// only takes a clear data channel is not handled.
//
// Returns { path, data } or null when the printer has no file for that job. Throws on connection
// or transfer failure.
async function downloadPrintFile({
  host, accessCode, subtaskName,
  timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, createClient = (timeout) => new ftp.Client(timeout),
}) {
  const client = createClient(timeoutMs);
  try {
    await client.access({
      host,
      port: 990,
      user: 'bblp',
      password: accessCode,
      secure: 'implicit',
      secureOptions: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
    });

    const listings = {};
    for (const dir of PRINT_FILE_DIRS) {
      try {
        listings[dir] = await client.list(dir);
      } catch {
        // No such directory on this model (no SD card, no /data): search the others.
      }
    }
    const file = findPrintFile(listings, subtaskName);
    if (!file) return null;
    if (file.size > maxBytes) {
      throw new Error(`${file.path} is ${file.size} bytes, over the ${maxBytes}-byte cover download limit`);
    }

    const chunks = [];
    let received = 0;
    const sink = new Writable({
      write(chunk, encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) return callback(new Error(`${file.path} grew past the ${maxBytes}-byte cover download limit`));
        chunks.push(chunk);
        callback();
      },
    });
    await client.downloadTo(sink, file.path);
    return { path: file.path, data: Buffer.concat(chunks) };
  } finally {
    client.close();
  }
}

module.exports = { downloadPrintFile };
