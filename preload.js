const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aflAPI', {
  // Data
  readData:         ()                      => ipcRenderer.invoke('data:read'),
  writeData:        (data)                  => ipcRenderer.invoke('data:write', data),
  // Dialogs / Excel
  openExcel:        ()                      => ipcRenderer.invoke('dialog:openExcel'),
  parseExcel:       (filePath)              => ipcRenderer.invoke('excel:parse', filePath),
  // Documents
  uploadDoc:        ()                      => ipcRenderer.invoke('docs:upload'),
  openDoc:          (storedFileName)        => ipcRenderer.invoke('docs:open', storedFileName),
  saveAsDoc:        (storedFileName, name)  => ipcRenderer.invoke('docs:saveAs', storedFileName, name),
  deleteDocFile:    (storedFileName)        => ipcRenderer.invoke('docs:delete', storedFileName),
  getStorageInfo:   ()                      => ipcRenderer.invoke('docs:storageInfo'),
  // App lifecycle
  readyToClose:     ()                      => ipcRenderer.invoke('app:ready-to-close'),
  onBeforeClose:    (cb)                    => ipcRenderer.on('app:before-close', () => cb()),
  // System / startup
  setAutoLaunch:    (enable)               => ipcRenderer.invoke('system:set-auto-launch', enable),
  getAutoLaunch:    ()                     => ipcRenderer.invoke('system:get-auto-launch'),
  setCloseToTray:   (enable)               => ipcRenderer.invoke('system:set-close-to-tray', enable),
  exitApp:          ()                     => ipcRenderer.invoke('system:exit-app'),
  showWindow:       ()                     => ipcRenderer.invoke('system:show-window'),
  showNotification: (title, body)          => ipcRenderer.invoke('system:show-notification', title, body),
  onTrayBackup:     (cb)                   => ipcRenderer.on('tray:backup-now', () => cb()),
  // Backup
  backupWrite:      (data, opts)           => ipcRenderer.invoke('backup:write', data, opts),
  backupList:       (folder)              => ipcRenderer.invoke('backup:list', folder),
  backupRestore:    (filePath)            => ipcRenderer.invoke('backup:restore', filePath),
  backupOpenFolder: (folder)              => ipcRenderer.invoke('backup:open-folder', folder),
  backupDefaultDir: ()                    => ipcRenderer.invoke('backup:default-dir'),
  // Git
  gitCommitPush:    (message)             => ipcRenderer.invoke('git:commit-push', message),
  gitStatus:        ()                    => ipcRenderer.invoke('git:status'),
  // Lead Generation
  lgGeocode:        (p)                   => ipcRenderer.invoke('leadgen:geocode', p),
  lgMapsSearch:     (p)                   => ipcRenderer.invoke('leadgen:maps-search', p),
  lgMapsDetails:    (p)                   => ipcRenderer.invoke('leadgen:maps-details', p),
  lgTestMaps:       (key)                 => ipcRenderer.invoke('leadgen:test-maps-key', key),
  lgApolloSearch:   (p)                   => ipcRenderer.invoke('leadgen:apollo-search', p),
  lgTestApollo:     (key)                 => ipcRenderer.invoke('leadgen:test-apollo-key', key),
});
