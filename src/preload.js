const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openFolderInExplorer: (p) => ipcRenderer.invoke('shell:openFolder', p),
  startExtract: (opts) => ipcRenderer.invoke('extract:start', opts),
  onProgress: (cb) => {
    ipcRenderer.on('extract:progress', (_, data) => cb(data));
  },
  removeProgressListener: () => {
    ipcRenderer.removeAllListeners('extract:progress');
  },
});
