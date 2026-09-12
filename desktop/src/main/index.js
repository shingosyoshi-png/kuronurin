/*
 * くろぬりんDesktop メインプロセス。
 * ファイル入出力・電子署名・リネームなど、OSに触る処理はすべてここで行う。
 * レンダラー（画面側）は preload 経由の window.kuro API しか使えない。
 */
'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const rename = require('./rename.js');
const sign = require('./sign.js');
const preflight = require('./preflight.js');

const isDev = process.argv.includes('--dev');
let mainWindow = null;
/** 起動時にファイル関連付けから渡されたPDF（ウィンドウ生成前に届くことがある） */
const pendingOpenFiles = [];

/* ------------------------------------------------------------------ *
 * ウィンドウ
 * ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b2320' : '#faf8f5',
    title: 'くろぬりんDesktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.webContents.on('did-finish-load', () => {
    flushPendingOpenFiles();
  });

  // 外部リンクは既定のブラウザで開く（アプリ内で開かせない）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ *
 * ファイル関連付け（既定のアプリとして開かれたとき）
 * ------------------------------------------------------------------ */

function collectPdfArgs(argv) {
  return argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-'))
    .filter((arg) => /\.pdf$/i.test(arg))
    .filter((arg) => fs.existsSync(arg))
    .map((arg) => path.resolve(arg));
}

function queueOpenFiles(filePaths) {
  filePaths.forEach((filePath) => pendingOpenFiles.push(filePath));
  flushPendingOpenFiles();
}

