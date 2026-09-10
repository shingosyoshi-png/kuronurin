/*
 * レンダラーに公開するAPI。
 * 画面側からはここに並んだ関数しか呼べない（Node API はそのまま渡さない）。
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kuro', {
  info: () => ipcRenderer.invoke('app:info'),

  // ファイルを開く / 保存する
  openPdfs: () => ipcRenderer.invoke('dialog:openPdfs'),
  openAnyFiles: () => ipcRenderer.invoke('dialog:openAnyFiles'),
  openCertificate: () => ipcRenderer.invoke('dialog:openBinary', 'certificate'),
  openImage: () => ipcRenderer.invoke('dialog:openBinary', 'image'),
  chooseDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  readPdf: (filePath) => ipcRenderer.invoke('fs:readPdf', filePath),
  savePdfAs: (payload) => ipcRenderer.invoke('fs:savePdfAs', payload),
  writeMany: (payload) => ipcRenderer.invoke('fs:writeMany', payload),
  revealPath: (target) => ipcRenderer.invoke('fs:revealPath', target),
  openPath: (target) => ipcRenderer.invoke('fs:openPath', target),

  // リネーム
  renamePlan: (payload) => ipcRenderer.invoke('rename:plan', payload),
  renameApply: (entries) => ipcRenderer.invoke('rename:apply', entries),
  renameUndo: (undoList) => ipcRenderer.invoke('rename:undo', undoList),

  // 電子署名
  certificateInfo: (payload) => ipcRenderer.invoke('sign:certificate', payload),
  signPdf: (payload) => ipcRenderer.invoke('sign:sign', payload),
  inspectSignatures: (pdfBytes) => ipcRenderer.invoke('sign:inspect', pdfBytes),

  // 既定のアプリ設定
  openDefaultAppSettings: () => ipcRenderer.invoke('app:defaultAppSettings'),

  // ドラッグ＆ドロップされた File から実ファイルパスを得る
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (_) {
      return '';
    }
  },

  // メインプロセスからの通知
  onOpenFiles: (callback) => {
    ipcRenderer.on('app:open-files', (_event, files) => callback(files));
  },
  onMenuCommand: (callback) => {
    ipcRenderer.on('app:menu', (_event, command) => callback(command));
  },
});
