// QR codes for share links and room invites, rendered as SVG inside the Worker.

import qrcode from 'qrcode-generator';

/**
 * @param {string} text
 * @returns {string} standalone SVG document
 */
export function qrSvg(text, { size = 320, margin = 2, dark = '#000000', light = '#ffffff' } = {}) {
  const qr = qrcode(0, 'M'); // type 0 = pick the smallest version that fits
  qr.addData(text);
  qr.make();

  const modules = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }

  const span = modules + margin * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${size}" height="${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${span}" height="${span}" fill="${light}"/>` +
    `<g transform="translate(${margin} ${margin})" fill="${dark}">${path ? `<path d="${path}"/>` : ''}</g>` +
    `</svg>`
  );
}
