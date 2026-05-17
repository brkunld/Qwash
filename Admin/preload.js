const { contextBridge, ipcRenderer } = require("electron");
const firebaseConfig = require("./firebase-config");

contextBridge.exposeInMainWorld("electronAPI", {
  getFirebaseConfig: () => firebaseConfig,
  closeApp: () => ipcRenderer.send("close-app")
});