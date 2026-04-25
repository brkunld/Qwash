const path = require('path');
const fs = require('fs'); // 🔥 Dosya kontrolü için fs modülünü ekledik
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// 🔥 1. Yol: Render'ın standart Secret File dizini
const renderSecretPath = '/etc/secrets/serviceAccountKey.json';
// 🔥 2. Yol: Bilgisayarınızdaki (lokal) dosya yolu
const localSecretPath = path.join(__dirname, '..', '..', 'serviceAccountKey.json');

let serviceAccountPath;

// Dosyanın Render'da olup olmadığını kontrol et, yoksa lokal yolu kullan
if (fs.existsSync(renderSecretPath)) {
  serviceAccountPath = renderSecretPath;
  console.log("✅ Render Secret File bulundu ve kullanılıyor.");
} else {
  serviceAccountPath = localSecretPath;
  console.log("✅ Lokal Secret File kullanılıyor.");
}

const serviceAccount = require(serviceAccountPath);

// 🔥 DİKKAT: firebase-admin sadece BİR KERE initialize edilmelidir.
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
// 🔥 LOG SİSTEMİ (Artık doğrudan sunucu terminaline yazıyor)
// =========================================================
const safeLog = (message) => {
  const saat = new Date().toLocaleTimeString("tr-TR");
  console.log(`[${saat}] ${message}`);
};

app.use((req, res, next) => {
  safeLog(`🌐 İSTEK: ${req.method} ${req.url}`);
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
  safeLog(`⏱️ BEKLEME MODU: ${bayId} işlemi için 60 sn süre tanındı.`);

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
        safeLog(`⏳ ZAMAN AŞIMI: ${bayId} işlem yapılmadığı için boşa çıkarıldı.`);
      }
      clearBayTimer(bayId);
    }, 60000)
  };
};

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
    safeLog(`🛑 BEKLEME İPTAL: ${bayId} durumu değişti, 60sn sayaç durduruldu.`);
  }
});

// ---------------------------------------------------------
// 1. OTURUM BAŞLATMA API'Sİ (Mobil Uygulama)
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

      // 🔥 YIKILMAZ GÜVENLİK DUVARI: KULLANICI ENGELLİ Mİ? 🔥
      if (userDoc.data().isBlocked === true) {
        throw new Error("Engellenmis_Kullanici");
      }

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

    safeLog(`✅ BAŞARILI: ${bayId} başlatıldı. Yıkama süresi: ${durationSec} sn`);

    clearBayTimer(bayId); 
    
    const timeoutMs = durationSec * 1000;
    activeTimers[bayId] = {
      type: `Çalışıyor`,
      endTime: Date.now() + timeoutMs,
      timeout: setTimeout(async () => {
        try {
          safeLog(`⏰ SÜRE DOLDU: ${bayId} otomatik kapatılıyor...`);
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
            safeLog(`🏁 OTOMATİK KAPATMA BAŞARILI: ${bayId} bekleme moduna alındı.`);
            startWaitingTimer(bayId); 
          }
        } catch (err) {
          safeLog(`❌ Zamanlayıcı hatası: ${err.message}`);
        }
      }, timeoutMs)
    };

    return res.status(200).json({ success: true, message: "Makine başlatıldı." });

  } catch (error) {
    // 🔥 ENGELLİ KULLANICI YAKALAMA 🔥
    if (error.message === "Engellenmis_Kullanici") {
      safeLog(`🚨 GÜVENLİK İHLALİ DENEMESİ: Engelli kullanıcı (${uid}) makineyi başlatmaya çalıştı!`);
      return res.status(403).json({ error: "Hesabınız askıya alındığı için işlem yapamazsınız." });
    }
    if (error.message === "Yetersiz_Bakiye") return res.status(400).json({ error: "Jeton bakiyeniz yetersiz." });
    safeLog(`❌ Başlatma hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 2. OTURUMU MANUEL DURDURMA API'Sİ (Mobil Uygulama)
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

    safeLog(`⛔ MANUEL DURDURMA BAŞARILI: ${bayId} durduruldu.`);
    startWaitingTimer(bayId); 
    return res.status(200).json({ success: true, message: "Oturum durduruldu." });

  } catch (error) {
    safeLog(`❌ Durdurma hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 3. MÜŞTERİ KART İLE BAKİYE YÜKLEME API'Sİ (Mobil Uygulama)
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

      // 🔥 YIKILMAZ GÜVENLİK DUVARI: KULLANICI ENGELLİ Mİ? 🔥
      if (userDoc.data().isBlocked === true) {
        throw new Error("Engellenmis_Kullanici");
      }

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

    safeLog(`✅ MÜŞTERİ ÖDEMESİ BAŞARILI: ${uid} -> ${tokens} jeton eklendi.`);
    return res.status(200).json({ success: true, message: "Bakiye başarıyla yüklendi." });

  } catch (error) {
    safeLog(`❌ Müşteri ödeme hatası: ${error.message}`);
    // 🔥 ENGELLİ KULLANICI YAKALAMA 🔥
    if (error.message === "Engellenmis_Kullanici") {
      return res.status(403).json({ error: "Hesabınız askıya alındığı için bakiye yükleyemezsiniz." });
    }
    return res.status(500).json({ error: "Sunucu hatası, yükleme yapılamadı." });
  }
});

