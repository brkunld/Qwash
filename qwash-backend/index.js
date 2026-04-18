// 1. ELECTRON EKLENTİLERİ
const { app: electronApp, BrowserWindow } = require("electron"); 

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ut-project-1c283-default-rtdb.europe-west1.firebasedatabase.app/" 
});

const db = admin.firestore();
const rtdb = admin.database();

const app = express();
app.use(cors());
app.use(express.json());

// =========================================================
// 🖥️ ELECTRON MASAÜSTÜ PENCERESİ AYARLARI
// =========================================================
let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Qwash Admin Paneli",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false // UI içinden ipcRenderer kullanabilmek için gerekli
    }
  });

  // Artık uzun HTML yazmak yerine oluşturduğumuz index.html'i yüklüyoruz!
  mainWindow.loadFile('index.html');
}
// =========================================================
// 🔥 ÖZEL LOG SİSTEMİ (Artık SADECE UI'a gönderiyor, CMD'ye yazmıyor)
// =========================================================
const safeLog = (message) => {
  const temizMesaj = message.replace(/\n/g, '').trim(); 
  
  // Arayüze (Electron Penceresine) gönder
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('yeni-log', temizMesaj);
  }
};

app.use((req, res, next) => {
  const saat = new Date().toLocaleTimeString("tr-TR");
  safeLog(`[${saat}] 🌐 İSTEK: ${req.method} ${req.url}`);
  next();
});

// =========================================================
// 🔥 CANLI SAYAÇ TAKİP SİSTEMİ (DASHBOARD)
// =========================================================
const activeTimers = {};

const clearBayTimer = (bayId) => {
  if (activeTimers[bayId]) {
    clearTimeout(activeTimers[bayId].timeout);
    delete activeTimers[bayId];
  }
};

const startWaitingTimer = (bayId) => {
  clearBayTimer(bayId); 
  safeLog(`[SİSTEM] ⏱️ BEKLEME MODU: ${bayId} işlemi için 60 sn süre tanındı.`);

  activeTimers[bayId] = {
    type: "Müşteri Bekleniyor",
    endTime: Date.now() + 60000,
    timeout: setTimeout(async () => {
      const checkSnap = await rtdb.ref(`bays/${bayId}`).once("value");
      if (checkSnap.val()?.status === "waiting") {
        await rtdb.ref(`bays/${bayId}`).update({
          status: "available",
          updatedAt: admin.database.ServerValue.TIMESTAMP
        });
        safeLog(`[SİSTEM] ⏳ ZAMAN AŞIMI: ${bayId} işlem yapılmadığı için boşa çıkarıldı.`);
      }
      clearBayTimer(bayId);
    }, 60000)
  };
};

setInterval(() => {
  const bays = Object.keys(activeTimers);
  if (bays.length > 0) {
    let logMsg = `📊 Canlı Durum: `;
    bays.forEach(bay => {
      const kalanSn = Math.ceil((activeTimers[bay].endTime - Date.now()) / 1000);
      if (kalanSn > 0) {
        logMsg += `[${bay}: ${kalanSn} sn]  `;
      }
    });
    
    // Yalnızca UI'daki turuncu durum kutusu için gönder (CMD kodları silindi)
    if (mainWindow && mainWindow.webContents) {
       mainWindow.webContents.send('canli-durum', logMsg);
    }
  } else {
    if (mainWindow && mainWindow.webContents) {
       mainWindow.webContents.send('canli-durum', 'Tüm Peronlar Uygun');
    }
  }
}, 1000);

// =========================================================
// 🔥 1 DAKİKA BEKLEME (OTOMATİK İPTAL) DİNLEYİCİSİ
// =========================================================
rtdb.ref("bays").on("child_changed", (snapshot) => {
  const bayId = snapshot.key;
  const bayData = snapshot.val();

  if (!bayData) return;

  if (bayData.status === "waiting") {
    if (activeTimers[bayId]) return;
    startWaitingTimer(bayId);
  } 
  else if (bayData.status !== "waiting" && activeTimers[bayId]?.type === "Müşteri Bekleniyor") {
    clearBayTimer(bayId);
    safeLog(`[SİSTEM] 🛑 BEKLEME İPTAL: ${bayId} durumu değişti, 60sn sayaç durduruldu.`);
  }
});

