// Wraps public/icon-192.png into public/favicon.ico.
//
// Google looks for /favicon.ico at the site root before anything a page
// declares, and a root .ico remains the most reliably picked-up favicon across
// search engines and older browsers. An ICO can carry a PNG payload directly,
// so this is a header wrapped around the file we already have, not a re-encode.
//
//   node tools/make-favicon-ico.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'public/icon-192.png';
const TARGET = 'public/favicon.ico';

const png = readFileSync(SOURCE);
if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`${SOURCE} is not a PNG`);

const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width > 256 || height > 256) throw new Error(`${width}x${height} is too large for an ICO entry`);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // 1 = icon
header.writeUInt16LE(1, 4); // one image in this file

const entry = Buffer.alloc(16);
entry.writeUInt8(width === 256 ? 0 : width, 0); // 0 means 256
entry.writeUInt8(height === 256 ? 0 : height, 1);
entry.writeUInt8(0, 2); // palette size, 0 for true colour
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // colour planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12); // where the PNG starts

writeFileSync(TARGET, Buffer.concat([header, entry, png]));
console.log(`${TARGET} written: ${width}x${height}, ${(png.length / 1024).toFixed(1)} KB`);