// ---------------------------------------------------------
// 4. ADMİN PANELİ API'LERİ (Electron Masaüstü İçin)
// ---------------------------------------------------------
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
    safeLog(`❌ Admin Bay Listesi Hatası: ${error.message}`);
    res.status(500).json({ error: "Bay listesi alınamadı." });
  }
});

app.post("/api/admin/update-bay", async (req, res) => {
  const { bayId, patch } = req.body;
  if (!bayId || !patch) return res.status(400).json({ error: "Eksik parametre." });

  try {
    const guncellemeVerisi = {
      ...patch,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    };

    if (patch.status === "available" || patch.status === "offline") {
      guncellemeVerisi.currentSessionId = "";
      guncellemeVerisi.lastUserId = "";
    }

    await rtdb.ref(`bays/${bayId}`).update(guncellemeVerisi);
    safeLog(`🛠️ Peron Güncellendi: ${bayId} -> ${JSON.stringify(patch)}`);
    
    res.status(200).json({ success: true, message: "Peron güncellendi." });
  } catch (error) {
    safeLog(`❌ Bay Güncelleme Hatası: ${error.message}`);
    res.status(500).json({ error: "Güncelleme başarısız." });
  }
});

app.post("/api/admin/search-user", async (req, res) => {
  const { arama } = req.body;
  if (!arama) return res.status(400).json({ error: "Arama terimi boş olamaz." });

  try {
    const queryVal = arama.trim();
    
    if (!queryVal.includes("@") && !queryVal.includes(" ") && queryVal.length >= 20) {
      const uidSnap = await db.collection("users").doc(queryVal).get();
      if (uidSnap.exists) {
        return res.status(200).json({ user: { id: uidSnap.id, ...uidSnap.data() } });
      }
    }

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
    safeLog(`❌ Kullanıcı Arama Hatası: ${error.message}`);
    res.status(500).json({ error: "Arama sırasında hata oluştu." });
  }
});

// ---------------------------------------------------------
// KULLANICI DURUMUNU GÜNCELLEME (ENGELLEME) API'Sİ
// ---------------------------------------------------------
app.post("/api/admin/update-user", async (req, res) => {
  const { userId, patch } = req.body;
  
  if (!userId || !patch) {
    return res.status(400).json({ error: "Eksik parametre gönderildi." });
  }

  try {
    // Firestore'da kullanıcının isBlocked alanını güncelliyoruz
    await db.collection("users").doc(userId).update({
      isBlocked: patch.isBlocked,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const islemTipi = patch.isBlocked ? "Engellendi" : "Engeli Kaldırıldı";
    safeLog(`🛡️ KULLANICI İŞLEMİ: ${userId} -> ${islemTipi}`);
    
    res.status(200).json({ success: true, message: `Kullanıcı durumu güncellendi.` });

  } catch (error) {
    safeLog(`❌ Kullanıcı Güncelleme Hatası: ${error.message}`);
    res.status(500).json({ error: "Kullanıcı güncellenirken sunucu hatası oluştu." });
  }
});

app.post("/api/admin/topup", async (req, res) => {
  const { userId, tokens } = req.body;
  
  if (!userId || !tokens) return res.status(400).json({ error: "Kullanıcı ID ve Jeton miktarı gerekli." });

  try {
    const adet = parseInt(tokens, 10);
    if (!Number.isFinite(adet) || adet <= 0) {
      return res.status(400).json({ error: "Geçerli bir jeton miktarı girin." });
    }

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

      tx.set(db.collection("transactions").doc(), {
        userId: userId,
        type: "admin_topup", 
        tokens: adet,
        amountTRY: amountTRY,
        unitPriceTRY: jetonFiyat,
        bayId: null,
        packageId: null,
        status: "success",
        adminId: "ELECTRON_ADMIN", 
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    safeLog(`💰 ADMİN BAKİYE YÜKLEDİ: ${userId} kullanıcısına ${adet} jeton eklendi.`);
    res.status(200).json({ success: true, tokensAdded: adet, amountTRY: amountTRY });

  } catch (error) {
    safeLog(`❌ Admin Bakiye Yükleme Hatası: ${error.message}`);
    if (error.message === "Kullanıcı_Bulunamadı") {
      return res.status(404).json({ error: "Kullanıcı dokümanı bulunamadı." });
    }
    res.status(500).json({ error: "Bakiye yükleme başarısız oldu." });
  }
});

// =========================================================
// 🔥 SUNUCU AYAĞA KALKARKEN YAPILACAK SİSTEM TEMİZLİĞİ
// =========================================================
const systemStartupClean = async () => {
  try {
    safeLog("🔄 Veritabanı temizliği yapılıyor...");

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

    safeLog("✨ Temizlik tamamlandı! Tüm peronlar 'available' durumunda.");
  } catch (error) {
    safeLog(`❌ Temizlik sırasında hata: ${error.message}`);
  }
};

// =========================================================
// 🚀 BAŞLATMA ZİNCİRİ (Render.com için ayarlandı)
// =========================================================

// Render, kendi portunu `process.env.PORT` üzerinden verir. 
// Eğer lokalde çalıştırırsan 3000 portunu kullanır.
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Önce temizliği yap, sonra sunucuyu dinlemeye başla
systemStartupClean().then(() => {
  app.listen(PORT, HOST, () => {
    safeLog(`🚀 QWash Sunucusu Başarıyla Başlatıldı!`);
    safeLog(`📡 API Portu: ${PORT}`);
  });
});