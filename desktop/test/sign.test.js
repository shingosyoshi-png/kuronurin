'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readCertificateInfo, signPdf, listSignatures } = require('../src/main/sign.js');
const { makeTestP12, makeTestPdf } = require('./helpers.js');

const PASSPHRASE = 'test-pass';
let p12;

test.before(() => {
  p12 = makeTestP12(PASSPHRASE);
});

test('P12から証明書情報を読める', () => {
  const info = readCertificateInfo(p12, PASSPHRASE);
  assert.strictEqual(info.subjectCommonName, 'Shingo Yoshi');
  assert.strictEqual(info.subjectCountry, 'JP');
  assert.strictEqual(info.expired, false);
  assert.ok(info.daysLeft > 300);
});

test('パスワードが違えば分かりやすいエラーになる', () => {
  assert.throws(() => readCertificateInfo(p12, 'wrong'), /パスワードが違います/);
});

test('署名したPDFが検証を通る', async () => {
  const pdf = await makeTestPdf(2, 'signed');
  const { pdf: signed, certificate } = await signPdf({
    pdfBuffer: pdf,
    p12Buffer: p12,
    passphrase: PASSPHRASE,
    reason: '内容に相違ないことを証明します',
    location: '静岡県富士市',
  });

  assert.strictEqual(certificate.subjectCommonName, 'Shingo Yoshi');
  assert.ok(signed.length > pdf.length);

  const signatures = listSignatures(signed);
  assert.strictEqual(signatures.length, 1);
  assert.strictEqual(signatures[0].integrity, 'valid', signatures[0].errors.join(' / '));
  assert.strictEqual(signatures[0].coversWholeDocument, true);
  assert.strictEqual(signatures[0].certificate.subjectCommonName, 'Shingo Yoshi');
  assert.ok(signatures[0].signedAt);
});

test('署名後に改ざんすると検証で落ちる', async () => {
  const pdf = await makeTestPdf(1, 'tamper');
  const { pdf: signed } = await signPdf({
    pdfBuffer: pdf,
    p12Buffer: p12,
    passphrase: PASSPHRASE,
  });

  // 署名対象範囲にある平文（MediaBox）を1文字だけ書き換える
  const tampered = Buffer.from(signed);
  const target = tampered.indexOf('/MediaBox [ 0 0 595 842 ]');
  assert.ok(target > 0, 'テスト用の書き換え位置が見つからない');
  tampered.write('/MediaBox [ 0 0 596 842 ]', target, 'latin1');

  const signatures = listSignatures(tampered);
  assert.strictEqual(signatures[0].integrity, 'invalid');
  assert.ok(signatures[0].errors.length > 0);
});

test('見える署名欄の位置を指定できる', async () => {
  const pdf = await makeTestPdf(1, 'widget');
  const { pdf: signed } = await signPdf({
    pdfBuffer: pdf,
    p12Buffer: p12,
    passphrase: PASSPHRASE,
    widgetRect: [400, 60, 560, 160],
  });
  assert.match(signed.toString('latin1'), /\/Rect\s*\[\s*400/);
  assert.strictEqual(listSignatures(signed)[0].integrity, 'valid');
});

test('有効期限切れの証明書は既定で拒否する', async () => {
  const expired = makeTestP12(PASSPHRASE, {
    notBefore: new Date(Date.now() - 86400000 * 400),
    notAfter: new Date(Date.now() - 86400000),
  });
  const pdf = await makeTestPdf(1, 'expired');
  await assert.rejects(
    () => signPdf({ pdfBuffer: pdf, p12Buffer: expired, passphrase: PASSPHRASE }),
    /有効期限が切れています/
  );
});

test('署名のないPDFは署名0件として返る', async () => {
  const pdf = await makeTestPdf(1, 'plain');
  assert.deepStrictEqual(listSignatures(pdf), []);
});
