const { contextBridge, ipcRenderer } = require("electron");

// Renderer'a sadece gerekli, dar kapsamlı API'ler açılır.
// ipcRenderer doğrudan window'a verilmez.
contextBridge.exposeInMainWorld("electronAPI", {
  getFirebaseConfig: async () => {
    return await ipcRenderer.invoke("firebase:get-config");
  },

  closeApp: async () => {
    return await ipcRenderer.invoke("app:close");
  },
});