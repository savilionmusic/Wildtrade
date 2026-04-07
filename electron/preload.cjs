const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('wildtrade', {
  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  // Bot control
  startBot: () => ipcRenderer.invoke('bot:start'),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  getBotStatus: () => ipcRenderer.invoke('bot:status'),
  getBotLogs: () => ipcRenderer.invoke('bot:logs'),

  // Open URLs in system browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

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
  onTradeUpdate: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('bot:trade-update', handler);
    return () => ipcRenderer.removeListener('bot:trade-update', handler);
  },

  // AI Chat
  chatSend: (message) => ipcRenderer.invoke('chat:send', message),
  chatClear: () => ipcRenderer.invoke('chat:clear'),

  // Portfolio
  getPortfolio: () => ipcRenderer.invoke('portfolio:get'),

  // Runtime config
  setConfig: (key, value) => ipcRenderer.invoke('config:set-runtime', key, value),
  resetPortfolio: () => ipcRenderer.invoke('portfolio:reset'),
});
