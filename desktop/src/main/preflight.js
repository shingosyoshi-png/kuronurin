/*
 * 提出前のPDF点検（プリフライトチェック）。
 *
 * 電子定款や登記の添付書面でよくある差し戻し原因を、提出する前に洗い出す。
 *  - フォントが埋め込まれていない（相手方の環境で字が変わる／文字化けする）
 *  - パスワード保護がかかっている
 *  - 注釈・フォーム・添付ファイル・JavaScriptが紛れ込んでいる
 *  - ページサイズが揃っていない
 *  - 作成者名などのメタデータが残っている
 *  - 既に電子署名が入っているか（入っていれば、以降の編集で壊れる）
 *
 * ここでの判定はあくまで一般的な注意点であり、提出先ごとの要件を保証するものではない。
 */
'use strict';

const { PDFDocument, PDFName, PDFDict, PDFArray, PDFStream } = require('pdf-lib');
const { listSignatures } = require('./sign.js');

/** PDFの標準14フォント（埋め込みがなくても表示できるが、日本語は扱えない） */
const STANDARD_14 = new Set([
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
]);

const FONT_FILE_KEYS = ['FontFile', 'FontFile2', 'FontFile3'];

function nameToString(value) {
  if (!value) return '';
  const text = typeof value.asString === 'function' ? value.asString() : String(value);
  return text.replace(/^\//, '');
}

/** BaseFont の "ABCDEF+NotoSansJP" というサブセット接頭辞を落とす */
function stripSubsetTag(baseFont) {
  return baseFont.replace(/^[A-Z]{6}\+/, '');
}

function lookupDict(context, value) {
  try {
    const resolved = context.lookup(value);
    return resolved instanceof PDFDict ? resolved : null;
  } catch (_) {
    return null;
  }
}

/** フォント辞書1つを見て、埋め込みの有無を判定する */
function describeFont(context, fontDict) {
  const subtype = nameToString(fontDict.get(PDFName.of('Subtype')));
  const baseFont = stripSubsetTag(nameToString(fontDict.get(PDFName.of('BaseFont'))) || '(名前なし)');

  let target = fontDict;
  if (subtype === 'Type0') {
    const descendants = context.lookup(fontDict.get(PDFName.of('DescendantFonts')));
    if (descendants instanceof PDFArray && descendants.size() > 0) {
      const child = lookupDict(context, descendants.get(0));
      if (child) target = child;
    }
  }

  const descriptor = lookupDict(context, target.get(PDFName.of('FontDescriptor')));
  const embedded = !!descriptor && FONT_FILE_KEYS.some((key) => !!descriptor.get(PDFName.of(key)));
  const isStandard = !descriptor && STANDARD_14.has(baseFont);

  return { baseFont, subtype, embedded, isStandard };
}

/** ページのリソース（フォーム内のリソースも含めて）を辿ってフォントを集める */
function collectFontsFromResources(context, resources, pageNumber, found, visited, depth) {
  if (!resources || depth > 6) return;

  const fonts = lookupDict(context, resources.get(PDFName.of('Font')));
  if (fonts) {
    fonts.entries().forEach(([, value]) => {
      const ref = value && value.tag ? value.tag : null;
      const fontDict = lookupDict(context, value);
      if (!fontDict) return;
      const info = describeFont(context, fontDict);
      const key = info.baseFont + '|' + info.subtype;
      const existing = found.get(key);
      if (existing) {
        existing.pages.add(pageNumber);
        return;
      }
      found.set(key, Object.assign({ pages: new Set([pageNumber]), ref: ref }, info));
    });
  }

  const xObjects = lookupDict(context, resources.get(PDFName.of('XObject')));
  if (!xObjects) return;
  xObjects.entries().forEach(([, value]) => {
    const tag = value && value.tag ? value.tag : null;
    if (tag) {
      if (visited.has(tag)) return;
      visited.add(tag);
    }
    let stream;
    try {
      stream = context.lookup(value);
    } catch (_) {
      return;
    }
    if (!(stream instanceof PDFStream)) return;
    const dict = stream.dict;
    if (nameToString(dict.get(PDFName.of('Subtype'))) !== 'Form') return;
    collectFontsFromResources(
      context,
      lookupDict(context, dict.get(PDFName.of('Resources'))),
      pageNumber,
      found,
      visited,
      depth + 1
    );
  });
}

function pageResources(context, page) {
  const own = page.node.Resources();
  if (own) return own;
  const inherited = page.node.getInheritableAttribute(PDFName.of('Resources'));
  return lookupDict(context, inherited);
}

function collectFonts(doc) {
  const context = doc.context;
  const found = new Map();
  doc.getPages().forEach((page, index) => {
    collectFontsFromResources(context, pageResources(context, page), index + 1, found, new Set(), 0);
  });
  return Array.from(found.values()).map((font) => ({
    baseFont: font.baseFont,
    subtype: font.subtype,
    embedded: font.embedded,
    isStandard: font.isStandard,
    pages: Array.from(font.pages).sort((a, b) => a - b),
  }));
}

function collectAnnotations(doc) {
  const context = doc.context;
  const counts = new Map();
  let signatureWidgets = 0;

  doc.getPages().forEach((page) => {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) return;
    for (let i = 0; i < annots.size(); i++) {
      const dict = lookupDict(context, annots.get(i));
      if (!dict) continue;
      const subtype = nameToString(dict.get(PDFName.of('Subtype'))) || '(不明)';
      if (subtype === 'Widget' && nameToString(dict.get(PDFName.of('FT'))) === 'Sig') {
        signatureWidgets += 1;
        continue;
      }
      counts.set(subtype, (counts.get(subtype) || 0) + 1);
    }
  });

  return {
    signatureWidgets,
    entries: Array.from(counts.entries()).map(([subtype, count]) => ({ subtype, count })),
    total: Array.from(counts.values()).reduce((sum, n) => sum + n, 0),
  };
}

