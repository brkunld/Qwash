const { contextBridge } = require("electron");
const firebaseConfig = require("./firebase-config");

contextBridge.exposeInMainWorld("electronAPI", {
  getFirebaseConfig: () => firebaseConfig
});