/*
 * PDFページ操作の共通ロジック。
 * Node（テスト・メインプロセス）とレンダラー（<script>読み込み）の両方から使える形にしてある。
 * pdf-lib 本体は呼び出し側から引数で渡す（環境ごとに読み込み方が違うため）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KuroPdfOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * "1-3,5,8-" のようなページ指定を 0 始まりのインデックス配列に変換する。
   * @param {string} spec
   * @param {number} pageCount
   * @returns {number[]}
   */
  function parsePageRanges(spec, pageCount) {
    if (typeof spec !== 'string') throw new TypeError('ページ指定は文字列で渡してください');
    var normalized = spec
      .replace(/　/g, ' ')
      .replace(/[，、]/g, ',')
      .replace(/[〜～ー–—]/g, '-')
      .trim();
    if (!normalized) return [];

    var out = [];
    var seen = Object.create(null);
    var parts = normalized.split(',');

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (!part) continue;

      var m = /^(\d+)?\s*-\s*(\d+)?$/.exec(part);
      var from, to;
      if (m && (m[1] || m[2])) {
        from = m[1] ? parseInt(m[1], 10) : 1;
        to = m[2] ? parseInt(m[2], 10) : pageCount;
      } else if (/^\d+$/.test(part)) {
        from = to = parseInt(part, 10);
      } else {
        throw new Error('ページ指定を解釈できません: "' + part + '"');
      }

      if (from < 1 || to < 1) throw new Error('ページ番号は1以上で指定してください: "' + part + '"');
      if (from > pageCount || to > pageCount) {
        throw new Error('ページ番号が総ページ数(' + pageCount + ')を超えています: "' + part + '"');
      }
      var step = from <= to ? 1 : -1;
      for (var p = from; step > 0 ? p <= to : p >= to; p += step) {
        var idx = p - 1;
        if (seen[idx]) continue;
        seen[idx] = true;
        out.push(idx);
      }
    }
    return out;
  }

  /**
   * 全ページを size ページずつの塊に分ける。
   * @returns {number[][]} 0始まりインデックスの配列の配列
   */
  function buildEqualChunks(pageCount, size) {
    if (!(size >= 1)) throw new Error('分割ページ数は1以上で指定してください');
    var chunks = [];
    for (var start = 0; start < pageCount; start += size) {
      var chunk = [];
      for (var i = start; i < Math.min(start + size, pageCount); i++) chunk.push(i);
      chunks.push(chunk);
    }
    return chunks;
  }

  /** 0始まりインデックス配列を "1-3,5" 形式の表示用文字列に戻す */
  function formatRanges(indices) {
    if (!indices.length) return '';
    var sorted = indices.slice().sort(function (a, b) { return a - b; });
    var out = [];
    var start = sorted[0];
    var prev = sorted[0];
    for (var i = 1; i <= sorted.length; i++) {
      var cur = sorted[i];
      if (cur !== prev + 1) {
        out.push(start === prev ? String(start + 1) : (start + 1) + '-' + (prev + 1));
        start = cur;
      }
      prev = cur;
    }
    return out.join(',');
  }

  function stripMetadata(doc) {
    doc.setTitle('');
    doc.setAuthor('');
    doc.setSubject('');
    doc.setKeywords([]);
    doc.setProducer('');
    doc.setCreator('');
  }

  /** 指定ページだけを抜き出した新しいPDFを作る */
  async function extractPages(PDFLib, bytes, indices, options) {
    options = options || {};
    if (!indices.length) throw new Error('抽出するページが指定されていません');
    var src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    var out = await PDFLib.PDFDocument.create();
    var copied = await out.copyPages(src, indices);
    copied.forEach(function (page) { out.addPage(page); });
    if (options.removeMetadata) stripMetadata(out);
    return out.save({ useObjectStreams: false });
  }

  /** 複数PDFを順番どおりに結合する。inputs は [{bytes, indices?}] */
  async function mergePdfs(PDFLib, inputs, options) {
    options = options || {};
    if (!inputs || !inputs.length) throw new Error('結合するPDFがありません');
    var out = await PDFLib.PDFDocument.create();
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var src = await PDFLib.PDFDocument.load(input.bytes, { ignoreEncryption: true });
      var indices = input.indices && input.indices.length
        ? input.indices
        : src.getPageIndices();
      var copied = await out.copyPages(src, indices);
      copied.forEach(function (page) { out.addPage(page); });
    }
    if (options.removeMetadata) stripMetadata(out);
    return out.save({ useObjectStreams: false });
  }

  /** 指定ページを回転（degrees は 90 の倍数、相対回転） */
  async function rotatePages(PDFLib, bytes, indices, degrees) {
    var doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    var pages = doc.getPages();
    indices.forEach(function (idx) {
      var page = pages[idx];
      if (!page) return;
      var current = page.getRotation().angle || 0;
      page.setRotation(PDFLib.degrees(((current + degrees) % 360 + 360) % 360));
    });
    return doc.save({ useObjectStreams: false });
  }

  /** 指定ページを削除 */
  async function deletePages(PDFLib, bytes, indices) {
    var doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    var total = doc.getPageCount();
    var remove = indices.slice().sort(function (a, b) { return b - a; });
    if (remove.length >= total) throw new Error('すべてのページは削除できません');
    remove.forEach(function (idx) {
      if (idx >= 0 && idx < total) doc.removePage(idx);
    });
    return doc.save({ useObjectStreams: false });
  }

  /**
   * 印影・手書きサインなどの画像を貼り付ける（見た目の署名）。
   * 座標は左下原点のPDF座標系（pt）。
   */
  async function stampImage(PDFLib, bytes, spec) {
    var doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    var page = doc.getPages()[spec.pageIndex];
    if (!page) throw new Error('指定ページが存在しません: ' + (spec.pageIndex + 1));

    var head = new Uint8Array(spec.imageBytes).subarray(0, 4);
    var isPng = head[0] === 0x89 && head[1] === 0x50;
    var image = isPng ? await doc.embedPng(spec.imageBytes) : await doc.embedJpg(spec.imageBytes);

    var width = spec.width;
    var height = spec.height;
    if (!width && !height) {
      width = image.width;
      height = image.height;
    } else if (!height) {
      height = image.height * (width / image.width);
    } else if (!width) {
      width = image.width * (height / image.height);
    }

    page.drawImage(image, {
      x: spec.x,
      y: spec.y,
      width: width,
      height: height,
      opacity: typeof spec.opacity === 'number' ? spec.opacity : 1,
    });
    return doc.save({ useObjectStreams: false });
  }

  /** ファイル名として使えない文字を除去する */
  function sanitizeFileName(name, fallback) {
    var cleaned = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|]/g, '_')
      .split('')
      .filter(function (ch) { return ch.charCodeAt(0) > 31; })
      .join('')
      .replace(/^\.+/, '')
      .trim();
    if (!cleaned) cleaned = fallback || 'untitled';
    if (cleaned.length > 120) cleaned = cleaned.slice(0, 120);
    return cleaned;
  }

  return {
    parsePageRanges: parsePageRanges,
    buildEqualChunks: buildEqualChunks,
    formatRanges: formatRanges,
    extractPages: extractPages,
    mergePdfs: mergePdfs,
    rotatePages: rotatePages,
    deletePages: deletePages,
    stampImage: stampImage,
    sanitizeFileName: sanitizeFileName,
  };
});
