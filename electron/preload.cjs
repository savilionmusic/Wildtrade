const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wildtrade', {
  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  // Bot control
  startBot: () => ipcRenderer.invoke('bot:start'),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  getBotStatus: () => ipcRenderer.invoke('bot:status'),
  getBotLogs: () => ipcRenderer.invoke('bot:logs'),

  // Events from main
  onBotLog: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('bot:log', handler);
    return () => ipcRenderer.removeListener('bot:log', handler);
  },
  onBotStatus: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('bot:status', handler);
    return () => ipcRenderer.removeListener('bot:status', handler);
  },
  onBotError: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('bot:error', handler);
    return () => ipcRenderer.removeListener('bot:error', handler);
  },
  onBotMessage: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('bot:message', handler);
    return () => ipcRenderer.removeListener('bot:message', handler);
  },
});
