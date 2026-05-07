const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose:    () => ipcRenderer.invoke('window:close'),
  openFile:            () => ipcRenderer.invoke('dialog:openFile'),
  openFolder:          () => ipcRenderer.invoke('dialog:openFolder'),
  openScanFolder:      () => ipcRenderer.invoke('dialog:openScanFolder'),
  openImageFile:       () => ipcRenderer.invoke('dialog:openImageFile'),
  openFolderInExplorer: p => ipcRenderer.invoke('shell:openFolder', p),
  openExternal:        url => ipcRenderer.invoke('shell:openExternal', url),
  openPath:            p => ipcRenderer.invoke('shell:openPath', p),
  startExtract:           opts => ipcRenderer.invoke('extract:start', opts),
  onProgress:             cb => ipcRenderer.on('extract:progress', (_, d) => cb(d)),
  removeProgressListener: () => ipcRenderer.removeAllListeners('extract:progress'),
  resamplePreview: p => ipcRenderer.invoke('resample:preview', p),
  resampleSave:    p => ipcRenderer.invoke('resample:save', p),
  phashScan:           opts => ipcRenderer.invoke('phash:scan', opts),
  onScanProgress:      cb => ipcRenderer.on('phash:scan-progress', (_, d) => cb(d)),
  onScanTotal:         cb => ipcRenderer.on('phash:scan-total', (_, d) => cb(d)),
  removeScanListeners: () => { ipcRenderer.removeAllListeners('phash:scan-progress'); ipcRenderer.removeAllListeners('phash:scan-total'); },
});
