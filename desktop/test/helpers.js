'use strict';

const forge = require('node-forge');
const { PDFDocument, StandardFonts } = require('pdf-lib');

/** テスト用の自己署名証明書入り P12 を作る */
function makeTestP12(passphrase, options) {
  options = options || {};
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = options.notBefore || new Date(Date.now() - 86400000);
  cert.validity.notAfter = options.notAfter || new Date(Date.now() + 86400000 * 365);
  const attrs = [
    { name: 'commonName', value: options.commonName || 'Shingo Yoshi' },
    { name: 'countryName', value: 'JP' },
    { name: 'organizationName', value: options.organization || 'Judicial Scrivener Office LINK' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, {
    algorithm: '3des',
  });
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

/** テスト用の複数ページ PDF を作る */
async function makeTestPdf(pageCount, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${label || 'page'} ${i + 1}`, { x: 60, y: 760, size: 24, font });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

module.exports = { makeTestP12, makeTestPdf };
