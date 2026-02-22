const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  saveSettings: (partial) => ipcRenderer.invoke('app:save-settings', partial),
  pickDownloadDirectory: () => ipcRenderer.invoke('app:pick-download-directory'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  searchLiterature: (payload) => ipcRenderer.invoke('app:search-literature', payload),
  downloadPdf: (paper) => ipcRenderer.invoke('app:download-pdf', paper),

  testZoteroConnection: (config) => ipcRenderer.invoke('zotero:test-connection', config),
  getZoteroCollections: (config) => ipcRenderer.invoke('zotero:get-collections', config),
  saveToZotero: (payload) => ipcRenderer.invoke('zotero:save-item', payload),
});
