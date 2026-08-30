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
const { app, BrowserWindow, dialog, ipcMain, shell, Notification } = require('electron');
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

/**
 * App-level reactions to chat events: the launcher/dock unread badge, and a
 * system notification (with click-to-open) when a message arrives while the
 * window is not focused.
 */
function handleAppSideEffects(event) {
  if (event.type === 'message' || event.type === 'conversations') {
    try {
      app.setBadgeCount(service.getUnreadTotal());
    } catch {
      /* not every desktop shell supports badges */
    }
  }

  if (
    event.type === 'message' &&
    event.record &&
    event.record.direction === 'in' &&
    event.record.kind === 'text' &&
    win &&
    !win.isDestroyed() &&
    !win.isFocused() &&
    Notification.isSupported()
  ) {
    const name =
      (event.conversation && event.conversation.name) || `${event.peerId.slice(0, 8)}…`;
    const body =
      (event.record.text && event.record.text.slice(0, 120)) ||
      (event.record.attachment ? `📎 ${event.record.attachment.fileName}` : 'New message');

    const notification = new Notification({ title: `Celar Chat — ${name}`, body });
    notification.on('click', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('chat:event', { type: 'focus-conversation', peerId: event.peerId });
    });
    notification.show();
    win.flashFrame(true); // taskbar/urgency hint; clears on focus
  }
}

/**
 * Auto-update via GitHub Releases (electron-updater supports deb since v6.3:
 * it downloads the new package and installs through pkexec on restart).
 * Active only in packaged builds — `npm start` never checks.
 */
function initAutoUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return; // dependency not installed; run without updates
  }

  const tell = (text, error) => {
    if (win && !win.isDestroyed()) win.webContents.send('chat:event', { type: 'toast', text, error });
  };

  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', info => tell(`UPDATE ${info.version} — DOWNLOADING…`));
  autoUpdater.on('error', () => {}); // offline or rate-limited: try again later, silently
  autoUpdater.on('update-downloaded', async info => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: `Celar Chat ${info.version} has been downloaded.`,
      detail: 'Restart to install it. Installing a .deb update will ask for your system password.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
    else tell(`UPDATE ${info.version} READY — INSTALLS ON NEXT RESTART`);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 4 * 60 * 60 * 1000); // every 4 hours
}

app.whenReady().then(() => {
  service.init(app.getPath('userData'), event => {
    if (win && !win.isDestroyed()) win.webContents.send('chat:event', event);
    handleAppSideEffects(event);
  });
  initAutoUpdater();
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
