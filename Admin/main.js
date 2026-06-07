require("dotenv").config();

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

if (require("electron-squirrel-startup")) {
  app.quit();
  return;
}

const gotTheLock = app.requestSingleInstanceLock();

let mainWindow = null;

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();
  });

  
  
  
  
  
  function getFirebaseConfig() {
    const firebaseConfig = {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    };

    const missingKeys = Object.entries(firebaseConfig)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missingKeys.length > 0) {
      throw new Error(
        `Firebase config eksik: ${missingKeys.join(", ")}. .env dosyasını kontrol edin.`,
      );
    }

    return firebaseConfig;
  }

  
  
  
  
  
  function getApiBaseUrl() {
    const apiBaseUrl = process.env.API_BASE_URL;

    if (!apiBaseUrl) {
      throw new Error("API_BASE_URL eksik. .env dosyasını kontrol edin.");
    }

    return apiBaseUrl.replace(/\/$/, "");
  }

  
  
  
  
  ipcMain.handle("firebase:get-config", () => {
    return getFirebaseConfig();
  });

  ipcMain.handle("api:get-base-url", () => {
    return getApiBaseUrl();
  });

  ipcMain.handle("app:close", () => {
    app.quit();
    return true;
  });

  
  
  
  function createWindow() {
    mainWindow = new BrowserWindow({
      title: "QWASH Admin",
      backgroundColor: "#f8f9fb",
      icon: path.join(__dirname, "build", "icon.ico"),

      fullscreen: true,
      autoHideMenuBar: true,

      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        enableRemoteModule: false,
        webSecurity: true,
        preload: path.join(__dirname, "preload.js"),
      },
    });

    mainWindow.loadFile(path.join(__dirname, "index.html"));

    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    
    
    
    
  }

  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}