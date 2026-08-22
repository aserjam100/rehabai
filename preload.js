const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rehabAPI', {
  generateReport: (formattedSummary) => ipcRenderer.invoke('generate-report', formattedSummary),
});