function flushPendingOpenFiles() {
  if (!mainWindow || !pendingOpenFiles.length) return;
  const files = pendingOpenFiles.splice(0, pendingOpenFiles.length);
  mainWindow.webContents.send('app:open-files', files);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/* ------------------------------------------------------------------ *
 * メニュー
 * ------------------------------------------------------------------ */

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: 'くろぬりんDesktopについて' },
              { type: 'separator' },
              { role: 'hide', label: '隠す' },
              { role: 'hideOthers', label: 'ほかを隠す' },
              { role: 'unhide', label: 'すべて表示' },
              { type: 'separator' },
              { role: 'quit', label: '終了' },
            ],
          },
        ]
      : []),
    {
      label: 'ファイル',
      submenu: [
        {
          label: 'PDFを開く...',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow && mainWindow.webContents.send('app:menu', 'open'),
        },
        {
          label: '名前を付けて保存...',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow && mainWindow.webContents.send('app:menu', 'save'),
        },
        { type: 'separator' },
        {
          label: 'このアプリを既定のPDFアプリにする...',
          click: () => openDefaultAppSettings(),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '閉じる' } : { role: 'quit', label: '終了' },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '取り消す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべて選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        { role: 'toggleDevTools', label: '開発者ツール' },
        { type: 'separator' },
        { role: 'resetZoom', label: '実際のサイズ' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'フルスクリーン' },
      ],
    },
    {
      label: 'ヘルプ',
      submenu: [
        {
          label: '使い方（README）',
          click: () => {
            const readme = path.join(__dirname, '..', '..', 'README.md');
            if (fs.existsSync(readme)) shell.openPath(readme);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * 既定のアプリ設定
 * ------------------------------------------------------------------ */

function openDefaultAppSettings() {
  if (process.platform === 'win32') {
    // Windows 10/11 は「既定のアプリ」設定画面をユーザーが操作する必要がある
    shell.openExternal('ms-settings:defaultapps');
    return {
      opened: true,
      guide: 'Windowsの「既定のアプリ」設定が開きます。「.pdf」を探して「くろぬりんDesktop」を選んでください。',
    };
  }
  if (process.platform === 'darwin') {
    return {
      opened: false,
      guide:
        'Finderで任意のPDFを右クリック →「情報を見る」→「このアプリケーションで開く」で「くろぬりんDesktop」を選び、「すべてを変更...」を押してください。',
    };
  }
  return {
    opened: false,
    guide: 'ターミナルで xdg-mime default kuronurin-desktop.desktop application/pdf を実行してください。',
  };
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

const PDF_FILTER = { name: 'PDFファイル', extensions: ['pdf'] };
const CERT_FILTER = { name: '電子証明書 (PKCS#12)', extensions: ['p12', 'pfx'] };
const IMAGE_FILTER = { name: '画像 (印影・サイン)', extensions: ['png', 'jpg', 'jpeg'] };

function readPdfFile(filePath) {
  const stat = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    dir: path.dirname(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('保存先のファイル名を決められませんでした: ' + target);
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    isDev,
  }));

  ipcMain.handle('dialog:openPdfs', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'PDFを開く',
      filters: [PDF_FILTER],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return result.filePaths.map(readPdfFile);
  });

  ipcMain.handle('dialog:openAnyFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'リネームするファイルを選ぶ',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => {
      const stat = fs.statSync(filePath);
      return {
        path: filePath,
        name: path.basename(filePath),
        dir: path.dirname(filePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    });
  });

  ipcMain.handle('dialog:openBinary', async (_event, kind) => {
    const filters = kind === 'certificate' ? [CERT_FILTER] : [IMAGE_FILTER];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'certificate' ? '電子証明書を選ぶ' : '印影・サイン画像を選ぶ',
      filters,
      properties: ['openFile'],
    });
    if (result.canceled) return null;
    const filePath = result.filePaths[0];
    const bytes = fs.readFileSync(filePath);
    return {
      path: filePath,
      name: path.basename(filePath),
      size: bytes.length,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '保存先フォルダを選ぶ',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('fs:readPdf', (_event, filePath) => readPdfFile(filePath));

  ipcMain.handle('fs:savePdfAs', async (_event, payload) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '名前を付けて保存',
      defaultPath: payload.defaultPath || payload.defaultName || 'output.pdf',
      filters: [PDF_FILTER],
    });
    if (result.canceled) return null;
    fs.writeFileSync(result.filePath, Buffer.from(payload.bytes));
    return result.filePath;
  });

  ipcMain.handle('fs:writeMany', (_event, payload) => {
    const dir = payload.dir;
    if (!dir || !fs.existsSync(dir)) throw new Error('保存先フォルダが見つかりません');
    const written = [];
    payload.files.forEach((file) => {
      const target =
        payload.overwrite === true
          ? path.join(dir, file.name)
          : uniquePath(path.join(dir, file.name));
      fs.writeFileSync(target, Buffer.from(file.bytes));
      written.push(target);
    });
    return written;
  });

  ipcMain.handle('fs:revealPath', (_event, target) => {
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle('fs:openPath', async (_event, target) => {
    if (!target) return '';
    return shell.openPath(target);
  });

  ipcMain.handle('rename:plan', (_event, payload) =>
    rename.buildPlan(payload.files, payload.rules)
  );
  ipcMain.handle('rename:apply', (_event, entries) => rename.applyPlan(entries));
  ipcMain.handle('rename:undo', (_event, undoList) => rename.undoRename(undoList));

  ipcMain.handle('sign:certificate', (_event, payload) =>
    sign.readCertificateInfo(Buffer.from(payload.p12Bytes), payload.passphrase)
  );

  ipcMain.handle('sign:sign', async (_event, payload) => {
    const result = await sign.signPdf({
      pdfBuffer: Buffer.from(payload.pdfBytes),
      p12Buffer: Buffer.from(payload.p12Bytes),
      passphrase: payload.passphrase,
      reason: payload.reason,
      name: payload.name,
      location: payload.location,
      contactInfo: payload.contactInfo,
      widgetRect: payload.widgetRect,
      allowExpired: payload.allowExpired,
    });
    const bytes = result.pdf;
    return {
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      certificate: result.certificate,
      signingTime: result.signingTime,
    };
  });

  ipcMain.handle('sign:inspect', (_event, pdfBytes) =>
    sign.listSignatures(Buffer.from(pdfBytes))
  );

  ipcMain.handle('preflight:inspect', (_event, pdfBytes) => preflight.inspect(Buffer.from(pdfBytes)));

  ipcMain.handle('app:defaultAppSettings', () => openDefaultAppSettings());
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    queueOpenFiles(collectPdfArgs(argv));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS: 関連付けから開かれたとき
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOpenFiles([filePath]);
  });

  app.whenReady().then(() => {
    registerIpc();
    buildMenu();
    pendingOpenFiles.push(...collectPdfArgs(process.argv));
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
