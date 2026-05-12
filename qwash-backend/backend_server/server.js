require("dotenv").config();

const path = require("path");
const fs = require("fs"); // 🔥 Dosya kontrolü için fs modülünü ekledik
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const cron = require("node-cron");

// 🔥 1. Yol: Render'ın standart Secret File dizini
const renderSecretPath = "/etc/secrets/serviceAccountKey.json";
// 🔥 2. Yol: Bilgisayarınızdaki (lokal) dosya yolu
const localSecretPath = path.join(
  __dirname,
  "..",
  "..",
  "serviceAccountKey.json",
);

// =========================================================
// 🛡️ GÜVENLİK DUVARLARI (MIDDLEWARE)
// =========================================================

// 🔥 1. MOBİL UYGULAMA İÇİN: STANDART KULLANICI DOĞRULAMASI
const verifyUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    safeLog(`🚨 YETKİSİZ ERİŞİM DENEMESİ: Kimlik (Token) gönderilmedi.`);
    return res.status(401).json({ error: "İşlem reddedildi: Giriş yapmanız gerekiyor." });
  }

  const token = authHeader.split(' ')[1];
  try {
    // Firebase'e soruyoruz: "Bu token gerçek mi?"
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // 🔥 EN BÜYÜK AÇIĞI KAPATAN YER: 
    // Gelen istekteki uid ile, Token'ın sahibinin uid'si aynı mı?
    if (req.body.uid && req.body.uid !== decodedToken.uid) {
       safeLog(`🚨 SAHTEKARLIK TESPİTİ! Kendi hesabı yerine başkasının işlemi yapılmaya çalışıldı. Kurban UID: ${req.body.uid}, Saldırgan: ${decodedToken.uid}`);
       return res.status(403).json({ error: "Güvenlik ihlali: Başka bir kullanıcının adına işlem yapamazsınız!" });
    }
    
    req.user = decodedToken; // Kimlik onaylandı, içeri girebilir!
    next(); 
  } catch (error) {
    safeLog(`❌ Geçersiz Token: ${error.message}`);
    return res.status(401).json({ error: "Geçersiz veya süresi dolmuş oturum." });
  }
};

// 🔥 2. ELECTRON (MASAÜSTÜ) İÇİN: ADMİN DOĞRULAMASI
const verifyAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Yetkisiz erişim." });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Senin admin giriş mantığına (login.js) uygun olarak admin mi diye bakıyoruz
    if (decodedToken.admin === true || decodedToken.role === 'admin') {
       req.admin = decodedToken;
       next();
    } else {
       safeLog(`🚨 YETKİSİZ ADMİN DENEMESİ: Normal kullanıcı (${decodedToken.email}) admin paneline girmeye çalıştı!`);
       return res.status(403).json({ error: "Bu işlem için yetkiniz yok." });
    }
  } catch (error) {
    return res.status(401).json({ error: "Geçersiz admin oturumu." });
  }
};

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
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.firestore();
const rtdb = admin.database();

const app = express();
app.use(cors());
app.use(express.json());

// =========================================================
// 🔥 UPTIMEROBOT İÇİN PING (YAŞIYORUM) YANITI
// =========================================================
app.get("/", (req, res) => {
  res.status(200).send("QWash API Sapasağlam Ayakta! 🚀");
});

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
          updatedAt: admin.database.ServerValue.TIMESTAMP,
        });
        safeLog(
          `⏳ ZAMAN AŞIMI: ${bayId} işlem yapılmadığı için boşa çıkarıldı.`,
        );
      }
      clearBayTimer(bayId);
    }, 60000),
  };
};

// =========================================================
// 🔥 1 DAKİKA BEKLEME (OTOMATİK İPTAL) DİNLEYİCİSİ
// =========================================================
const bayStatusCache = {}; // YENİ: Peronların son statülerini hafızada tutarız

rtdb.ref("bays").on("child_changed", (snapshot) => {
  const bayId = snapshot.key;
  const bayData = snapshot.val();

  if (!bayData) return;

  const oldStatus = bayStatusCache[bayId];
  const currentStatus = bayData.status;

  bayStatusCache[bayId] = currentStatus; // Hafızayı yeni duruma göre güncelle

  // 🔥 ÇÖZÜM: Eğer statü değişmediyse (yani sadece ESP32 nabız attığı için tetiklendiyse) GÖRMEZDEN GEL!
  if (oldStatus === currentStatus) {
    return;
  }

  // Sadece statü gerçekten değiştiğinde sayaç işlemleri yapılır
  if (currentStatus === "waiting") {
    if (activeTimers[bayId]) return;
    startWaitingTimer(bayId);
  } else if (
    currentStatus !== "waiting" &&
    activeTimers[bayId]?.type === "Müşteri Bekleniyor"
  ) {
    clearBayTimer(bayId);
    safeLog(
      `🛑 BEKLEME İPTAL: ${bayId} durumu değişti, 60sn sayaç durduruldu.`,
    );
  }
});

