require("dotenv").config();

const { app, BrowserWindow } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "QWASH Admin",
    backgroundColor: "#f8f9fb",

    // Windows pencere ikonu.
    // En iyisi: Admin/build/icon.ico kullanmak.
    // Eğer build/icon.ico yoksa bunu oluştur.
    icon: path.join(__dirname, "build", "icon.ico"),

    webPreferences: {
      // Güvenli ayarlar
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,

      // Renderer ile Electron arasında güvenli köprü
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