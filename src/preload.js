const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // window
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose:    () => ipcRenderer.invoke('window:close'),
  // dialogs
  openFile:            () => ipcRenderer.invoke('dialog:openFile'),
  openFolder:          () => ipcRenderer.invoke('dialog:openFolder'),
  openScanFolder:      () => ipcRenderer.invoke('dialog:openScanFolder'),
  openFolderInExplorer: p => ipcRenderer.invoke('shell:openFolder', p),
  openExternal:        url => ipcRenderer.invoke('shell:openExternal', url),
  openPath:            p => ipcRenderer.invoke('shell:openPath', p),
  // tab1: extract
  startExtract:           opts => ipcRenderer.invoke('extract:start', opts),
  onProgress:             cb => ipcRenderer.on('extract:progress', (_, d) => cb(d)),
  removeProgressListener: () => ipcRenderer.removeAllListeners('extract:progress'),
  // tab2: resample
  resamplePreview: p => ipcRenderer.invoke('resample:preview', p),
  resampleSave:    p => ipcRenderer.invoke('resample:save', p),
  // tab4: phash scan
  phashScan:           opts => ipcRenderer.invoke('phash:scan', opts),
  onScanProgress:      cb => ipcRenderer.on('phash:scan-progress', (_, d) => cb(d)),
  onScanTotal:         cb => ipcRenderer.on('phash:scan-total', (_, d) => cb(d)),
  removeScanListeners: () => { ipcRenderer.removeAllListeners('phash:scan-progress'); ipcRenderer.removeAllListeners('phash:scan-total'); },
});
