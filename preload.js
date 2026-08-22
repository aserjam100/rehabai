const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rehabAPI', {
  generateReport: (formattedSummary, lang) => ipcRenderer.invoke('generate-report', formattedSummary, lang),
  generateGreeting: (factsText, lang) => ipcRenderer.invoke('generate-greeting', factsText, lang),
  generateProgressSummary: (factsText, lang) => ipcRenderer.invoke('generate-progress-summary', factsText, lang),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  resetConfig: () => ipcRenderer.invoke('reset-config'),
  goHome: () => ipcRenderer.invoke('go-home'),
  onBootStatus: (callback) => ipcRenderer.on('boot-status', (event, status) => callback(status)),
  awaitBoot: () => ipcRenderer.invoke('await-boot'),
});
