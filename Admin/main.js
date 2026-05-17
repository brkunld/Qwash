require("dotenv").config();

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

// =========================================================
// 1. SQUIRREL KURULUM KİLİDİ
// Windows'ta kurulum (.exe) sırasında arka planda uygulamanın 
// defalarca açılmasını engeller.
// =========================================================
if (require('electron-squirrel-startup')) {
  app.quit();
  return;
}

// =========================================================
// 2. TEKİL ÇALIŞMA KİLİDİ (SINGLE INSTANCE LOCK)
// =========================================================
const gotTheLock = app.requestSingleInstanceLock();

let mainWindow; // Pencere referansını dışarıda tutuyoruz

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // =========================================================
  // UYGULAMA BAŞLATMA
  // =========================================================
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
        preload: path.join(__dirname, "preload.js")
      }
    });

    mainWindow.loadFile(path.join(__dirname, "index.html"));
  }

  app.whenReady().then(() => {
    createWindow();

    ipcMain.on("close-app", () => {
      app.quit();
    });

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