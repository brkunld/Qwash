require('dotenv').config(); // Bunu en başa ekle!
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            // 🔥 GÜVENLİK AYARLARI BURADA 🔥
            nodeIntegration: false,    // RCE (Uzaktan Kod Çalıştırma) açığını kapatır
            contextIsolation: true,    // Arayüz ile çekirdek sistemi birbirinden yalıtır
            preload: path.join(__dirname, 'preload.js') // Güvenli iletişim köprümüzü bağlarız
        }
    });

    win.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});