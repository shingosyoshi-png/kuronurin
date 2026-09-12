/*
 * 起動＆操作のスモークテスト。`npm run smoke` で実行する（画面が必要。Linuxでは xvfb-run 経由）。
 * 本物のメインプロセスを起動し、ファイル選択ダイアログだけを差し替えて
 * 「開く → 分割 → 回転 → 結合 → 署名」を実際に流す。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, dialog, shell } = require('electron');

// ヘッドレス環境（xvfb）で描画できるようにGPUを使わない
app.disableHardwareAcceleration();

const messages = [];
const outDir = process.env.KURO_SMOKE_OUT || path.join(__dirname, '..', '.smoke');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuronurin-smoke-'));
const inputPdf = path.join(workDir, 'smoke.pdf');
const certPath = path.join(workDir, 'smoke.p12');
const CERT_PASS = 'smoke-pass';

/* ダイアログを差し替える（メインプロセスのIPCはそのまま動かす） */
dialog.showOpenDialog = async (_win, options) => {
  const filters = options.filters || [];
  if ((options.properties || []).includes('openDirectory')) {
    return { canceled: false, filePaths: [workDir] };
  }
  if (filters.some((f) => (f.extensions || []).includes('p12'))) {
    return { canceled: false, filePaths: [certPath] };
  }
  return { canceled: false, filePaths: [inputPdf] };
};
dialog.showSaveDialog = async (_win, options) => ({
  canceled: false,
  filePath: path.join(workDir, path.basename(options.defaultPath || 'saved.pdf')),
});
shell.showItemInFolder = () => {};

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('console-message', (event) => {
    messages.push({ level: event.level, message: event.message, source: event.lineNumber });
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    messages.push({ level: 'error', message: 'renderer gone: ' + JSON.stringify(details) });
  });
});

// 本物のメインプロセスを起動する
require('../src/main/index.js');

async function prepareFixtures() {
  const { makeTestP12, makeTestPdf } = require('./helpers.js');
  fs.writeFileSync(inputPdf, await makeTestPdf(4, 'smoke'));
  fs.writeFileSync(certPath, makeTestP12(CERT_PASS));
}

function evaluate(win, source) {
  return win.webContents.executeJavaScript(source);
}

app.whenReady().then(async () => {
  await prepareFixtures();
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const report = { ok: false, messages, checks: {} };
    try {
      if (!win) throw new Error('ウィンドウが作られませんでした');

      report.checks.boot = await evaluate(win, `(() => ({
        title: document.title,
        tabs: Array.from(document.querySelectorAll('.tab')).map((t) => t.dataset.tab).join(','),
        hasKuroApi: typeof window.kuro === 'object',
        hasPdfLib: typeof window.PDFLib === 'object',
        hasPdfJs: typeof window.pdfjsLib === 'object',
        hasOps: typeof window.KuroPdfOps === 'object',
        tabCount: document.querySelectorAll('.tab').length,
      }))()`);

      report.checks.flow = await evaluate(win, `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const $ = (id) => document.getElementById(id);

        $('btnOpen').click();
        await wait(2000);
        const opened = {
          thumbs: document.querySelectorAll('#thumbs .thumb').length,
          docName: $('splitDocName').textContent,
        };

        // 分割（1-2ページ）
        $('splitRanges').value = '1-2';
        $('btnSplitDir').click();
        await wait(800);
        $('btnSplitRun').click();
        await wait(2000);
        const afterSplit = $('toast').textContent;

        // 1ページ目を選んで右に回転
        document.querySelector('#thumbs .thumb').click();
        $('btnRotateRight').click();
        await wait(2000);
        const rotated = document.querySelectorAll('#thumbs .rot').length;

        // 結合（同じPDFをもう一度開いて2件にする）
        document.querySelector('.tab[data-tab="merge"]').click();
        $('btnOpen').click();
        await wait(2000);
        const mergeRows = document.querySelectorAll('.merge-row').length;
        $('btnMergeRun').click();
        await wait(2000);
        const afterMerge = $('toast').textContent;

        // 電子署名
        document.querySelector('.tab[data-tab="sign"]').click();
        await wait(800);
        $('btnPickCert').click();
        await wait(1200);
        $('certPass').value = '${CERT_PASS}';
        $('btnCertCheck').click();
        await wait(2000);
        const certText = $('certInfo').textContent;
        $('btnSignRun').click();
        await wait(3000);
        const signText = $('sigResult').textContent;

        // 提出前の点検
        document.querySelector('.tab[data-tab="preflight"]').click();
        await wait(500);
        $('btnPreflight').click();
        await wait(2500);
        const preflight = {
          verdictClass: (document.querySelector('#preflightReport .verdict') || {}).className || '',
          cards: document.querySelectorAll('#preflightReport .chk-card').length,
          text: $('preflightReport').textContent.slice(0, 400),
        };

        return { opened, afterSplit, rotated, mergeRows, afterMerge, certText, signText, preflight };
      })()`);

      report.checks.files = fs.readdirSync(workDir).sort();

      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'window.png'), (await win.capturePage()).toPNG());
      report.ok = true;
    } catch (err) {
      report.error = err.message;
    }

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    const failed = messages.some((m) => m.level === 'error' || m.level === 3);
    app.exit(report.ok && !failed ? 0 : 1);
  }, 3000);
});