// ---------------------------------------------------------
// 1. OTURUM BAŞLATMA API'Sİ
// ---------------------------------------------------------
app.post("/api/start-session", async (req, res) => {
  const { uid, bayId, packageId, tokensCost, durationSec } = req.body;
  
  if (!uid || !bayId || !packageId || tokensCost === undefined || !durationSec) {
    return res.status(400).json({ error: "Eksik parametre gönderildi." });
  }

  try {
    const userRef = db.collection("users").doc(uid);
    const rtdbBayRef = rtdb.ref(`bays/${bayId}`);
    let newSessionId = null;

    const baySnap = await rtdbBayRef.once("value");
    const bayData = baySnap.val();

    if (!bayData || (bayData.status !== "available" && bayData.status !== "waiting")) {
      return res.status(400).json({ error: "Peron şu anda kullanılıyor." });
    }

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("Kullanıcı bulunamadı");

      const mevcutBakiye = Number(userDoc.data().walletTokens || 0);
      if (mevcutBakiye < tokensCost) throw new Error("Yetersiz_Bakiye");

      const sessionRef = db.collection("sessions").doc();
      newSessionId = sessionRef.id;

      t.update(userRef, { walletTokens: mevcutBakiye - tokensCost });
      t.set(sessionRef, {
        bayId, userId: uid, type: packageId, packageId, tokensCost, durationSec,
        status: "running",
        startedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    await rtdbBayRef.update({
      status: "busy",
      requestedPackage: packageId,
      durationSec: durationSec,
      tokensCost: tokensCost,
      lastUserId: uid,
      currentSessionId: newSessionId,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    safeLog(`[İŞLEM] ✅ BAŞARILI: ${bayId} başlatıldı. Yıkama süresi: ${durationSec} sn`);

    clearBayTimer(bayId); 
    
    const timeoutMs = durationSec * 1000;
    activeTimers[bayId] = {
      type: `Çalışıyor`,
      endTime: Date.now() + timeoutMs,
      timeout: setTimeout(async () => {
        try {
          safeLog(`[SİSTEM] ⏰ SÜRE DOLDU: ${bayId} otomatik kapatılıyor...`);
          const sessionCheck = await db.collection("sessions").doc(newSessionId).get();
          if (sessionCheck.exists && sessionCheck.data().status === "running") {
            
            await db.collection("sessions").doc(newSessionId).update({
              status: "ended",
              endedAt: admin.firestore.FieldValue.serverTimestamp(),
              endedReason: "time_up"
            });

            await rtdbBayRef.update({
              status: "waiting",
              currentSessionId: "",
              requestedPackage: null,
              durationSec: null,
              tokensCost: null,
              updatedAt: admin.database.ServerValue.TIMESTAMP
            });
            safeLog(`[SİSTEM] 🏁 OTOMATİK KAPATMA BAŞARILI: ${bayId} bekleme moduna alındı.`);
            startWaitingTimer(bayId); 
          }
        } catch (err) {
          safeLog(`[HATA] ❌ Zamanlayıcı hatası: ${err.message}`);
        }
      }, timeoutMs)
    };

    return res.status(200).json({ success: true, message: "Makine başlatıldı." });

  } catch (error) {
    if (error.message === "Yetersiz_Bakiye") return res.status(400).json({ error: "Jeton bakiyeniz yetersiz." });
    safeLog(`[HATA] ❌ Başlatma hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 2. OTURUMU MANUEL DURDURMA API'Sİ
// ---------------------------------------------------------
app.post("/api/stop-session", async (req, res) => {
  const { bayId, sessionId, uid } = req.body;
  
  if (!bayId || !sessionId) return res.status(400).json({ error: "Eksik parametre." });

  try {
    const sessionRef = db.collection("sessions").doc(sessionId);
    const rtdbBayRef = rtdb.ref(`bays/${bayId}`);

    await sessionRef.update({
      status: "ended",
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
      endedReason: "user_stopped"
    });

    await rtdbBayRef.update({
      status: "waiting",
      currentSessionId: "",
      requestedPackage: null,
      durationSec: null,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    safeLog(`[İŞLEM] ⛔ MANUEL DURDURMA BAŞARILI: ${bayId} durduruldu.`);
    startWaitingTimer(bayId); 
    return res.status(200).json({ success: true, message: "Oturum durduruldu." });

  } catch (error) {
    safeLog(`[HATA] ❌ Durdurma hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 3. BAKİYE (JETON) YÜKLEME API'Sİ
// ---------------------------------------------------------
app.post("/api/topup", async (req, res) => {
  const { uid, tokens, amountTRY, kartNo, sonKullanma, cvv } = req.body;
  
  if (!uid || !tokens || !amountTRY) return res.status(400).json({ error: "Eksik parametre." });
  if (!kartNo || kartNo.length < 12) return res.status(400).json({ error: "Geçersiz Kart Numarası" });

  try {
    const userRef = db.collection("users").doc(uid);
    const txRef = db.collection("transactions").doc();

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("Kullanıcı bulunamadı");

      const mevcutBakiye = Number(userDoc.data().walletTokens || 0);

      t.update(userRef, {
        walletTokens: mevcutBakiye + tokens,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      t.set(txRef, {
        type: "topup",
        status: "success",
        tokens: tokens,
        unitPriceTRY: amountTRY / tokens,
        amountTRY: amountTRY,
        userId: uid,
        adminId: null,
        bayId: null,
        packageId: null,
        sessionId: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    safeLog(`[İŞLEM] ✅ ÖDEME BAŞARILI: ${uid} -> ${tokens} jeton eklendi.`);
    return res.status(200).json({ success: true, message: "Bakiye başarıyla yüklendi." });

  } catch (error) {
    safeLog(`[HATA] ❌ Ödeme hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası, yükleme yapılamadı." });
  }
});

// =========================================================
// 🔥 SUNUCU AYAĞA KALKARKEN YAPILACAK SİSTEM TEMİZLİĞİ
// =========================================================
const systemStartupClean = async () => {
  try {
    safeLog("[BAŞLATMA] 🔄 Veritabanı temizliği yapılıyor...");

    const baysSnap = await rtdb.ref("bays").once("value");
    if (baysSnap.exists()) {
      const updates = {};
      Object.keys(baysSnap.val()).forEach(bayId => {
        updates[`bays/${bayId}/status`] = "available";
        updates[`bays/${bayId}/currentSessionId`] = "";
        updates[`bays/${bayId}/requestedPackage`] = null;
        updates[`bays/${bayId}/durationSec`] = null;
        updates[`bays/${bayId}/tokensCost`] = null;
        updates[`bays/${bayId}/lastUserId`] = null;
        updates[`bays/${bayId}/updatedAt`] = admin.database.ServerValue.TIMESTAMP;
      });
      await rtdb.ref().update(updates);
    }

    const runningSessions = await db.collection("sessions").where("status", "==", "running").get();
    if (!runningSessions.empty) {
      const batch = db.batch();
      runningSessions.forEach(doc => {
        batch.update(doc.ref, {
          status: "ended",
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          endedReason: "server_restart"
        });
      });
      await batch.commit();
    }

    safeLog("[BAŞLATMA] ✨ Temizlik tamamlandı! Tüm peronlar 'available' durumunda.");
  } catch (error) {
    safeLog(`[HATA] ❌ Temizlik sırasında hata: ${error.message}`);
  }
};

// =========================================================
// 🚀 BAŞLATMA ZİNCİRİ (Önce Pencere -> Temizlik -> Express)
// =========================================================
const PORT = 3000;
const HOST = "0.0.0.0";

// Electron tamamen hazır olduğunda işlemleri başlat
electronApp.whenReady().then(() => {
  
  // 1. Önce Masaüstü Penceresini Aç
  createWindow();

  // 2. Bir saniye bekleyip işlemlere başla (Pencerenin render olması için)
  setTimeout(() => {
    // 3. Veritabanı Temizliğini Yap
    systemStartupClean().then(() => {
      
      // 4. Express Backend'i Başlat
      app.listen(PORT, HOST, () => {
        safeLog(`[BAŞLATMA] 🚀 QWash Sunucusu Başarıyla Başlatıldı!`);
        safeLog(`[BAŞLATMA] 📡 API Portu: ${PORT}`);
      });
    });
  }, 1000);

  // Mac bilgisayarlar için pencere yönetim desteği
  electronApp.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Çarpıya basıldığında Programı ve Node.js Backend'ini tamamen kapat
electronApp.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    electronApp.quit();
  }
});