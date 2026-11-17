const { Writable } = require('node:stream');
const ftp = require('basic-ftp');
const { PRINT_FILE_DIRS, findPrintFile } = require('./printFile');

const DEFAULT_TIMEOUT_MS = 20000;
// A 3MF past this is not worth pulling over the printer's Wi-Fi for one cover image.
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
// The whole read, start to finish. timeoutMs is basic-ftp's idle timeout, so a transfer that keeps
// trickling never trips it: a P1S took 8m45s for one 3MF on 2026-11-17. Callers no longer wait on
// this (see COVER_WAIT_MS), so it's generous; it only stops a read that would otherwise never end.
const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;

// Downloads the 3MF a printer is printing straight from the printer, over the implicit FTPS it
// serves on port 990 (user "bblp", the LAN access code). This is the path for the prints Bambuddy
// can't find a cover for: it reads an HTTPS-dispatched print's https:// download link as
// "internal storage" and never looks, and it searches for a name with a "/" under the raw name
// (maziggy/bambuddy#3382). The printer downloads that file into /cache itself all the same.
//
// The printer's certificate is self-signed, so it isn't verified -- the access code is the only
// credential, same as for Bambuddy and the slicer. basic-ftp reuses the control connection's TLS
// session for each data connection, which the printers' vsFTPd requires. A1-series firmware that
// only takes a clear data channel is not handled.
//
// Returns { path, data, modifiedAt } or null when the printer has no file for that job;
// modifiedAt is when the printer wrote it (a Date, or null if the listing didn't say). Throws on
// connection or transfer failure.
async function downloadPrintFile({
  host, accessCode, subtaskName,
  timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, deadlineMs = DEFAULT_DEADLINE_MS,
  createClient = (timeout) => new ftp.Client(timeout),
}) {
  const client = createClient(timeoutMs);
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`reading the print file from ${host} took over ${deadlineMs / 1000}s, gave up`));
      client.close(); // aborts the transfer still in progress
    }, deadlineMs);
  });
  const work = transfer({ client, accessCode, host, subtaskName, maxBytes });
  work.catch(() => {}); // after the deadline its rejection (the closed socket) has nobody waiting
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

async function transfer({ client, host, accessCode, subtaskName, maxBytes }) {
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
  return { path: file.path, data: Buffer.concat(chunks), modifiedAt: file.modifiedAt };
}

module.exports = { downloadPrintFile };
