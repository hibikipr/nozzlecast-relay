const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every name a src file destructures out of another src file must be one that file exports. A
// renamed export left index.js importing a name that no longer existed (undefined, with no error
// at load), and every Live Activity push then went out without its cover.
const srcDir = path.join(__dirname, '..', 'src');

test('src files only import names their local modules export', () => {
  const pattern = /const \{([^}]+)\} = require\('\.\/([^']+)'\)/g;
  for (const file of fs.readdirSync(srcDir).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
    for (const [, names, target] of source.matchAll(pattern)) {
      const exported = require(path.join(srcDir, target));
      for (const name of names.split(',').map((entry) => entry.split(':')[0].trim()).filter(Boolean)) {
        assert.ok(name in exported, `${file} imports ${name} from ./${target}, which doesn't export it`);
      }
    }
  }
});