function countEmbeddedFiles(doc) {
  const context = doc.context;
  const names = lookupDict(context, doc.catalog.get(PDFName.of('Names')));
  if (!names) return 0;
  const embedded = lookupDict(context, names.get(PDFName.of('EmbeddedFiles')));
  if (!embedded) return 0;
  const list = context.lookup(embedded.get(PDFName.of('Names')));
  return list instanceof PDFArray ? Math.floor(list.size() / 2) : 0;
}

function detectScripts(doc) {
  const context = doc.context;
  const reasons = [];

  const names = lookupDict(context, doc.catalog.get(PDFName.of('Names')));
  if (names && names.get(PDFName.of('JavaScript'))) reasons.push('文書レベルのJavaScript');

  const openAction = lookupDict(context, doc.catalog.get(PDFName.of('OpenAction')));
  if (openAction && nameToString(openAction.get(PDFName.of('S'))) === 'JavaScript') {
    reasons.push('ファイルを開いたときに動くJavaScript');
  }
  if (doc.catalog.get(PDFName.of('AA'))) reasons.push('文書の自動処理（AA）');

  return reasons;
}

/** よく使う用紙（mm）。向きは問わない */
const PAPER_SIZES = [
  { name: 'A3', width: 297, height: 420 },
  { name: 'A4', width: 210, height: 297 },
  { name: 'A5', width: 148, height: 210 },
  { name: 'B4', width: 257, height: 364 },
  { name: 'B5', width: 182, height: 257 },
  { name: 'レター', width: 215.9, height: 279.4 },
];

function describePaper(widthMm, heightMm) {
  const tolerance = 1.5;
  const shortSide = Math.min(widthMm, heightMm);
  const longSide = Math.max(widthMm, heightMm);
  const paper = PAPER_SIZES.find(
    (candidate) =>
      Math.abs(candidate.width - shortSide) <= tolerance && Math.abs(candidate.height - longSide) <= tolerance
  );
  if (!paper) return '';
  return paper.name + (widthMm > heightMm ? '横' : '縦');
}

