const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getFirebaseConfig: async () => {
    return await ipcRenderer.invoke("firebase:get-config");
  },

  getApiBaseUrl: async () => {
    return await ipcRenderer.invoke("api:get-base-url");
  },

  closeApp: async () => {
    return await ipcRenderer.invoke("app:close");
  },
});