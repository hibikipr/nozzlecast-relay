const yauzl = require('yauzl');

// Where a Bambu printer keeps the file it is printing, most likely first. An HTTPS-dispatched
// print (the printer downloads the job from an https:// link itself) and an H2-series Studio
// upload land in /cache; an SD card print sits at the root. Same order Bambuddy's own cover route
// searches.
const PRINT_FILE_DIRS = ['/cache', '/', '/model', '/data'];

// The file names the printer may have stored a job under, most likely first. Printers escape
// characters a file name can't hold differently: an H2C stores "/" as "2f" and "*" as "2a"
// ("OREO / LOVE" is "OREO 2f LOVE.gcode.3mf"), a P1S stores "/" as "_" ("… _ Phoneholder.3mf").
// Bambu Studio sometimes swaps spaces for underscores.
function candidateFileNames(subtaskName) {
  const hexEscaped = subtaskName.replace(/\//g, '2f').replace(/\*/g, '2a');
  const underscored = subtaskName.replace(/\//g, '_');
  const names = [];
  for (const base of new Set([hexEscaped, hexEscaped.replace(/ /g, '_'), underscored])) {
    if (base.toLowerCase().endsWith('.3mf')) names.push(base);
    else names.push(`${base}.gcode.3mf`, `${base}.3mf`);
  }
  return names;
}

// The first candidate found in any directory, searching every directory for the most likely name
// before trying the next name. `listings` maps a directory to its listing ([{ name, size }]); a
// directory that couldn't be listed is simply absent. Returns { path, size, modifiedAt } or null;
// modifiedAt (a Date, when the listing gave one) is when the printer wrote the file.
function findPrintFile(listings, subtaskName) {
  for (const name of candidateFileNames(subtaskName)) {
    for (const dir of PRINT_FILE_DIRS) {
      const entry = listings[dir]?.find((file) => file.name === name);
      if (entry) return { path: `${dir === '/' ? '' : dir}/${name}`, size: entry.size, modifiedAt: entry.modifiedAt ?? null };
    }
  }
  return null;
}

// The plate a gcode path names ("Metadata/plate_2.gcode" -> 2), or null.
function plateFromGcodeFile(gcodeFile) {
  const match = /plate_(\d+)\.gcode/.exec(gcodeFile || '');
  return match ? Number(match[1]) : null;
}

function readZipEntries(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const entries = new Map();
      zip.on('entry', (entry) => {
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on('end', () => resolve({ zip, entries }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

// The plate render a sliced 3MF carries for one plate, as PNG bytes, or null when it has none.
// `view` "top" is the top-down plate view; anything else is the angled 3D view. The plate is
// `plate` when known; otherwise the 3MF's only sliced plate, else plate 1 -- a per-plate export
// (one plate sliced from a multi-plate project) holds just that plate's gcode, under its own
// number, while the printer echoes only the .3mf name.
async function extractPlateImage(buffer, { plate = null, view = null } = {}) {
  const { zip, entries } = await readZipEntries(buffer);
  try {
    let plateNumber = plate;
    if (plateNumber === null) {
      const sliced = [...entries.keys()]
        .map((name) => /^Metadata\/plate_(\d+)\.gcode$/.exec(name))
        .filter(Boolean);
      plateNumber = sliced.length === 1 ? Number(sliced[0][1]) : 1;
    }
    const entry = entries.get(`Metadata/${view === 'top' ? 'top' : 'plate'}_${plateNumber}.png`);
    return entry ? await readEntry(zip, entry) : null;
  } finally {
    zip.close();
  }
}

// The slicer's predicted print time for one plate, in seconds, from Metadata/slice_info.config --
// or null. Only plates that were sliced into this file have one (a per-plate export has just its
// own): <plate><metadata key="index" value="9"/><metadata key="prediction" value="8346"/>...
async function platePrediction(buffer, plate) {
  const { zip, entries } = await readZipEntries(buffer);
  try {
    const entry = entries.get('Metadata/slice_info.config');
    if (!entry) return null;
    const xml = (await readEntry(zip, entry)).toString('utf8');
    for (const [, block] of xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
      const value = (key) => new RegExp(`<metadata\\s+key="${key}"\\s+value="([^"]*)"`).exec(block)?.[1];
      if (Number(value('index')) !== plate) continue;
      const seconds = Number(value('prediction'));
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    }
    return null;
  } finally {
    zip.close();
  }
}

module.exports = { PRINT_FILE_DIRS, candidateFileNames, findPrintFile, plateFromGcodeFile, extractPlateImage, platePrediction };
