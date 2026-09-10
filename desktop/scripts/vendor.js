// pdf.js の配布ファイルを renderer/vendor/ にコピーする（オフライン動作のため CDN は使わない）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'src', 'renderer', 'vendor');

const files = [
  ['pdfjs-dist/legacy/build/pdf.js', 'pdf.js'],
  ['pdfjs-dist/legacy/build/pdf.worker.js', 'pdf.worker.js'],
  ['pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.min.js'],
];

fs.mkdirSync(dest, { recursive: true });
for (const [from, to] of files) {
  const src = path.join(root, 'node_modules', from);
  if (!fs.existsSync(src)) {
    console.warn(`[vendor] skip (not found): ${from}`);
    continue;
  }
  fs.copyFileSync(src, path.join(dest, to));
  console.log(`[vendor] ${from} -> src/renderer/vendor/${to}`);
}