function formatPageSize(entry) {
  const paper = describePaper(entry.widthMm, entry.heightMm);
  const size = Math.round(entry.widthMm) + '×' + Math.round(entry.heightMm) + 'mm';
  return (paper ? paper + '（' + size + '）' : size) + (entry.rotation ? '・回転' + entry.rotation + '度' : '');
}

function collectPageSizes(doc) {
  const groups = new Map();
  doc.getPages().forEach((page, index) => {
    const size = page.getSize();
    const rotation = page.getRotation().angle || 0;
    const widthMm = Math.round((size.width * 25.4) / 72 * 10) / 10;
    const heightMm = Math.round((size.height * 25.4) / 72 * 10) / 10;
    const key = widthMm + 'x' + heightMm + '@' + rotation;
    const entry = groups.get(key) || { widthMm, heightMm, rotation, pages: [] };
    entry.pages.push(index + 1);
    groups.set(key, entry);
  });
  return Array.from(groups.values());
}

function pdfVersion(buffer) {
  const head = buffer.slice(0, 16).toString('latin1');
  const match = /%PDF-(\d+\.\d+)/.exec(head);
  return match ? match[1] : '不明';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}

function metadataEntries(doc) {
  const read = (fn) => {
    try {
      const value = fn.call(doc);
      return typeof value === 'string' ? value.trim() : '';
    } catch (_) {
      return '';
    }
  };
  return [
    { label: 'タイトル', value: read(doc.getTitle) },
    { label: '作成者', value: read(doc.getAuthor) },
    { label: 'サブタイトル', value: read(doc.getSubject) },
    { label: '作成ソフト', value: read(doc.getCreator) },
    { label: '変換ソフト', value: read(doc.getProducer) },
  ].filter((entry) => entry.value);
}

/**
 * PDFを点検して結果を返す。ファイルは一切書き換えない。
 * @param {Buffer|Uint8Array} pdfBytes
 * @returns {Promise<object>}
 */
