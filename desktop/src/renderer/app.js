/*
 * 画面側のロジック。ファイルの読み書きと署名はすべて window.kuro（メインプロセス）に任せ、
 * ここではPDFの中身の操作（pdf-lib）と表示（pdf.js）だけを行う。
 */
(function () {
  'use strict';

  var ops = window.KuroPdfOps;
  var PDFLib = window.PDFLib;
  var pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.js';

  var $ = function (id) { return document.getElementById(id); };
  var seq = 0;

  var state = {
    docs: [],
    activeId: null,
    selection: [],
    splitDir: null,
    merge: [],
    renameFiles: [],
    renamePlan: null,
    lastUndo: null,
    cert: null,
    stamp: null,
    previewScale: 1,
    previewPage: 0,
  };

  /* ---------------------------------------------------------------- *
   * 小物
   * ---------------------------------------------------------------- */

  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.className = 'toast' + (isError ? ' err' : '');
    el.hidden = false;
    clearTimeout(el._timer);
    el._timer = setTimeout(function () { el.hidden = true; }, isError ? 6000 : 3000);
  }

  function busy(message) {
    $('overlayText').textContent = message || '処理中...';
    $('overlay').hidden = false;
  }
  function idle() { $('overlay').hidden = true; }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1048576).toFixed(1) + 'MB';
  }

  function baseName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  function todayStamp() {
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  function activeDoc() {
    for (var i = 0; i < state.docs.length; i++) {
      if (state.docs[i].id === state.activeId) return state.docs[i];
    }
    return null;
  }

  function requireActiveDoc() {
    var doc = activeDoc();
    if (!doc) throw new Error('先にPDFを開いてください');
    return doc;
  }

  async function run(message, task) {
    try {
      busy(message);
      var result = await task();
      idle();
      return result;
    } catch (err) {
      idle();
      console.error(err);
      toast(err && err.message ? err.message : String(err), true);
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- *
   * PDFの読み込み
   * ---------------------------------------------------------------- */

  async function addDocs(files) {
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var bytes = new Uint8Array(file.bytes);
      var pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      var doc = {
        id: ++seq,
        name: file.name,
        path: file.path || '',
        dir: file.dir || '',
        size: file.size != null ? file.size : bytes.length,
        bytes: bytes,
        pageCount: pdf.numPages,
        dirty: false,
      };
      pdf.destroy();
      state.docs.push(doc);
      state.activeId = doc.id;
      addMergeItem(doc);
    }
    state.selection = [];
    renderFileList();
    renderMergeList();
    await renderThumbs();
    await renderPreview();
  }

  async function openPdfDialog() {
    var files = await window.kuro.openPdfs();
    if (!files.length) return;
    await run('PDFを読み込んでいます...', function () { return addDocs(files); });
  }

  async function openPdfPaths(paths) {
    if (!paths || !paths.length) return;
    await run('PDFを読み込んでいます...', async function () {
      var files = [];
      for (var i = 0; i < paths.length; i++) files.push(await window.kuro.readPdf(paths[i]));
      await addDocs(files);
    });
  }

  function removeDoc(id) {
    state.docs = state.docs.filter(function (d) { return d.id !== id; });
    state.merge = state.merge.filter(function (m) { return m.docId !== id; });
    if (state.activeId === id) state.activeId = state.docs.length ? state.docs[0].id : null;
    state.selection = [];
    renderFileList();
    renderMergeList();
    renderThumbs();
    renderPreview();
  }

  function renderFileList() {
    var list = $('splitFileList');
    list.innerHTML = '';
    if (!state.docs.length) {
      list.innerHTML = '<p class="empty">PDFを開いてください</p>';
      $('splitDocName').textContent = 'ファイル未選択';
      $('signDocName').textContent = 'ファイル未選択';
      return;
    }
    state.docs.forEach(function (doc) {
      var row = document.createElement('div');
      row.className = 'file-item' + (doc.id === state.activeId ? ' active' : '');
      var name = document.createElement('span');
      name.className = 'fname';
      name.textContent = doc.name + (doc.dirty ? ' *' : '');
      var meta = document.createElement('span');
      meta.className = 'fmeta';
      meta.textContent = doc.pageCount + 'p';
      var close = document.createElement('button');
      close.className = 'fx';
      close.textContent = '×';
      close.title = '閉じる';
      close.addEventListener('click', function (e) { e.stopPropagation(); removeDoc(doc.id); });
      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(close);
      row.addEventListener('click', function () {
        state.activeId = doc.id;
        state.selection = [];
        renderFileList();
        renderThumbs();
        renderPreview();
      });
      list.appendChild(row);
    });

    var doc = activeDoc();
    var label = doc ? doc.name + '（' + doc.pageCount + 'ページ' + (doc.dirty ? ' / 未保存の編集あり' : '') + '）' : 'ファイル未選択';
    $('splitDocName').textContent = label;
    $('signDocName').textContent = label;
  }

  /* ---------------------------------------------------------------- *
   * サムネイル
   * ---------------------------------------------------------------- */

  var thumbToken = 0;

  async function renderThumbs() {
    var container = $('thumbs');
    container.innerHTML = '';
    var doc = activeDoc();
    if (!doc) {
      container.innerHTML = '<p class="empty">PDFを開くとページがここに並びます</p>';
      return;
    }
    var token = ++thumbToken;
    var pdf = await pdfjsLib.getDocument({ data: doc.bytes.slice() }).promise;

    for (var i = 1; i <= pdf.numPages; i++) {
      if (token !== thumbToken) { pdf.destroy(); return; }
      var page = await pdf.getPage(i);
      var viewport = page.getViewport({ scale: 1 });
      var scale = 260 / viewport.width;
      var scaled = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(scaled.width);
      canvas.height = Math.round(scaled.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;

      var cell = document.createElement('div');
      cell.className = 'thumb';
      cell.dataset.index = String(i - 1);
      var no = document.createElement('span');
      no.className = 'no';
      no.textContent = String(i);
      cell.appendChild(canvas);
      cell.appendChild(no);
      var rotation = page.rotate;
      if (rotation) {
        var badge = document.createElement('span');
        badge.className = 'rot';
        badge.textContent = rotation + '°';
        cell.appendChild(badge);
      }
      cell.addEventListener('click', onThumbClick);
      container.appendChild(cell);
    }
    pdf.destroy();
    paintSelection();
  }

  function onThumbClick(event) {
    var index = Number(event.currentTarget.dataset.index);
    var at = state.selection.indexOf(index);
    if (event.shiftKey && state.selection.length) {
      var last = state.selection[state.selection.length - 1];
      var from = Math.min(last, index);
      var to = Math.max(last, index);
      for (var i = from; i <= to; i++) {
        if (state.selection.indexOf(i) < 0) state.selection.push(i);
      }
    } else if (at >= 0) {
      state.selection.splice(at, 1);
    } else {
      state.selection.push(index);
    }
    paintSelection();
  }

  function paintSelection() {
    var cells = document.querySelectorAll('#thumbs .thumb');
    for (var i = 0; i < cells.length; i++) {
      var index = Number(cells[i].dataset.index);
      cells[i].classList.toggle('sel', state.selection.indexOf(index) >= 0);
    }
  }

  /* ---------------------------------------------------------------- *
   * 分割・ページ編集
   * ---------------------------------------------------------------- */

  function splitJobs(doc) {
    var mode = document.querySelector('input[name="splitMode"]:checked').value;
    if (mode === 'ranges') {
      var indices = ops.parsePageRanges($('splitRanges').value, doc.pageCount);
      if (!indices.length) throw new Error('ページ範囲を入力してください（例: 1-3,5）');
      return [indices];
    }
    if (mode === 'every') {
      var size = parseInt($('splitEvery').value, 10);
      return ops.buildEqualChunks(doc.pageCount, size);
    }
    if (mode === 'single') {
      return ops.buildEqualChunks(doc.pageCount, 1);
    }
    if (!state.selection.length) throw new Error('抽出するページを選んでください');
    var sorted = state.selection.slice().sort(function (a, b) { return a - b; });
    return [sorted];
  }

  function splitFileName(doc, indices, n, total) {
    var template = $('splitTemplate').value || '{name}_{n}';
    var digits = String(total).length;
    var num = String(n);
    while (num.length < digits) num = '0' + num;
    var name = template
      .replace(/\{name\}/g, baseName(doc.name))
      .replace(/\{n\}/g, num)
      .replace(/\{pages\}/g, ops.formatRanges(indices).replace(/,/g, '_'))
      .replace(/\{date\}/g, todayStamp());
    return ops.sanitizeFileName(name, baseName(doc.name)) + '.pdf';
  }

  async function runSplit() {
    var doc = requireActiveDoc();
    var jobs = splitJobs(doc);
    var dir = state.splitDir;
    if (!dir) {
      dir = await window.kuro.chooseDirectory();
      if (!dir) return;
      state.splitDir = dir;
      $('splitDirLabel').textContent = dir;
    }

    var stripMeta = $('splitStripMeta').checked;
    var files = [];
    for (var i = 0; i < jobs.length; i++) {
      var bytes = await ops.extractPages(PDFLib, doc.bytes, jobs[i], { removeMetadata: stripMeta });
      files.push({ name: splitFileName(doc, jobs[i], i + 1, jobs.length), bytes: bytes });
    }
    var written = await window.kuro.writeMany({ dir: dir, files: files });
    toast(written.length + '件を保存しました');
    if (written.length) window.kuro.revealPath(written[0]);
  }

  async function rotateSelected(degrees) {
    var doc = requireActiveDoc();
    var indices = state.selection.slice();
    if (!indices.length) {
      // 選択がなければ全ページを回転する
      for (var i = 0; i < doc.pageCount; i++) indices.push(i);
    }
    doc.bytes = await ops.rotatePages(PDFLib, doc.bytes, indices, degrees);
    doc.dirty = true;
    renderFileList();
    await renderThumbs();
    await renderPreview();
    toast(indices.length + 'ページを回転しました');
  }

  async function deleteSelected() {
    var doc = requireActiveDoc();
    if (!state.selection.length) throw new Error('削除するページを選んでください');
    doc.bytes = await ops.deletePages(PDFLib, doc.bytes, state.selection.slice());
    doc.pageCount -= state.selection.length;
    doc.dirty = true;
    state.selection = [];
    renderFileList();
    await renderThumbs();
    await renderPreview();
    toast('選択ページを削除しました（保存するまで元ファイルは変わりません）');
  }

  async function saveActiveAs() {
    var doc = requireActiveDoc();
    var saved = await window.kuro.savePdfAs({
      bytes: doc.bytes,
      defaultPath: doc.dir ? doc.dir + '/' + baseName(doc.name) + '_編集.pdf' : baseName(doc.name) + '_編集.pdf',
    });
    if (!saved) return;
    doc.dirty = false;
    renderFileList();
    toast('保存しました: ' + saved);
  }

  /* ---------------------------------------------------------------- *
   * 結合
   * ---------------------------------------------------------------- */

  function addMergeItem(doc) {
    state.merge.push({ id: ++seq, docId: doc.id, name: doc.name, pages: '', pageCount: doc.pageCount });
  }

  function renderMergeList() {
    var list = $('mergeList');
    list.innerHTML = '';
    if (!state.merge.length) {
      list.innerHTML = '<p class="empty">PDFを追加してください</p>';
      return;
    }
    state.merge.forEach(function (item, index) {
      var row = document.createElement('div');
      row.className = 'merge-row';
      row.draggable = true;
      row.dataset.index = String(index);

      var grip = document.createElement('span');
      grip.className = 'grip';
      grip.textContent = '≡';

      var name = document.createElement('span');
      name.className = 'mname';
      name.textContent = (index + 1) + '. ' + item.name;

      var pages = document.createElement('input');
      pages.className = 'input mpages';
      pages.placeholder = '全ページ';
      pages.value = item.pages;
      pages.addEventListener('change', function () { item.pages = pages.value; });

      var meta = document.createElement('span');
      meta.className = 'mmeta';
      meta.textContent = item.pageCount + 'p';

      var close = document.createElement('button');
      close.className = 'fx';
      close.textContent = '×';
      close.addEventListener('click', function () {
        state.merge.splice(index, 1);
        renderMergeList();
      });

      row.appendChild(grip);
      row.appendChild(name);
      row.appendChild(pages);
      row.appendChild(meta);
      row.appendChild(close);

      row.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', String(index));
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', function (e) {
        e.preventDefault();
        row.classList.add('dragover');
      });
      row.addEventListener('dragleave', function () { row.classList.remove('dragover'); });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('dragover');
        var from = Number(e.dataTransfer.getData('text/plain'));
        if (Number.isNaN(from) || from === index) return;
        var moved = state.merge.splice(from, 1)[0];
        state.merge.splice(index, 0, moved);
        renderMergeList();
      });

      list.appendChild(row);
    });
  }

  async function runMerge() {
    if (state.merge.length < 2) throw new Error('結合するPDFを2つ以上追加してください');
    var inputs = [];
    for (var i = 0; i < state.merge.length; i++) {
      var item = state.merge[i];
      var doc = state.docs.filter(function (d) { return d.id === item.docId; })[0];
      if (!doc) continue;
      var indices = item.pages ? ops.parsePageRanges(item.pages, doc.pageCount) : [];
      inputs.push({ bytes: doc.bytes, indices: indices });
    }
    var merged = await ops.mergePdfs(PDFLib, inputs, { removeMetadata: $('mergeStripMeta').checked });
    var first = state.docs.filter(function (d) { return d.id === state.merge[0].docId; })[0];
    var defaultPath = (first && first.dir ? first.dir + '/' : '') + todayStamp() + '_結合.pdf';
    var saved = await window.kuro.savePdfAs({ bytes: merged, defaultPath: defaultPath });
    if (saved) toast('結合して保存しました: ' + saved);
  }

  /* ---------------------------------------------------------------- *
   * リネーム
   * ---------------------------------------------------------------- */

  function renameRules() {
    return {
      find: $('renFind').value,
      replace: $('renReplace').value,
      useRegex: $('renRegex').checked,
      caseSensitive: $('renCase').checked,
      template: $('renTemplate').value || '{base}',
      start: Number($('renStart').value) || 1,
      step: Number($('renStep').value) || 1,
      digits: Number($('renDigits').value) || 3,
      extCase: $('renExtCase').value,
      dateSource: $('renDateSource').value,
    };
  }

  var STATUS_LABEL = {
    ok: '変更',
    unchanged: '変更なし',
    conflict: '重複',
    exists: '既存と衝突',
    error: 'エラー',
  };

  async function refreshRenamePlan() {
    var body = $('renameTable').querySelector('tbody');
    body.innerHTML = '';
    if (!state.renameFiles.length) {
      $('renameSummary').textContent = 'ファイルを追加すると変更後の名前がここに出ます';
      state.renamePlan = null;
      return;
    }
    var plan = await window.kuro.renamePlan({ files: state.renameFiles, rules: renameRules() });
    state.renamePlan = plan;

    plan.entries.forEach(function (entry) {
      var tr = document.createElement('tr');
      var status = document.createElement('td');
      status.innerHTML = '<span class="badge ' + entry.status + '">' + STATUS_LABEL[entry.status] + '</span>';
      var from = document.createElement('td');
      from.textContent = entry.fromName;
      var to = document.createElement('td');
      to.textContent = entry.toName;
      var note = document.createElement('td');
      note.textContent = entry.message || '';
      tr.appendChild(status);
      tr.appendChild(from);
      tr.appendChild(to);
      tr.appendChild(note);
      body.appendChild(tr);
    });

    $('renameSummary').textContent =
      state.renameFiles.length + '件中 ' + plan.changedCount + '件を変更' +
      (plan.hasBlocking ? ' / 問題のある行があります（その行は実行されません）' : '');
  }

  async function runRename() {
    if (!state.renamePlan) throw new Error('先にファイルを追加してください');
    if (!state.renamePlan.changedCount) throw new Error('変更される名前がありません');
    var result = await window.kuro.renameApply(state.renamePlan.entries);
    state.lastUndo = result.undo;
    $('btnRenameUndo').disabled = !result.undo.length;
    state.renameFiles = result.results.map(function (r) { return { path: r.to }; });
    await refreshRenamePlan();
    toast(result.renamed + '件をリネームしました');
  }

  async function undoRename() {
    if (!state.lastUndo || !state.lastUndo.length) return;
    var restored = await window.kuro.renameUndo(state.lastUndo);
    state.renameFiles = state.lastUndo.map(function (r) { return { path: r.to }; });
    state.lastUndo = null;
    $('btnRenameUndo').disabled = true;
    await refreshRenamePlan();
    toast(restored + '件を元に戻しました');
  }

  /* ---------------------------------------------------------------- *
   * 電子署名
   * ---------------------------------------------------------------- */

  async function pickCertificate() {
    var file = await window.kuro.openCertificate();
    if (!file) return;
    state.cert = { path: file.path, name: file.name, bytes: new Uint8Array(file.bytes), info: null };
    $('certPath').textContent = file.path;
    $('certInfo').className = 'cert-info';
    $('certInfo').innerHTML = '';
  }

  async function checkCertificate() {
    if (!state.cert) throw new Error('先に電子証明書を選んでください');
    var info = await window.kuro.certificateInfo({
      p12Bytes: state.cert.bytes,
      passphrase: $('certPass').value,
    });
    state.cert.info = info;
    var warn = info.expired
      ? '<span class="cert-warn">有効期限切れ</span>'
      : (info.daysLeft < 60 ? '<span class="cert-warn">残り' + info.daysLeft + '日</span>' : '残り' + info.daysLeft + '日');
    $('certInfo').className = 'cert-info show';
    $('certInfo').innerHTML =
      '<div><b>' + escapeHtml(info.subjectCommonName || '(名前なし)') + '</b>' +
      (info.subjectOrganization ? ' / ' + escapeHtml(info.subjectOrganization) : '') + '</div>' +
      '<div>発行者: ' + escapeHtml(info.issuerCommonName || info.issuerOrganization || '不明') + '</div>' +
      '<div>有効期間: ' + info.validFrom.slice(0, 10) + ' 〜 ' + info.validTo.slice(0, 10) + '（' + warn + '）</div>' +
      '<div>シリアル: ' + escapeHtml(info.serialNumber) + '</div>';
    if (!$('signName').value && info.subjectCommonName) $('signName').value = info.subjectCommonName;
    toast('証明書を読み込みました');
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function pickStamp() {
    var file = await window.kuro.openImage();
    if (!file) return;
    var bytes = new Uint8Array(file.bytes);
    var blob = new Blob([bytes], { type: /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg' });
    var url = URL.createObjectURL(blob);
    var image = new Image();
    await new Promise(function (resolve, reject) {
      image.onload = resolve;
      image.onerror = function () { reject(new Error('画像を読み込めません')); };
      image.src = url;
    });
    state.stamp = {
      path: file.path,
      name: file.name,
      bytes: bytes,
      aspect: image.height / image.width,
      x: null,
      y: null,
    };
    URL.revokeObjectURL(url);
    $('stampPath').textContent = file.path;
    toast('プレビューをクリックして貼り付け位置を決めてください');
  }

  async function renderPreview() {
    var canvas = $('previewCanvas');
    var doc = activeDoc();
    var context = canvas.getContext('2d');
    $('stampBox').hidden = true;
    if (!doc) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    var pageNumber = Math.min(Math.max(1, parseInt($('stampPage').value, 10) || 1), doc.pageCount);
    state.previewPage = pageNumber - 1;
    var pdf = await pdfjsLib.getDocument({ data: doc.bytes.slice() }).promise;
    var page = await pdf.getPage(pageNumber);
    var base = page.getViewport({ scale: 1 });
    var scale = Math.min(1.6, 720 / base.width);
    var viewport = page.getViewport({ scale: scale });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    context.clearRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    state.previewSize = { width: base.width, height: base.height };
    pdf.destroy();
    drawStampBox();
  }

  function drawStampBox() {
    var box = $('stampBox');
    var canvas = $('previewCanvas');
    if (!state.stamp || state.stamp.x == null || !state.previewSize) {
      box.hidden = true;
      $('stampPosLabel').textContent = '';
      return;
    }
    var widthPt = Number($('stampWidth').value) || 80;
    var heightPt = widthPt * state.stamp.aspect;
    var rect = canvas.getBoundingClientRect();
    var ratio = rect.width / state.previewSize.width;

    box.hidden = false;
    box.style.width = widthPt * ratio + 'px';
    box.style.height = heightPt * ratio + 'px';
    box.style.left = state.stamp.x * ratio + 'px';
    box.style.top = (state.previewSize.height - state.stamp.y - heightPt) * ratio + 'px';
    $('stampPosLabel').textContent =
      '印影位置 x=' + Math.round(state.stamp.x) + ' y=' + Math.round(state.stamp.y) +
      ' / 幅' + Math.round(widthPt) + 'pt';
  }

  function onPreviewClick(event) {
    if (!state.stamp) { toast('先に印影・サイン画像を選んでください', true); return; }
    if (!state.previewSize) return;
    var canvas = $('previewCanvas');
    var rect = canvas.getBoundingClientRect();
    var ratio = state.previewSize.width / rect.width;
    var widthPt = Number($('stampWidth').value) || 80;
    var heightPt = widthPt * state.stamp.aspect;
    var cx = (event.clientX - rect.left) * ratio;
    var cy = state.previewSize.height - (event.clientY - rect.top) * ratio;
    state.stamp.x = Math.max(0, Math.min(state.previewSize.width - widthPt, cx - widthPt / 2));
    state.stamp.y = Math.max(0, Math.min(state.previewSize.height - heightPt, cy - heightPt / 2));
    drawStampBox();
  }

  async function runSign() {
    var doc = requireActiveDoc();
    if (!state.cert) throw new Error('電子証明書を選んでください');
    var passphrase = $('certPass').value;

    var bytes = doc.bytes;
    var widgetRect = null;
    var stampPage = Math.min(Math.max(1, parseInt($('stampPage').value, 10) || 1), doc.pageCount);

    if (state.stamp) {
      if (state.stamp.x == null) throw new Error('プレビューをクリックして印影の位置を決めてください');
      var widthPt = Number($('stampWidth').value) || 80;
      var heightPt = widthPt * state.stamp.aspect;
      bytes = await ops.stampImage(PDFLib, bytes, {
        pageIndex: stampPage - 1,
        imageBytes: state.stamp.bytes,
        x: state.stamp.x,
        y: state.stamp.y,
        width: widthPt,
        opacity: Number($('stampOpacity').value) || 1,
      });
      if ($('stampAsWidget').checked && stampPage === 1) {
        widgetRect = [state.stamp.x, state.stamp.y, state.stamp.x + widthPt, state.stamp.y + heightPt];
      }
    }

    var result = await window.kuro.signPdf({
      pdfBytes: bytes,
      p12Bytes: state.cert.bytes,
      passphrase: passphrase,
      name: $('signName').value,
      reason: $('signReason').value,
      location: $('signLocation').value,
      contactInfo: $('signContact').value,
      widgetRect: widgetRect,
    });

    var signedBytes = new Uint8Array(result.bytes);
    var defaultPath =
      (doc.dir ? doc.dir + '/' : '') + baseName(doc.name) + '_署名済.pdf';
    var saved = await window.kuro.savePdfAs({ bytes: signedBytes, defaultPath: defaultPath });
    if (!saved) return;

    renderSignatures(await window.kuro.inspectSignatures(signedBytes), saved);
    toast('署名して保存しました: ' + saved);
  }

  async function runVerify() {
    var doc = requireActiveDoc();
    var signatures = await window.kuro.inspectSignatures(doc.bytes);
    renderSignatures(signatures, doc.name);
    if (!signatures.length) toast('この文書に電子署名は見つかりませんでした');
  }

  function renderSignatures(signatures, sourceLabel) {
    var box = $('sigResult');
    box.innerHTML = '';
    if (!signatures.length) {
      box.innerHTML = '<p class="empty">電子署名は見つかりませんでした（' + escapeHtml(sourceLabel || '') + '）</p>';
      return;
    }
    signatures.forEach(function (sig) {
      var card = document.createElement('div');
      card.className = 'sig-card ' + sig.integrity;
      var cert = sig.certificate || {};
      var verdict =
        sig.integrity === 'valid'
          ? '内容は署名時から変更されていません'
          : sig.integrity === 'invalid'
            ? '検証に失敗しました'
            : '署名を解析できませんでした';
      card.innerHTML =
        '<div><b>署名 ' + sig.index + '：' + verdict + '</b></div>' +
        '<div>署名者: ' + escapeHtml(cert.subjectCommonName || '不明') +
        (cert.subjectOrganization ? ' / ' + escapeHtml(cert.subjectOrganization) : '') + '</div>' +
        '<div>発行者: ' + escapeHtml(cert.issuerCommonName || cert.issuerOrganization || '不明') + '</div>' +
        (sig.signedAt ? '<div>署名日時: ' + escapeHtml(sig.signedAt.replace('T', ' ').slice(0, 19)) + '</div>' : '') +
        '<div>署名の対象: ' + (sig.coversWholeDocument ? '文書全体' : '文書の一部（署名後に追記があります）') + '</div>' +
        (sig.errors.length ? '<div class="cert-warn">' + escapeHtml(sig.errors.join(' / ')) + '</div>' : '') +
        '<div class="hint">※認証局の失効確認（CRL/OCSP）やタイムスタンプの検証は行っていません。</div>';
      box.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------- *
   * 提出前の点検
   * ---------------------------------------------------------------- */

  var LEVEL_LABEL = { ok: '問題なし', warn: '要確認', error: '要修正', info: '情報' };

  async function runPreflight() {
    var doc = requireActiveDoc();
    var report = await window.kuro.preflight(doc.bytes);
    renderPreflight(doc, report);

    var verdict = report.summary.verdict;
    toast(
      verdict === 'ok'
        ? '点検しました。問題は見つかりませんでした'
        : '点検しました。要修正' + report.summary.errors + '件 / 要確認' + report.summary.warnings + '件',
      verdict === 'error'
    );
  }

  function renderPreflight(doc, report) {
    var box = $('preflightReport');
    box.innerHTML = '';

    $('preflightDocName').textContent =
      doc.name + '（' + report.summary.pageCount + 'ページ' + (doc.dirty ? ' / 未保存の編集あり' : '') + '）';
    $('preflightSummary').textContent =
      report.summary.fileSizeText + ' / PDF ' + report.summary.pdfVersion + ' / フォント' + report.summary.fontCount + '種類';

    var verdict = document.createElement('div');
    verdict.className = 'verdict ' + report.summary.verdict;
    verdict.innerHTML =
      '<span>' +
      (report.summary.verdict === 'ok'
        ? 'このまま提出できる状態です'
        : report.summary.verdict === 'error'
          ? '修正が必要な項目があります'
          : '確認したほうがよい項目があります') +
      '</span><span class="meta">要修正 ' + report.summary.errors + '件 / 要確認 ' + report.summary.warnings + '件</span>';
    box.appendChild(verdict);

    report.checks.forEach(function (check) {
      var card = document.createElement('div');
      card.className = 'chk-card ' + check.level;

      var mark = document.createElement('span');
      mark.className = 'chk-mark ' + check.level;
      mark.textContent = LEVEL_LABEL[check.level] || check.level;

      var body = document.createElement('div');
      body.className = 'chk-body';
      var title = document.createElement('b');
      title.textContent = check.label;
      body.appendChild(title);
      body.appendChild(document.createTextNode(check.detail));

      if (check.items && check.items.length) {
        var list = document.createElement('ul');
        list.className = 'chk-items';
        check.items.forEach(function (item) {
          var li = document.createElement('li');
          li.textContent = item;
          list.appendChild(li);
        });
        body.appendChild(list);
      }

      card.appendChild(mark);
      card.appendChild(body);
      box.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------- *
   * 初期化
   * ---------------------------------------------------------------- */

  function switchTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].dataset.tab === name);
    var panes = document.querySelectorAll('.pane');
    for (var j = 0; j < panes.length; j++) panes[j].classList.toggle('active', panes[j].id === 'pane-' + name);
    if (name === 'sign') renderPreview();
    if (name === 'preflight') {
      var doc = activeDoc();
      $('preflightDocName').textContent = doc ? doc.name : 'ファイル未選択';
    }
  }

  function wire() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) { switchTab(e.currentTarget.dataset.tab); });
    }

    $('btnOpen').addEventListener('click', openPdfDialog);
    $('btnOpen2').addEventListener('click', openPdfDialog);
    $('btnMergeAdd').addEventListener('click', openPdfDialog);

    $('btnDefaultApp').addEventListener('click', async function () {
      var result = await window.kuro.openDefaultAppSettings();
      toast(result.guide);
    });

    $('btnSplitDir').addEventListener('click', async function () {
      var dir = await window.kuro.chooseDirectory();
      if (!dir) return;
      state.splitDir = dir;
      $('splitDirLabel').textContent = dir;
    });
    $('btnSplitRun').addEventListener('click', function () { run('分割しています...', runSplit); });
    $('btnRotateLeft').addEventListener('click', function () { run('回転しています...', function () { return rotateSelected(-90); }); });
    $('btnRotateRight').addEventListener('click', function () { run('回転しています...', function () { return rotateSelected(90); }); });
    $('btnDeletePages').addEventListener('click', function () { run('削除しています...', deleteSelected); });
    $('btnSaveEdited').addEventListener('click', function () { run('保存しています...', saveActiveAs); });
    $('btnSelectAll').addEventListener('click', function () {
      var doc = activeDoc();
      if (!doc) return;
      state.selection = [];
      for (var i = 0; i < doc.pageCount; i++) state.selection.push(i);
      paintSelection();
    });
    $('btnSelectNone').addEventListener('click', function () { state.selection = []; paintSelection(); });

    $('btnMergeRun').addEventListener('click', function () { run('結合しています...', runMerge); });

    $('btnRenameAdd').addEventListener('click', function () {
      run('読み込んでいます...', async function () {
        var files = await window.kuro.openAnyFiles();
        if (!files.length) return;
        state.renameFiles = state.renameFiles.concat(files);
        await refreshRenamePlan();
      });
    });
    $('btnRenameClear').addEventListener('click', function () {
      state.renameFiles = [];
      refreshRenamePlan();
    });
    $('btnRenameRun').addEventListener('click', function () { run('リネームしています...', runRename); });
    $('btnRenameUndo').addEventListener('click', function () { run('元に戻しています...', undoRename); });
    ['renFind', 'renReplace', 'renTemplate', 'renStart', 'renStep', 'renDigits'].forEach(function (id) {
      $(id).addEventListener('input', function () { refreshRenamePlan(); });
    });
    ['renRegex', 'renCase', 'renExtCase', 'renDateSource'].forEach(function (id) {
      $(id).addEventListener('change', function () { refreshRenamePlan(); });
    });

    $('btnPickCert').addEventListener('click', function () { run('証明書を読み込んでいます...', pickCertificate); });
    $('btnCertCheck').addEventListener('click', function () { run('証明書を確認しています...', checkCertificate); });
    $('btnPickStamp').addEventListener('click', function () { run('画像を読み込んでいます...', pickStamp); });
    $('btnSignRun').addEventListener('click', function () { run('署名しています...', runSign); });
    $('btnVerify').addEventListener('click', function () { run('検証しています...', runVerify); });
    $('btnPreflight').addEventListener('click', function () { run('点検しています...', runPreflight); });
    $('btnPreflightOpen').addEventListener('click', function () {
      run('読み込んで点検しています...', async function () {
        var files = await window.kuro.openPdfs();
        if (!files.length) return;
        await addDocs(files);
        await runPreflight();
      });
    });
    $('stampPage').addEventListener('change', function () { run('表示を更新しています...', renderPreview); });
    $('stampWidth').addEventListener('input', drawStampBox);
    $('previewStage').addEventListener('click', onPreviewClick);
    window.addEventListener('resize', drawStampBox);

    // ドラッグ＆ドロップ
    window.addEventListener('dragover', function (e) {
      e.preventDefault();
      $('dropHint').hidden = false;
    });
    window.addEventListener('dragleave', function (e) {
      if (e.relatedTarget) return;
      $('dropHint').hidden = true;
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      $('dropHint').hidden = true;
      var dropped = Array.prototype.slice.call(e.dataTransfer.files || []);
      var paths = dropped
        .map(function (file) { return window.kuro.pathForFile(file); })
        .filter(function (p) { return p && /\.pdf$/i.test(p); });
      if (paths.length) openPdfPaths(paths);
    });

    window.kuro.onOpenFiles(function (files) { openPdfPaths(files); });
    window.kuro.onMenuCommand(function (command) {
      if (command === 'open') openPdfDialog();
      if (command === 'save') run('保存しています...', saveActiveAs);
    });
  }

  window.kuro.info().then(function (info) {
    $('verBadge').textContent = 'v' + info.version;
  });

  wire();
})();
