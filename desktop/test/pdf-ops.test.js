'use strict';

const test = require('node:test');
const assert = require('node:assert');
const PDFLib = require('pdf-lib');
const ops = require('../src/shared/pdf-ops.js');
const { makeTestPdf } = require('./helpers.js');

async function pageCount(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes);
  return doc.getPageCount();
}

test('ページ指定を解釈できる', () => {
  assert.deepStrictEqual(ops.parsePageRanges('1-3,5,8-', 10), [0, 1, 2, 4, 7, 8, 9]);
  assert.deepStrictEqual(ops.parsePageRanges('3', 5), [2]);
  assert.deepStrictEqual(ops.parsePageRanges('-2', 5), [0, 1]);
  assert.deepStrictEqual(ops.parsePageRanges('', 5), []);
  // 全角の読点・波ダッシュも受け付ける
  assert.deepStrictEqual(ops.parsePageRanges('1、3～4', 5), [0, 2, 3]);
  // 重複は1回だけ、逆順指定は降順で取り出す
  assert.deepStrictEqual(ops.parsePageRanges('1,1,2', 5), [0, 1]);
  assert.deepStrictEqual(ops.parsePageRanges('3-1', 5), [2, 1, 0]);
});

test('不正なページ指定はエラーになる', () => {
  assert.throws(() => ops.parsePageRanges('1-99', 10), /総ページ数/);
  assert.throws(() => ops.parsePageRanges('abc', 10), /解釈できません/);
  assert.throws(() => ops.parsePageRanges('0', 10), /1以上/);
});

test('等分割の区切りを作れる', () => {
  assert.deepStrictEqual(ops.buildEqualChunks(5, 2), [[0, 1], [2, 3], [4]]);
  assert.deepStrictEqual(ops.buildEqualChunks(4, 4), [[0, 1, 2, 3]]);
  assert.throws(() => ops.buildEqualChunks(4, 0), /1以上/);
});

test('ページ番号の表示文字列に戻せる', () => {
  assert.strictEqual(ops.formatRanges([0, 1, 2, 4, 7, 8, 9]), '1-3,5,8-10');
  assert.strictEqual(ops.formatRanges([]), '');
});

test('指定ページを抽出できる（分割）', async () => {
  const pdf = await makeTestPdf(6, 'src');
  const out = await ops.extractPages(PDFLib, pdf, [0, 1, 2]);
  assert.strictEqual(await pageCount(out), 3);
});

test('複数PDFを結合できる', async () => {
  const a = await makeTestPdf(2, 'a');
  const b = await makeTestPdf(3, 'b');
  const merged = await ops.mergePdfs(PDFLib, [{ bytes: a }, { bytes: b }]);
  assert.strictEqual(await pageCount(merged), 5);
});

test('結合時にページを絞り込める', async () => {
  const a = await makeTestPdf(4, 'a');
  const b = await makeTestPdf(4, 'b');
  const merged = await ops.mergePdfs(PDFLib, [
    { bytes: a, indices: [0] },
    { bytes: b, indices: [1, 2] },
  ]);
  assert.strictEqual(await pageCount(merged), 3);
});

test('メタデータを削除できる', async () => {
  const src = await PDFLib.PDFDocument.create();
  src.addPage([200, 200]);
  src.setAuthor('秘密の作成者');
  src.setTitle('秘密のタイトル');
  const bytes = await src.save({ useObjectStreams: false });

  const kept = await ops.extractPages(PDFLib, bytes, [0]);
  const stripped = await ops.extractPages(PDFLib, bytes, [0], { removeMetadata: true });
  const strippedDoc = await PDFLib.PDFDocument.load(stripped);
  assert.strictEqual(strippedDoc.getAuthor(), '');
  assert.ok(kept.length > 0);
});

test('ページを回転できる', async () => {
  const pdf = await makeTestPdf(2, 'rot');
  const out = await ops.rotatePages(PDFLib, pdf, [0], 90);
  const doc = await PDFLib.PDFDocument.load(out);
  assert.strictEqual(doc.getPages()[0].getRotation().angle, 90);
  assert.strictEqual(doc.getPages()[1].getRotation().angle, 0);
});

test('ページを削除できる（全削除は拒否）', async () => {
  const pdf = await makeTestPdf(3, 'del');
  const out = await ops.deletePages(PDFLib, pdf, [1]);
  assert.strictEqual(await pageCount(out), 2);
  await assert.rejects(() => ops.deletePages(PDFLib, pdf, [0, 1, 2]), /すべてのページ/);
});

test('印影画像を貼り付けられる', async () => {
  const pdf = await makeTestPdf(1, 'stamp');
  // 1x1 の赤いPNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const out = await ops.stampImage(PDFLib, pdf, {
    pageIndex: 0,
    imageBytes: png,
    x: 400,
    y: 80,
    width: 100,
    opacity: 0.9,
  });
  assert.ok(out.length > pdf.length);
  assert.strictEqual(await pageCount(out), 1);
  await assert.rejects(
    () => ops.stampImage(PDFLib, pdf, { pageIndex: 5, imageBytes: png, x: 0, y: 0, width: 10 }),
    /指定ページが存在しません/
  );
});

test('ファイル名を安全な文字列にできる', () => {
  assert.strictEqual(ops.sanitizeFileName('報告書/2026:第1回*'), '報告書_2026_第1回_');
  assert.strictEqual(ops.sanitizeFileName('   ', 'fallback'), 'fallback');
  assert.strictEqual(ops.sanitizeFileName('...hidden'), 'hidden');
});
