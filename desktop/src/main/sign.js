/*
 * 電子署名（PKCS#12 の電子証明書による PDF へのデジタル署名）と、署名の読み取り・検証。
 *
 * 注意（実務上の前提）:
 *  - ここで付与するのは PAdES-B-B 相当（PKCS#7 detached / adbe.pkcs7.detached）の署名。
 *    タイムスタンプ（B-T）や長期署名（B-LT / B-LTA）は含まない。
 *  - 登記・供託オンライン申請システムへ提出する添付書面のように、
 *    受付側が対応ソフトを限定している手続では、必ず提出先の要件を確認すること。
 */
'use strict';

const forge = require('node-forge');
const { SignPdf } = require('@signpdf/signpdf');
const { P12Signer } = require('@signpdf/signer-p12');
const { plainAddPlaceholder } = require('@signpdf/placeholder-plain');

const MESSAGE_DIGEST_OID = '1.2.840.113549.1.9.4';
const SIGNING_TIME_OID = '1.2.840.113549.1.9.5';

function attrString(attributes) {
  const out = {};
  attributes.forEach((attr) => {
    const key = attr.shortName || attr.name || attr.type;
    if (key) out[key] = attr.value;
  });
  return out;
}

function describeCertificate(cert) {
  const subject = attrString(cert.subject.attributes);
  const issuer = attrString(cert.issuer.attributes);
  const notAfter = cert.validity.notAfter;
  const daysLeft = Math.floor((notAfter.getTime() - Date.now()) / 86400000);
  return {
    subjectCommonName: subject.CN || '',
    subjectOrganization: subject.O || '',
    subjectCountry: subject.C || '',
    subjectRaw: subject,
    issuerCommonName: issuer.CN || '',
    issuerOrganization: issuer.O || '',
    serialNumber: cert.serialNumber,
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: notAfter.toISOString(),
    expired: notAfter.getTime() < Date.now(),
    daysLeft,
  };
}

/** P12 / PFX を開いて中身の証明書情報を返す（パスワード確認も兼ねる） */
function readCertificateInfo(p12Buffer, passphrase) {
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(p12Buffer).toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, passphrase || '');
  } catch (err) {
    const message = /Invalid password|MAC/i.test(err.message || '')
      ? '証明書のパスワードが違います'
      : '証明書ファイルを読み込めません: ' + err.message;
    throw new Error(message);
  }

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ||
    [];
  if (!certBags.length) throw new Error('証明書が見つかりません');
  if (!keyBags.length) throw new Error('秘密鍵が見つかりません（署名には秘密鍵入りの証明書が必要です）');

  // 秘密鍵に対応する証明書（＝末端の署名用証明書）を探す
  const key = keyBags[0].key;
  let signerCert = certBags[0].cert;
  for (const bag of certBags) {
    const cert = bag.cert;
    if (cert && cert.publicKey && cert.publicKey.n && key.n && cert.publicKey.n.compareTo(key.n) === 0) {
      signerCert = cert;
      break;
    }
  }

  return Object.assign(describeCertificate(signerCert), { chainLength: certBags.length });
}

/**
 * PDF に署名する。
 * @param {object} params
 * @param {Buffer} params.pdfBuffer 署名対象（このあと再保存すると署名は壊れるので最後の工程で呼ぶこと）
 * @param {Buffer} params.p12Buffer
 * @param {string} params.passphrase
 * @param {string} [params.reason] 署名の理由
 * @param {string} [params.name] 署名者名
 * @param {string} [params.location] 場所
 * @param {string} [params.contactInfo] 連絡先
 * @param {number[]} [params.widgetRect] 1ページ目に見える署名欄を置く場合の [x1,y1,x2,y2]
 * @returns {Promise<Buffer>}
 */
async function signPdf(params) {
  const pdfBuffer = Buffer.from(params.pdfBuffer);
  if (pdfBuffer.indexOf('%PDF') !== 0) throw new Error('PDFファイルではありません');

  // 証明書とパスワードをここで先に検証しておく（エラーメッセージを分かりやすくするため）
  const certInfo = readCertificateInfo(params.p12Buffer, params.passphrase);
  if (certInfo.expired && !params.allowExpired) {
    throw new Error('電子証明書の有効期限が切れています（' + certInfo.validTo.slice(0, 10) + '）');
  }

  const signingTime = params.signingTime ? new Date(params.signingTime) : new Date();
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer,
    reason: params.reason || '',
    contactInfo: params.contactInfo || '',
    name: params.name || certInfo.subjectCommonName || '',
    location: params.location || '',
    signingTime,
    widgetRect: params.widgetRect || [0, 0, 0, 0],
    appName: 'kuronurin-desktop',
  });

  const signer = new P12Signer(Buffer.from(params.p12Buffer), {
    passphrase: params.passphrase || '',
  });
  const signed = await new SignPdf().sign(withPlaceholder, signer, signingTime);
  return { pdf: signed, certificate: certInfo, signingTime: signingTime.toISOString() };
}

