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

app.get("/api/admin/bays", async (req, res) => {
  try {
    const snapshot = await rtdb.ref("bays").once("value");
    if (!snapshot.exists()) return res.status(200).json({ bays: [] });
    
    const data = snapshot.val();
    const bayListesi = Object.keys(data)
      .map((key) => ({ id: key, ...data[key] }))
      .sort((a, b) => a.id.localeCompare(b.id));

    res.status(200).json({ bays: bayListesi });
  } catch (error) {
    safeLog(`[HATA] ❌ Admin Bay Listesi Hatası: ${error.message}`);
    res.status(500).json({ error: "Bay listesi alınamadı." });
  }
});

// --- 2. BAY DURUMUNU GÜNCELLE ---
app.post("/api/admin/update-bay", async (req, res) => {
  const { bayId, patch } = req.body;
  if (!bayId || !patch) return res.status(400).json({ error: "Eksik parametre." });

  try {
    const guncellemeVerisi = {
      ...patch,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    };

    // Zombi Peron Önlemi (Mobil uygulamadaki mantık)
    if (patch.status === "available" || patch.status === "offline") {
      guncellemeVerisi.currentSessionId = "";
      guncellemeVerisi.lastUserId = "";
    }

    await rtdb.ref(`bays/${bayId}`).update(guncellemeVerisi);
    safeLog(`[ADMİN] 🛠️ Peron Güncellendi: ${bayId} -> ${JSON.stringify(patch)}`);
    
    res.status(200).json({ success: true, message: "Peron güncellendi." });
  } catch (error) {
    safeLog(`[HATA] ❌ Bay Güncelleme Hatası: ${error.message}`);
    res.status(500).json({ error: "Güncelleme başarısız." });
  }
});

// --- 3. KULLANICI ARA (UID, E-posta veya Telefon) ---
app.post("/api/admin/search-user", async (req, res) => {
  const { arama } = req.body;
  if (!arama) return res.status(400).json({ error: "Arama terimi boş olamaz." });

  try {
    const queryVal = arama.trim();
    
    // 1. UID Gibi Mi Kontrolü
    if (!queryVal.includes("@") && !queryVal.includes(" ") && queryVal.length >= 20) {
      const uidSnap = await db.collection("users").doc(queryVal).get();
      if (uidSnap.exists) {
        return res.status(200).json({ user: { id: uidSnap.id, ...uidSnap.data() } });
      }
    }

    // 2. Email İle Arama
    if (/\S+@\S+\.\S+/.test(queryVal)) {
      const emailSnap = await db.collection("users")
        .where("email", "==", queryVal.toLowerCase())
        .limit(1)
        .get();
      if (!emailSnap.empty) {
        const doc = emailSnap.docs[0];
        return res.status(200).json({ user: { id: doc.id, ...doc.data() } });
      }
    }

    // 3. Telefon İle Arama
    const telSnap = await db.collection("users")
      .where("telefon", "==", queryVal)
      .limit(1)
      .get();
    if (!telSnap.empty) {
      const doc = telSnap.docs[0];
      return res.status(200).json({ user: { id: doc.id, ...doc.data() } });
    }

    return res.status(404).json({ error: "Eşleşen kullanıcı bulunamadı." });
  } catch (error) {
    safeLog(`[HATA] ❌ Kullanıcı Arama Hatası: ${error.message}`);
    res.status(500).json({ error: "Arama sırasında hata oluştu." });
  }
});

// --- 4. ADMİN MANUEL BAKİYE YÜKLEME ---
app.post("/api/admin/topup", async (req, res) => {
  const { userId, tokens } = req.body;
  
  if (!userId || !tokens) return res.status(400).json({ error: "Kullanıcı ID ve Jeton miktarı gerekli." });

  try {
    const adet = parseInt(tokens, 10);
    if (!Number.isFinite(adet) || adet <= 0) {
      return res.status(400).json({ error: "Geçerli bir jeton miktarı girin." });
    }

    // Jeton fiyatını güvenlik amacıyla mobilden değil, doğrudan Backend'den Firestore'dan çekiyoruz
    const snap = await db.collection("packages").doc("jeton").get();
    const jetonFiyat = snap.exists ? Number(snap.data().jetonFiyat || 0) : 0;

    if (jetonFiyat <= 0) {
      return res.status(500).json({ error: "Sistemde jeton fiyatı bulunamadı." });
    }

    const amountTRY = adet * jetonFiyat;
    const userRef = db.collection("users").doc(userId);

    await db.runTransaction(async (tx) => {
      const uDoc = await tx.get(userRef);
      if (!uDoc.exists) throw new Error("Kullanıcı_Bulunamadı");

      const yeniBakiye = Number(uDoc.data().walletTokens || 0) + adet;
      tx.update(userRef, { walletTokens: yeniBakiye });

      // İşlem geçmişine admin topup olarak kaydet
      tx.set(db.collection("transactions").doc(), {
        userId: userId,
        type: "admin_topup", // Mobildekinden ayırt edebilmek için özel type
        tokens: adet,
        amountTRY: amountTRY,
        unitPriceTRY: jetonFiyat,
        bayId: null,
        packageId: null,
        status: "success",
        adminId: "ELECTRON_ADMIN", // Ya da giriş yapan adminin ID'si
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    safeLog(`[ADMİN] 💰 Bakiye Yüklendi: ${userId} kullanıcısına ${adet} jeton (₺${amountTRY}) eklendi.`);
    res.status(200).json({ success: true, tokensAdded: adet, amountTRY: amountTRY });

  } catch (error) {
    safeLog(`[HATA] ❌ Admin Bakiye Yükleme Hatası: ${error.message}`);
    if (error.message === "Kullanıcı_Bulunamadı") {
      return res.status(404).json({ error: "Kullanıcı dokümanı bulunamadı." });
    }
    res.status(500).json({ error: "Bakiye yükleme başarısız oldu." });
  }
});

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