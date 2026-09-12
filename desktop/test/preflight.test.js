'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fontkit = require('@pdf-lib/fontkit');
const { PDFDocument, StandardFonts, PDFName, PDFString } = require('pdf-lib');
const { inspect } = require('../src/main/preflight.js');
const { signPdf } = require('../src/main/sign.js');
const { makeTestP12, makeTestPdf } = require('./helpers.js');

const EMBEDDABLE_FONT = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf';

function findCheck(report, id) {
  const check = report.checks.find((entry) => entry.id === id);
  assert.ok(check, '点検項目が見つからない: ' + id);
  return check;
}

/** 標準フォント（未埋め込み）だけのPDF */
async function makeStandardFontPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('teikan', { x: 60, y: 760, size: 20, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** フォントを埋め込んだPDF */
async function makeEmbeddedFontPdf() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(EMBEDDABLE_FONT), { subset: true });
  const page = doc.addPage([595, 842]);
  page.drawText('teikan', { x: 60, y: 760, size: 20, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('フォント未埋め込みをエラーとして検出する', async () => {
  const report = await inspect(await makeStandardFontPdf());
  const fonts = findCheck(report, 'fonts');
  assert.strictEqual(fonts.level, 'error');
  assert.match(fonts.items.join(' '), /Helvetica/);
  assert.match(fonts.items.join(' '), /PDF標準フォント/);
  assert.strictEqual(report.summary.verdict, 'error');
});

test('埋め込み済みフォントは問題なしと判定する', async () => {
  const report = await inspect(await makeEmbeddedFontPdf());
  const fonts = findCheck(report, 'fonts');
  assert.strictEqual(fonts.level, 'ok', fonts.detail);
  assert.strictEqual(report.summary.fontCount, 1);
});

test('サブセット接頭辞を外したフォント名で表示する', async () => {
  const report = await inspect(await makeEmbeddedFontPdf());
  const fonts = findCheck(report, 'fonts');
  assert.ok(
    fonts.items.every((item) => !/^[A-Z]{6}\+/.test(item)),
    'サブセット接頭辞が残っている: ' + fonts.items.join(' ')
  );
});

test('注釈が残っていれば警告する', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [100, 100, 120, 120],
    Contents: PDFString.of('確認してください'),
  });
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
  const report = await inspect(Buffer.from(await doc.save({ useObjectStreams: false })));

  const annotations = findCheck(report, 'annotations');
  assert.strictEqual(annotations.level, 'warn');
  assert.match(annotations.items.join(' '), /Text: 1件/);
});

test('メタデータが残っていれば警告する', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.setAuthor('司法書士 甲野太郎');
  doc.setTitle('定款');
  const report = await inspect(Buffer.from(await doc.save({ useObjectStreams: false })));

  const metadata = findCheck(report, 'metadata');
  assert.strictEqual(metadata.level, 'warn');
  assert.match(metadata.items.join(' '), /甲野太郎/);
});

test('ページサイズが混在していれば警告する', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([420, 595]);
  const report = await inspect(Buffer.from(await doc.save({ useObjectStreams: false })));

  const pageSize = findCheck(report, 'pageSize');
  assert.strictEqual(pageSize.level, 'warn');
  assert.strictEqual(pageSize.items.length, 2);
});

test('ページサイズが揃っていれば問題なしとする', async () => {
  const report = await inspect(await makeTestPdf(3, 'same'));
  const pageSize = findCheck(report, 'pageSize');
  assert.strictEqual(pageSize.level, 'ok');
  assert.match(pageSize.detail, /A4縦（210×297mm）/);
});

test('添付ファイルとJavaScriptを検出する', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const fileStream = doc.context.flateStream('dummy');
  const fileSpec = doc.context.obj({
    Type: 'Filespec',
    F: PDFString.of('memo.txt'),
    EF: { F: doc.context.register(fileStream) },
  });
  const jsAction = doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') });
  doc.catalog.set(
    PDFName.of('Names'),
    doc.context.obj({
      EmbeddedFiles: { Names: [PDFString.of('memo.txt'), doc.context.register(fileSpec)] },
      JavaScript: { Names: [PDFString.of('hello'), doc.context.register(jsAction)] },
    })
  );
  const report = await inspect(Buffer.from(await doc.save({ useObjectStreams: false })));

  assert.strictEqual(findCheck(report, 'attachments').level, 'warn');
  assert.match(findCheck(report, 'attachments').detail, /1件/);
  assert.strictEqual(findCheck(report, 'scripts').level, 'warn');
});

test('署名済みPDFは署名の状態を知らせる', async () => {
  const p12 = makeTestP12('pass');
  const { pdf: signed } = await signPdf({
    pdfBuffer: await makeEmbeddedFontPdf(),
    p12Buffer: p12,
    passphrase: 'pass',
  });
  const report = await inspect(signed);

  const signatures = findCheck(report, 'signatures');
  assert.strictEqual(signatures.level, 'info');
  assert.match(signatures.items.join(' '), /検証OK/);
  // 署名欄（Widget）は注釈としては数えない
  assert.strictEqual(findCheck(report, 'annotations').level, 'ok');
});

test('署名後に改ざんされたPDFはエラーにする', async () => {
  const p12 = makeTestP12('pass');
  const { pdf: signed } = await signPdf({
    pdfBuffer: await makeTestPdf(1, 'x'),
    p12Buffer: p12,
    passphrase: 'pass',
  });
  const tampered = Buffer.from(signed);
  const target = tampered.indexOf('/MediaBox [ 0 0 595 842 ]');
  assert.ok(target > 0);
  tampered.write('/MediaBox [ 0 0 596 842 ]', target, 'latin1');

  const report = await inspect(tampered);
  assert.strictEqual(findCheck(report, 'signatures').level, 'error');
  assert.strictEqual(report.summary.verdict, 'error');
});

test('問題のないPDFはすべて問題なしになる', async () => {
  const doc = await PDFDocument.load(await makeEmbeddedFontPdf());
  doc.setAuthor('');
  doc.setProducer('');
  doc.setCreator('');
  const report = await inspect(Buffer.from(await doc.save({ useObjectStreams: false })));

  assert.strictEqual(report.summary.errors, 0);
  assert.strictEqual(report.summary.warnings, 0, JSON.stringify(report.checks));
  assert.strictEqual(report.summary.verdict, 'ok');
  assert.strictEqual(report.summary.pageCount, 1);
  assert.match(report.summary.pdfVersion, /^\d\.\d$/);
});

test('PDFでなければエラーになる', async () => {
  await assert.rejects(() => inspect(Buffer.from('not a pdf')), /PDFファイルではありません/);
});
