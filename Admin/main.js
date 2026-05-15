require("dotenv").config();

const { app, BrowserWindow } = require("electron");
const path = require("path");

function createWindow() {
const win = new BrowserWindow({
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

  win.loadFile(path.join(__dirname, "index.html"));

  // Menü istemiyorsan aç:
  // win.setMenuBarVisibility(false);

  // Geliştirme sırasında DevTools istersen aç:
  // win.webContents.openDevTools();
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