/** PDF 内の /ByteRange をすべて拾う */
function findByteRanges(pdfBuffer) {
  const text = pdfBuffer.toString('latin1');
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const ranges = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    ranges.push({
      at: match.index,
      byteRange: [
        parseInt(match[1], 10),
        parseInt(match[2], 10),
        parseInt(match[3], 10),
        parseInt(match[4], 10),
      ],
    });
  }
  return ranges;
}

function extractContentsHex(pdfBuffer, byteRange) {
  // /Contents は ByteRange の隙間（gap）に 16進文字列で入っている
  const start = byteRange[0] + byteRange[1];
  const end = byteRange[2];
  const gap = pdfBuffer.slice(start, end).toString('latin1');
  const open = gap.indexOf('<');
  const close = gap.lastIndexOf('>');
  if (open < 0 || close < 0) return null;
  return gap.slice(open + 1, close).replace(/[^0-9a-fA-F]/g, '');
}

/** 署名付き属性（authenticatedAttributes）から指定OIDの値のASN.1ノードを取り出す */
function getAuthenticatedAttribute(rawCapture, oid) {
  const attrs = rawCapture.authenticatedAttributes || [];
  for (const attr of attrs) {
    const attrOid = forge.asn1.derToOid(attr.value[0].value);
    if (attrOid === oid) return attr.value[1].value[0];
  }
  return null;
}

/** UTCTime / GeneralizedTime のASN.1ノードを Date に変換する */
function asn1NodeToDate(node) {
  if (!node) return null;
  try {
    if (node.type === forge.asn1.Type.UTCTIME) return forge.asn1.utcTimeToDate(node.value);
    if (node.type === forge.asn1.Type.GENERALIZEDTIME) {
      return forge.asn1.generalizedTimeToDate(node.value);
    }
  } catch (_) {
    return null;
  }
  return null;
}

/**
 * PDF に含まれる署名を読み取り、内容の改ざんがないかを検証する。
 * 認証局の信頼性（失効確認・トラストアンカー）までは見ないため「簡易検証」。
 */
function listSignatures(pdfBuffer) {
  const buffer = Buffer.from(pdfBuffer);
  const ranges = findByteRanges(buffer);
  const signatures = [];

  ranges.forEach((entry, index) => {
    const result = {
      index: index + 1,
      integrity: 'unknown',
      coversWholeDocument: false,
      signedAt: null,
      certificate: null,
      errors: [],
    };
    try {
      const [a, b, c, d] = entry.byteRange;
      const signedBytes = Buffer.concat([buffer.slice(a, a + b), buffer.slice(c, c + d)]);
      const tail = buffer.slice(c + d).toString('latin1').trim();
      result.coversWholeDocument = tail.length === 0;

      const hex = extractContentsHex(buffer, entry.byteRange);
      if (!hex) throw new Error('署名データを取り出せません');
      const der = forge.util.hexToBytes(hex.replace(/(00)+$/, ''));
      const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(der)));
      const rawCapture = p7.rawCapture;

      const cert = p7.certificates && p7.certificates.length ? p7.certificates[0] : null;
      if (cert) result.certificate = describeCertificate(cert);

      const digestOid = forge.asn1.derToOid(rawCapture.digestAlgorithm);
      const algName = forge.pki.oids[digestOid] || 'sha256';

      // 1) 署名対象バイト列のハッシュが messageDigest 属性と一致するか
      const contentDigest = forge.md[algName].create();
      contentDigest.update(signedBytes.toString('binary'));
      const messageDigestAttr = getAuthenticatedAttribute(rawCapture, MESSAGE_DIGEST_OID);
      if (!messageDigestAttr) throw new Error('messageDigest属性がありません');
      const digestMatches = contentDigest.digest().getBytes() === messageDigestAttr.value;

      // 2) 署名付き属性そのものへの署名が証明書の公開鍵で検証できるか
      const attrSet = forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.SET,
        true,
        rawCapture.authenticatedAttributes
      );
      const attrDigest = forge.md[algName].create();
      attrDigest.update(forge.asn1.toDer(attrSet).getBytes());
      const signatureValid =
        !!cert && cert.publicKey.verify(attrDigest.digest().getBytes(), rawCapture.signature);

      result.integrity = digestMatches && signatureValid ? 'valid' : 'invalid';
      if (!digestMatches) result.errors.push('署名後に文書が変更されています');
      if (!signatureValid) result.errors.push('署名値を証明書で検証できません');

      const signedAt = asn1NodeToDate(getAuthenticatedAttribute(rawCapture, SIGNING_TIME_OID));
      if (signedAt) result.signedAt = signedAt.toISOString();
    } catch (err) {
      result.integrity = 'error';
      result.errors.push(err.message);
    }
    signatures.push(result);
  });

  return signatures;
}

module.exports = { readCertificateInfo, signPdf, listSignatures };