// ---------------------------------------------------------
// 1. OTURUM BAŞLATMA API'Sİ (Mobil Uygulama)
// ---------------------------------------------------------
app.post("/api/start-session",verifyUser, async (req, res) => {
  const { uid, bayId, packageId, tokensCost, durationSec } = req.body;

  if (
    !uid ||
    !bayId ||
    !packageId ||
    tokensCost === undefined ||
    !durationSec
  ) {
    return res.status(400).json({ error: "Eksik parametre gönderildi." });
  }

  try {
    const userRef = db.collection("users").doc(uid);
    const rtdbBayRef = rtdb.ref(`bays/${bayId}`);
    let newSessionId = null;

    const baySnap = await rtdbBayRef.once("value");
    const bayData = baySnap.val();

    if (
      !bayData ||
      (bayData.status !== "available" && bayData.status !== "waiting")
    ) {
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
        bayId,
        userId: uid,
        type: packageId,
        packageId,
        tokensCost,
        durationSec,
        status: "running",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await rtdbBayRef.update({
      status: "busy",
      requestedPackage: packageId,
      durationSec: durationSec,
      tokensCost: tokensCost,
      lastUserId: uid,
      currentSessionId: newSessionId,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    safeLog(
      `✅ BAŞARILI: ${bayId} başlatıldı. Yıkama süresi: ${durationSec} sn`,
    );

    clearBayTimer(bayId);

    const timeoutMs = durationSec * 1000;
    activeTimers[bayId] = {
      type: `Çalışıyor`,
      endTime: Date.now() + timeoutMs,
      timeout: setTimeout(async () => {
        try {
          safeLog(`⏰ SÜRE DOLDU: ${bayId} otomatik kapatılıyor...`);
          const sessionCheck = await db
            .collection("sessions")
            .doc(newSessionId)
            .get();
          if (sessionCheck.exists && sessionCheck.data().status === "running") {
            await db.collection("sessions").doc(newSessionId).update({
              status: "ended",
              endedAt: admin.firestore.FieldValue.serverTimestamp(),
              endedReason: "time_up",
            });

            await rtdbBayRef.update({
              status: "waiting",
              currentSessionId: "",
              requestedPackage: null,
              durationSec: null,
              tokensCost: null,
              updatedAt: admin.database.ServerValue.TIMESTAMP,
            });
            safeLog(
              `🏁 OTOMATİK KAPATMA BAŞARILI: ${bayId} bekleme moduna alındı.`,
            );
            startWaitingTimer(bayId);
          }
        } catch (err) {
          safeLog(`❌ Zamanlayıcı hatası: ${err.message}`);
        }
      }, timeoutMs),
    };

    return res
      .status(200)
      .json({ success: true, message: "Makine başlatıldı." });
  } catch (error) {
    // 🔥 ENGELLİ KULLANICI YAKALAMA 🔥
    if (error.message === "Engellenmis_Kullanici") {
      safeLog(
        `🚨 GÜVENLİK İHLALİ DENEMESİ: Engelli kullanıcı (${uid}) makineyi başlatmaya çalıştı!`,
      );
      return res
        .status(403)
        .json({ error: "Hesabınız askıya alındığı için işlem yapamazsınız." });
    }
    if (error.message === "Yetersiz_Bakiye")
      return res.status(400).json({ error: "Jeton bakiyeniz yetersiz." });
    safeLog(`❌ Başlatma hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 2. OTURUMU MANUEL DURDURMA API'Sİ (Mobil Uygulama)
// ---------------------------------------------------------
app.post("/api/stop-session",verifyUser, async (req, res) => {
  const { bayId, sessionId, uid } = req.body;

  if (!bayId || !sessionId)
    return res.status(400).json({ error: "Eksik parametre." });

  try {
    const sessionRef = db.collection("sessions").doc(sessionId);
    const rtdbBayRef = rtdb.ref(`bays/${bayId}`);

    await sessionRef.update({
      status: "ended",
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
      endedReason: "user_stopped",
    });

    await rtdbBayRef.update({
      status: "waiting",
      currentSessionId: "",
      requestedPackage: null,
      durationSec: null,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    safeLog(`⛔ MANUEL DURDURMA BAŞARILI: ${bayId} durduruldu.`);
    startWaitingTimer(bayId);
    return res
      .status(200)
      .json({ success: true, message: "Oturum durduruldu." });
  } catch (error) {
    safeLog(`❌ Durdurma hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 3. MÜŞTERİ KART İLE BAKİYE YÜKLEME API'Sİ (Mobil Uygulama)
// ---------------------------------------------------------
app.post("/api/topup", verifyUser,async (req, res) => {
  const { uid, tokens, amountTRY, kartNo, sonKullanma, cvv } = req.body;

  if (!uid || !tokens || !amountTRY)
    return res.status(400).json({ error: "Eksik parametre." });
  if (!kartNo || kartNo.length < 12)
    return res.status(400).json({ error: "Geçersiz Kart Numarası" });

  // 🔥 1. GÜVENLİK: Gelen verileri kesinlikle sayıya (integer/number) çeviriyoruz 🔥
  const eklenecekJeton = parseInt(tokens, 10);
  const eklenecekTutar = Number(amountTRY);

  // 🔥 2. GÜVENLİK: Sayı değilse (NaN) veya 0'dan küçükse/eşitse hileyi engelle 🔥
  if (isNaN(eklenecekJeton) || eklenecekJeton <= 0) {
    return res.status(400).json({ error: "Geçersiz jeton miktarı! Sistem manipülasyonu engellendi." });
  }
  if (isNaN(eklenecekTutar) || eklenecekTutar <= 0) {
    return res.status(400).json({ error: "Geçersiz ödeme tutarı!" });
  }

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
        // Artık iki değerin de kesinlikle "Sayı" olduğundan eminiz. (Örn: 50 + 100 = 150)
        walletTokens: mevcutBakiye + eklenecekJeton, 
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      t.set(txRef, {
        type: "topup",
        status: "success",
        tokens: eklenecekJeton, // Güvenli değişkeni kullandık
        unitPriceTRY: eklenecekTutar / eklenecekJeton, // Güvenli matematiksel işlem
        amountTRY: eklenecekTutar, // Güvenli değişkeni kullandık
        userId: uid,
        adminId: null,
        bayId: null,
        packageId: null,
        sessionId: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    safeLog(`✅ MÜŞTERİ ÖDEMESİ BAŞARILI: ${uid} -> ${eklenecekJeton} jeton eklendi.`);
    return res
      .status(200)
      .json({ success: true, message: "Bakiye başarıyla yüklendi." });
  } catch (error) {
    safeLog(`❌ Müşteri ödeme hatası: ${error.message}`);
    // 🔥 ENGELLİ KULLANICI YAKALAMA 🔥
    if (error.message === "Engellenmis_Kullanici") {
      return res.status(403).json({
        error: "Hesabınız askıya alındığı için bakiye yükleyemezsiniz.",
      });
    }
    return res
      .status(500)
      .json({ error: "Sunucu hatası, yükleme yapılamadı." });
  }
});

// ---------------------------------------------------------
// 4. ADMİN PANELİ API'LERİ (Electron Masaüstü İçin)
// ---------------------------------------------------------
app.get("/api/admin/bays",verifyAdmin, async (req, res) => {
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

app.post("/api/admin/update-bay",verifyAdmin, async (req, res) => {
  const { bayId, patch } = req.body;
  if (!bayId || !patch)
    return res.status(400).json({ error: "Eksik parametre." });

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

app.post("/api/admin/search-user",verifyAdmin, async (req, res) => {
  const { arama } = req.body;
  if (!arama)
    return res.status(400).json({ error: "Arama terimi boş olamaz." });

  try {
    const queryVal = arama.trim();

    if (
      !queryVal.includes("@") &&
      !queryVal.includes(" ") &&
      queryVal.length >= 20
    ) {
      const uidSnap = await db.collection("users").doc(queryVal).get();
      if (uidSnap.exists) {
        return res
          .status(200)
          .json({ user: { id: uidSnap.id, ...uidSnap.data() } });
      }
    }

    if (/\S+@\S+\.\S+/.test(queryVal)) {
      const emailSnap = await db
        .collection("users")
        .where("email", "==", queryVal.toLowerCase())
        .limit(1)
        .get();
      if (!emailSnap.empty) {
        const doc = emailSnap.docs[0];
        return res.status(200).json({ user: { id: doc.id, ...doc.data() } });
      }
    }

    const telSnap = await db
      .collection("users")
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
app.post("/api/admin/update-user",verifyAdmin, async (req, res) => {
  const { userId, patch } = req.body;

  if (!userId || !patch) {
    return res.status(400).json({ error: "Eksik parametre gönderildi." });
  }

  try {
    // Firestore'da kullanıcının isBlocked alanını güncelliyoruz
    await db.collection("users").doc(userId).update({
      isBlocked: patch.isBlocked,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const islemTipi = patch.isBlocked ? "Engellendi" : "Engeli Kaldırıldı";
    safeLog(`🛡️ KULLANICI İŞLEMİ: ${userId} -> ${islemTipi}`);

    res
      .status(200)
      .json({ success: true, message: `Kullanıcı durumu güncellendi.` });
  } catch (error) {
    safeLog(`❌ Kullanıcı Güncelleme Hatası: ${error.message}`);
    res
      .status(500)
      .json({ error: "Kullanıcı güncellenirken sunucu hatası oluştu." });
  }
});

app.post("/api/admin/topup",verifyAdmin, async (req, res) => {
  const { userId, tokens } = req.body;

  if (!userId || !tokens)
    return res
      .status(400)
      .json({ error: "Kullanıcı ID ve Jeton miktarı gerekli." });

  try {
    const adet = parseInt(tokens, 10);
    if (!Number.isFinite(adet) || adet <= 0) {
      return res
        .status(400)
        .json({ error: "Geçerli bir jeton miktarı girin." });
    }

    const snap = await db.collection("packages").doc("jeton").get();
    const jetonFiyat = snap.exists ? Number(snap.data().jetonFiyat || 0) : 0;

    if (jetonFiyat <= 0) {
      return res
        .status(500)
        .json({ error: "Sistemde jeton fiyatı bulunamadı." });
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

    safeLog(
      `💰 ADMİN BAKİYE YÜKLEDİ: ${userId} kullanıcısına ${adet} jeton eklendi.`,
    );
    res
      .status(200)
      .json({ success: true, tokensAdded: adet, amountTRY: amountTRY });
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
      Object.keys(baysSnap.val()).forEach((bayId) => {
        updates[`bays/${bayId}/status`] = "available";
        updates[`bays/${bayId}/currentSessionId`] = "";
        updates[`bays/${bayId}/requestedPackage`] = null;
        updates[`bays/${bayId}/durationSec`] = null;
        updates[`bays/${bayId}/tokensCost`] = null;
        updates[`bays/${bayId}/lastUserId`] = null;
        updates[`bays/${bayId}/updatedAt`] =
          admin.database.ServerValue.TIMESTAMP;
      });
      await rtdb.ref().update(updates);
    }

    const runningSessions = await db
      .collection("sessions")
      .where("status", "==", "running")
      .get();
    if (!runningSessions.empty) {
      const batch = db.batch();
      runningSessions.forEach((doc) => {
        batch.update(doc.ref, {
          status: "ended",
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          endedReason: "server_restart",
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
// 🔥 MAİL GÖNDERME AYARLARI - BREVO HTTP API
// =========================================================
// Render Free SMTP portlarını engellediği için Nodemailer/Yandex SMTP yerine
// Brevo'nun HTTPS API'si kullanılıyor.
// Gerekli Environment Variables:
// BREVO_API_KEY
// EMAIL_FROM
// ADMIN_EMAIL

const sendAdminAlert = async (bayId, type) => {
  let subject;
  let htmlBody;

  if (type === "down") {
    subject = `🚨 DİKKAT: ${bayId} Bağlantısı Koptu!`;
    htmlBody = `
      <h2 style="color: red;">Sistem Uyarısı: Peron Çevrimdışı</h2>
      <p>
        <b>${bayId}</b> isimli perondan 2 dakikadan uzun süredir haber alınamıyor.
        Sistem, müşterilerin mağdur olmaması için peronu otomatik olarak
        <b>KAPALI</b> durumuna aldı.
      </p>
    `;
  } else if (type === "up") {
    subject = `✅ DÜZELDİ: ${bayId} Yeniden Çevrimiçi!`;
    htmlBody = `
      <h2 style="color: green;">Sistem Bilgilendirmesi: Bağlantı Geldi</h2>
      <p>
        <b>${bayId}</b> isimli peronun bağlantısı tekrar sağlandı.
        Sistem peronu otomatik olarak kullanıma <b>BOŞ</b> açtı.
      </p>
    `;
  } else {
    safeLog(`❌ Mail tipi bilinmiyor: ${type}`);
    return;
  }

  if (!process.env.BREVO_API_KEY) {
    safeLog("❌ Mail gönderilemedi: BREVO_API_KEY eksik.");
    return;
  }

  if (!process.env.EMAIL_FROM) {
    safeLog("❌ Mail gönderilemedi: EMAIL_FROM eksik.");
    return;
  }

  if (!process.env.ADMIN_EMAIL) {
    safeLog("❌ Mail gönderilemedi: ADMIN_EMAIL eksik.");
    return;
  }

  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: {
          name: "QWash Sistem",
          email: process.env.EMAIL_FROM,
        },
        to: [
          {
            email: process.env.ADMIN_EMAIL,
          },
        ],
        subject,
        htmlContent: htmlBody,
      }),
    });

    const responseText = await response.text();

    if (!response.ok) {
      safeLog(`❌ Mail API Hatası: ${response.status} - ${responseText}`);
      return;
    }

    safeLog(
      `📧 E-Posta başarıyla gönderildi: ${
        type === "down" ? "Kopma" : "Düzelme"
      } bildirimi.`,
    );
  } catch (error) {
    safeLog(`❌ Mail API Bağlantı Hatası: ${error.message}`);
  }
};

// =========================================================
// 🔥 HEARTBEAT (NABIZ) KONTROLCÜSÜ - DEDEKTİF + OTOMATİK KURTARMA
// =========================================================
cron.schedule("* * * * *", async () => {
  safeLog("🔍 [CRON] Nabız kontrolü çalışıyor...");

  try {
    const baysSnap = await rtdb.ref("bays").once("value");
    const bays = baysSnap.val();

    if (!bays) {
      safeLog("⚠️ [CRON] Firebase'de hiç peron bulunamadı!");
      return;
    }

    const now = Date.now();
    const timeoutMs = 2 * 60 * 1000; // 2 Dakika Tolerans

    Object.keys(bays).forEach(async (bayId) => {
      const bay = bays[bayId];

      // Admin bilerek kapattıysa veya bakıma aldıysa es geç
      if (
        (bay.status === "offline" && !bay.autoOffline) ||
        bay.status === "maintenance"
      ) {
        safeLog(
          `ℹ️ [CRON] ${bayId} admin tarafından kapatılmış veya bakımda, es geçiliyor.`,
        );
        return;
      }

      const lastSeen = bay.lastSeen;

      if (!lastSeen) {
        safeLog(`❌ [CRON] ${bayId} için 'lastSeen' verisi YOK!`);
        return;
      }

      const farkSaniye = Math.floor((now - lastSeen) / 1000);
      safeLog(
        `📊 [CRON] ${bayId} en son ${farkSaniye} saniye önce haber verdi.`,
      );

      const isDisconnected = now - lastSeen > timeoutMs;

      // 🔴 SENARYO 1: BAĞLANTI KOPTU (İnternet gitti veya fiş çekildi)
      if (isDisconnected) {
        if (bay.status !== "offline") {
          safeLog(`⚠️ KOPMA TESPİT EDİLDİ: ${bayId} otomatik kapatılıyor...`);

          await rtdb.ref(`bays/${bayId}`).update({
            status: "offline",
            isActive: false,
            autoOffline: true, // Sistemin kendi kapattığını işaretliyoruz (Admin kapatmadı)
            updatedAt: admin.database.ServerValue.TIMESTAMP,
          });

          sendAdminAlert(bayId, "down"); // Kopma maili at
        }
      }
      // 🟢 SENARYO 2: BAĞLANTI GERİ GELDİ (Otomatik Kurtarma)
      else {
        // Eğer bu makineyi SİSTEM (autoOffline) kapattıysa ve şimdi interneti geri geldiyse
        if (bay.status === "offline" && bay.autoOffline === true) {
          safeLog(`✅ İNTERNET GELDİ: ${bayId} otomatik olarak açılıyor...`);

          await rtdb.ref(`bays/${bayId}`).update({
            status: "available",
            isActive: true,
            autoOffline: null, // İşareti kaldırıyoruz
            updatedAt: admin.database.ServerValue.TIMESTAMP,
          });

          sendAdminAlert(bayId, "up"); // Düzelme maili at
        }
      }
    });
  } catch (error) {
    safeLog(`❌ Cron Job Hatası: ${error.message}`);
  }
});

// =========================================================
// 🚀 BAŞLATMA ZİNCİRİ (Render.com için ayarlandı)
// =========================================================
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

systemStartupClean().then(() => {
  app.listen(PORT, HOST, () => {
    safeLog(`🚀 QWash Sunucusu Başarıyla Başlatıldı!`);
    safeLog(`📡 API Portu: ${PORT}`);
  });
});
