// Minimal asar reader: list or extract a subtree from an Electron asar archive.
// Usage: node asar-list.mjs <archive> <prefix> [outDir]
//   - no outDir: list entries under prefix
//   - with outDir: extract entries under prefix (incl. unpacked siblings from .unpacked)
import fs from 'node:fs';
import path from 'node:path';

const [archive, prefix = '', outDir] = process.argv.slice(2);
if (!archive) {
  console.error('usage: node asar-list.mjs <archive> [prefix] [outDir]');
  process.exit(1);
}

const fd = fs.openSync(archive, 'r');
const pickle = Buffer.alloc(16);
fs.readSync(fd, pickle, 0, 16, 0);
const jsonLen = pickle.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const baseOffset = 16 + jsonLen;

function walk(node, rel, cb) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, rel ? rel + '/' + name : name, cb);
  } else if (node.unpacked) {
    cb(rel, null, true);
  } else {
    cb(rel, { offset: baseOffset + Number(node.offset), size: node.size }, false);
  }
}

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  walk(header, '', (rel, file, unpacked) => {
    if (!(rel === prefix || rel.startsWith(prefix + '/'))) return;
    const relInside = rel === prefix ? '' : rel.slice(prefix.length + 1);
    if (!relInside) return;
    const dest = path.join(outDir, relInside);
    if (unpacked) {
      const src = path.join(path.dirname(archive), path.basename(archive) + '.unpacked', rel);
      if (fs.existsSync(src)) {
        if (fs.statSync(src).isDirectory()) fs.cpSync(src, dest, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        }
      }
      return;
    }
    if (!file) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = Buffer.alloc(file.size);
    fs.readSync(fd, buf, 0, file.size, file.offset);
    fs.writeFileSync(dest, buf);
  });
  console.log('extracted ' + prefix + ' to ' + outDir);
} else {
  const entries = [];
  walk(header, '', (rel, file, unpacked) => {
    if (rel === prefix || rel.startsWith(prefix + '/')) {
      entries.push((unpacked ? 'U ' : file ? 'F ' : 'D ') + rel);
    }
  });
  console.log(entries.join('\n'));
}
