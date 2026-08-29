'use strict';

/**
 * Celar Chat — Electron main process.
 *
 * Owns the window, the IPC surface, and the ChatService (which wraps
 * @bdxi/bchat-sdk). The renderer never touches Node: everything crosses
 * the contextBridge in preload.js as plain JSON.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { ChatService } = require('./sdk-service');

// Note: on Wayland sessions Chromium logs a one-line spurious error at GPU
// init ("'--ozone-platform=wayland' is not compatible with Vulkan"). It is
// cosmetic — the GPU process falls back to GL and renders normally. Forcing
// X11 to silence it segfaults the GPU process on some Mesa drivers, so we
// deliberately stay on the platform default and live with the log line.

let win = null;
const service = new ChatService();

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0d0a07',
    title: 'Celar Chat',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Message content must never be able to navigate the window or spawn one.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());

  win.on('closed', () => {
    win = null;
  });
}

/** Uniform IPC envelope so the renderer gets errors as data, not exceptions. */
function wrap(fn) {
  return async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  };
}

function registerIpc() {
  ipcMain.handle('state:get', wrap(() => service.getState()));
  ipcMain.handle('identity:create', wrap(opts => service.createIdentity(opts)));
  ipcMain.handle('identity:restore', wrap(opts => service.restoreIdentity(opts)));
  ipcMain.handle('identity:reveal', wrap(() => service.revealMnemonic()));
  ipcMain.handle('sdk:connect', wrap(() => service.connect()));
  ipcMain.handle('conversations:add', wrap(input => service.addConversation(input)));
  ipcMain.handle('conversations:remove', wrap(id => service.removeConversation(id)));
  ipcMain.handle('messages:list', wrap(peerId => service.listMessages(peerId)));
  ipcMain.handle('messages:send', wrap(p => service.sendMessage(p.peerId, p.text, p.replyToId, p.preview)));
  ipcMain.handle('messages:react', wrap(p => service.react(p.peerId, p.messageId, p.emoji)));
  ipcMain.handle('messages:retry', wrap(p => service.retrySend(p.peerId, p.messageId)));
  ipcMain.handle('preview:fetch', wrap(url => service.fetchPreview(url)));
  ipcMain.handle('messages:unfurl', wrap(p => service.unfurlIncoming(p.peerId, p.messageId)));
  ipcMain.handle('settings:set', wrap(partial => service.setSettings(partial)));
  ipcMain.handle('displayName:set', wrap(name => service.setDisplayName(name)));
  ipcMain.handle('messages:sendAttachment', wrap(p => service.sendAttachment(p.peerId, p.file, p.caption)));
  ipcMain.handle('attachment:save', wrap(async p => {
    const data = service.getAttachmentData(p.peerId, p.messageId);
    const result = await dialog.showSaveDialog(win, { defaultPath: data.fileName });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, Buffer.from(data.dataB64, 'base64'));
    return result.filePath;
  }));
  ipcMain.handle('shell:open', wrap(url => {
    const parsed = new URL(String(url)); // throws on malformed input
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only http(s) links can be opened.');
    }
    shell.openExternal(parsed.toString());
    return true;
  }));
}

app.whenReady().then(() => {
  service.init(app.getPath('userData'), event => {
    if (win && !win.isDestroyed()) win.webContents.send('chat:event', event);
  });
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  service.shutdown();
});
