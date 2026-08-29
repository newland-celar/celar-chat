'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).then(res => {
    if (!res || res.ok !== true) throw new Error((res && res.error) || 'IPC failure');
    return res.value;
  });

contextBridge.exposeInMainWorld('celar', {
  getState: () => invoke('state:get'),
  createIdentity: opts => invoke('identity:create', opts),
  restoreIdentity: opts => invoke('identity:restore', opts),
  revealMnemonic: () => invoke('identity:reveal'),
  connect: () => invoke('sdk:connect'),
  addConversation: input => invoke('conversations:add', input),
  removeConversation: id => invoke('conversations:remove', id),
  listMessages: peerId => invoke('messages:list', peerId),
  sendMessage: (peerId, text, replyToId, preview) => invoke('messages:send', { peerId, text, replyToId, preview }),
  fetchPreview: url => invoke('preview:fetch', url),
  unfurl: (peerId, messageId) => invoke('messages:unfurl', { peerId, messageId }),
  setSettings: partial => invoke('settings:set', partial),
  setDisplayName: name => invoke('displayName:set', name),
  sendAttachment: (peerId, file, caption) => invoke('messages:sendAttachment', { peerId, file, caption }),
  saveAttachment: (peerId, messageId) => invoke('attachment:save', { peerId, messageId }),
  react: (peerId, messageId, emoji) => invoke('messages:react', { peerId, messageId, emoji }),
  openExternal: url => invoke('shell:open', url),
  retry: (peerId, messageId) => invoke('messages:retry', { peerId, messageId }),
  onEvent: handler => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
});
