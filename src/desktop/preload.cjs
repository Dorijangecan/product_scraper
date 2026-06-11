const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("productScraperDesktop", {
  pickFiles(options) {
    return ipcRenderer.invoke("desktop:open-files", options);
  },
  rememberFileFolder(kind, file) {
    const filePath = webUtils.getPathForFile(file);
    if (!filePath) return Promise.resolve(false);
    return ipcRenderer.invoke("desktop:remember-file-folder", { kind, filePath });
  }
});
