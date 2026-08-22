const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rehabAPI', {
  generateReport: (formattedSummary) => ipcRenderer.invoke('generate-report', formattedSummary),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  resetConfig: () => ipcRenderer.invoke('reset-config'),
  goHome: () => ipcRenderer.invoke('go-home'),
});