async function inspect(pdfBytes) {
  const buffer = Buffer.from(pdfBytes);
  if (buffer.indexOf('%PDF') !== 0) throw new Error('PDFファイルではありません');

  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  const checks = [];
  const add = (check) => checks.push(check);

  /* 1. パスワード保護 */
  if (doc.isEncrypted) {
    add({
      id: 'encryption',
      label: 'パスワード保護',
      level: 'error',
      detail: '暗号化されています。提出前に保護を解除してください。',
    });
  } else {
    add({ id: 'encryption', label: 'パスワード保護', level: 'ok', detail: 'かかっていません。' });
  }

  /* 2. フォントの埋め込み */
  const fonts = collectFonts(doc);
  const missing = fonts.filter((font) => !font.embedded);
  if (!fonts.length) {
    add({
      id: 'fonts',
      label: 'フォントの埋め込み',
      level: 'warn',
      detail: 'フォント情報が見つかりません。画像だけのPDF（スキャン）の可能性があります。',
    });
  } else if (!missing.length) {
    add({
      id: 'fonts',
      label: 'フォントの埋め込み',
      level: 'ok',
      detail: fonts.length + '種類すべて埋め込み済みです。',
      items: fonts.map((font) => font.baseFont + '（埋め込み済み）'),
    });
  } else {
    add({
      id: 'fonts',
      label: 'フォントの埋め込み',
      level: 'error',
      detail:
        missing.length + '種類が埋め込まれていません。相手方の環境で字体が変わる・文字化けする原因になります。',
      items: missing.map(
        (font) =>
          font.baseFont +
          (font.isStandard ? '（PDF標準フォント）' : '（未埋め込み）') +
          ' — ページ ' +
          font.pages.join(',')
      ),
    });
  }

  /* 3. 注釈・フォーム */
  const annotations = collectAnnotations(doc);
  if (annotations.total > 0) {
    add({
      id: 'annotations',
      label: '注釈・フォーム',
      level: 'warn',
      detail: annotations.total + '件あります。付箋やハイライトが残っていないか確認してください。',
      items: annotations.entries.map((entry) => entry.subtype + ': ' + entry.count + '件'),
    });
  } else {
    add({ id: 'annotations', label: '注釈・フォーム', level: 'ok', detail: 'ありません。' });
  }

  /* 4. 添付ファイル */
  const embeddedFiles = countEmbeddedFiles(doc);
  add({
    id: 'attachments',
    label: '添付ファイル',
    level: embeddedFiles > 0 ? 'warn' : 'ok',
    detail: embeddedFiles > 0 ? embeddedFiles + '件が埋め込まれています。' : 'ありません。',
  });

  /* 5. JavaScript・自動処理 */
  const scripts = detectScripts(doc);
  add({
    id: 'scripts',
    label: 'JavaScript・自動処理',
    level: scripts.length ? 'warn' : 'ok',
    detail: scripts.length ? scripts.join(' / ') + ' が含まれています。' : 'ありません。',
  });

  /* 6. ページサイズ */
  const sizes = collectPageSizes(doc);
  add({
    id: 'pageSize',
    label: 'ページサイズ',
    level: sizes.length > 1 ? 'warn' : 'ok',
    detail:
      sizes.length > 1
        ? sizes.length + '種類のサイズが混在しています。'
        : sizes.length
          ? formatPageSize(sizes[0]) + ' で統一されています。'
          : 'ページがありません。',
    items:
      sizes.length > 1
        ? sizes.map((size) => formatPageSize(size) + ' — ページ ' + size.pages.join(','))
        : undefined,
  });

  /* 7. メタデータ */
  const metadata = metadataEntries(doc);
  add({
    id: 'metadata',
    label: 'メタデータ',
    level: metadata.length ? 'warn' : 'ok',
    detail: metadata.length
      ? '作成者情報などが残っています。相手方に渡す書面では削除を検討してください。'
      : '個人・事務所を特定する情報は残っていません。',
    items: metadata.map((entry) => entry.label + ': ' + entry.value),
  });

  /* 8. 電子署名 */
  let signatures = [];
  try {
    signatures = listSignatures(buffer);
  } catch (_) {
    signatures = [];
  }
  if (signatures.length) {
    const broken = signatures.filter((sig) => sig.integrity !== 'valid');
    add({
      id: 'signatures',
      label: '電子署名',
      level: broken.length ? 'error' : 'info',
      detail: broken.length
        ? signatures.length + '件のうち' + broken.length + '件が検証できません。'
        : signatures.length + '件の署名があり、内容は署名時から変わっていません。以降の編集は署名を壊します。',
      items: signatures.map(
        (sig) =>
          '署名' + sig.index + ': ' +
          (sig.certificate ? sig.certificate.subjectCommonName || '(名前なし)' : '証明書不明') +
          ' / ' +
          (sig.integrity === 'valid' ? '検証OK' : '検証NG') +
          (sig.coversWholeDocument ? '' : '（署名後に追記あり）')
      ),
    });
  } else {
    add({ id: 'signatures', label: '電子署名', level: 'info', detail: '付与されていません。' });
  }

  const errors = checks.filter((check) => check.level === 'error').length;
  const warnings = checks.filter((check) => check.level === 'warn').length;

  return {
    summary: {
      pageCount: doc.getPageCount(),
      fileSize: buffer.length,
      fileSizeText: formatSize(buffer.length),
      pdfVersion: pdfVersion(buffer),
      fontCount: fonts.length,
      errors,
      warnings,
      verdict: errors ? 'error' : warnings ? 'warn' : 'ok',
    },
    checks,
  };
}

module.exports = { inspect };
