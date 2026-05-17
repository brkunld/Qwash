require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const cron = require("node-cron");

// =========================================================
// 🔥 SERVICE ACCOUNT AYARLARI
// =========================================================
const renderSecretPath = "/etc/secrets/serviceAccountKey.json";
const localSecretPath = path.join(__dirname, "..", "..", "serviceAccountKey.json");

let serviceAccountPath;

if (fs.existsSync(renderSecretPath)) {
  serviceAccountPath = renderSecretPath;
  console.log("✅ Render Secret File bulundu ve kullanılıyor.");
} else {
  serviceAccountPath = localSecretPath;
  console.log("✅ Lokal Secret File kullanılıyor.");
}

const serviceAccount = require(serviceAccountPath);

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
// 🔥 LOG SİSTEMİ
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
// 🛡️ GÜVENLİK DUVARLARI
// =========================================================
const verifyUser = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    safeLog("🚨 YETKİSİZ ERİŞİM DENEMESİ: Kimlik tokenı gönderilmedi.");
    return res.status(401).json({
      error: "İşlem reddedildi: Giriş yapmanız gerekiyor.",
    });
  }

  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    return res.status(401).json({
      error: "Geçersiz token.",
    });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);

    if (req.body.uid && req.body.uid !== decodedToken.uid) {
      safeLog(
        `🚨 SAHTEKARLIK TESPİTİ! Kurban UID: ${req.body.uid}, Saldırgan: ${decodedToken.uid}`,
      );

      return res.status(403).json({
        error: "Güvenlik ihlali: Başka bir kullanıcının adına işlem yapamazsınız!",
      });
    }

    req.user = decodedToken;
    return next();
  } catch (error) {
    safeLog(`❌ Geçersiz Token: ${error.message}`);

    return res.status(401).json({
      error: "Geçersiz veya süresi dolmuş oturum.",
    });
  }
};

const verifyAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Yetkisiz erişim: Token bulunamadı.",
    });
  }

  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    return res.status(401).json({
      error: "Yetkisiz erişim: Token boş geldi.",
    });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);

    const authorizedEmails = process.env.AUTHORIZED_ADMINS
      ? process.env.AUTHORIZED_ADMINS.split(",")
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean)
      : [];

    const requestEmail = decodedToken.email
      ? decodedToken.email.trim().toLowerCase()
      : "";

    if (!authorizedEmails.includes(requestEmail)) {
      safeLog(`🚨 YETKİSİZ GİRİŞ DENEMESİ: ${requestEmail}`);

      return res.status(403).json({
        error: "Bu panele erişim yetkiniz yok!",
      });
    }

    req.admin = decodedToken;
    return next();
  } catch (error) {
    safeLog(`❌ ADMIN TOKEN HATASI: ${error.message}`);

    return res.status(401).json({
      error: "Oturum geçersiz.",
    });
  }
};

// =========================================================
// 🔥 UPTIMEROBOT / HEALTH CHECK
// =========================================================
app.get("/", (req, res) => {
  return res.status(200).send("QWash API Sapasağlam Ayakta! 🚀");
});


// ---------------------------------------------------------
// 1. OTURUM BAŞLATMA API'Sİ
// ---------------------------------------------------------
app.post("/api/start-session", verifyUser, async (req, res) => {
  const { uid, bayId, packageId } = req.body;

  if (!uid || !bayId || !packageId) {
    return res.status(400).json({ error: "Eksik parametre gönderildi." });
  }

  try {
    const userRef = db.collection("users").doc(uid);
    const rtdbBayRef = rtdb.ref(`bays/${bayId}`);
    const packageRef = db.collection("packages").doc(packageId);

    let newSessionId = null;
    let finalTokensCost = 0;
    let finalDurationSec = 0;

    const baySnap = await rtdbBayRef.once("value");
    const bayData = baySnap.val();

    if (!bayData || (bayData.status !== "available" && bayData.status !== "waiting")) {
      return res.status(400).json({ error: "Peron şu anda kullanılıyor." });
    }

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("Kullanıcı_Bulunamadi");

      const packageDoc = await t.get(packageRef);
      if (!packageDoc.exists) throw new Error("Paket_Bulunamadi");

      finalTokensCost = Number(packageDoc.data().tokensCost || 0);
      finalDurationSec = Number(packageDoc.data().durationSec || 0);

      if (finalTokensCost <= 0 || finalDurationSec <= 0) {
        throw new Error("Gecersiz_Paket_Degerleri");
      }

      if (userDoc.data().isBlocked === true) {
        throw new Error("Engellenmis_Kullanici");
      }

      const mevcutBakiye = Number(userDoc.data().walletTokens || 0);
      if (mevcutBakiye < finalTokensCost) throw new Error("Yetersiz_Bakiye");

      const sessionRef = db.collection("sessions").doc();
      newSessionId = sessionRef.id;

      t.update(userRef, {
        walletTokens: mevcutBakiye - finalTokensCost,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      t.set(sessionRef, {
        bayId,
        userId: uid,
        type: packageId,
        packageId,
        tokensCost: finalTokensCost,
        durationSec: finalDurationSec,
        status: "running",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        // 🔥 YENİ: Makinenin bitiş zamanını Firestore'a yazıyoruz
        expectedEndTime: admin.firestore.Timestamp.fromMillis(Date.now() + (finalDurationSec * 1000))
      });
    });

    await rtdbBayRef.update({
      status: "busy",
      requestedPackage: packageId,
      durationSec: finalDurationSec,
      tokensCost: finalTokensCost,
      lastUserId: uid,
      currentSessionId: newSessionId,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    safeLog(
      `✅ BAŞARILI: ${bayId} başlatıldı. Süre: ${finalDurationSec} sn, Kesilen: ${finalTokensCost} jeton`,
    );

    return res.status(200).json({
      success: true,
      message: "Makine başlatıldı.",
    });
  } catch (error) {
    if (error.message === "Engellenmis_Kullanici") {
      safeLog(`🚨 GÜVENLİK İHLALİ: Engelli kullanıcı (${uid}) işlem yapmayı denedi!`);
      return res.status(403).json({
        error: "Hesabınız askıya alındığı için işlem yapamazsınız.",
      });
    }

    if (error.message === "Yetersiz_Bakiye") {
      return res.status(400).json({ error: "Jeton bakiyeniz yetersiz." });
    }

    if (error.message === "Paket_Bulunamadi") {
      return res.status(404).json({ error: "İstenilen paket sistemde bulunamadı." });
    }

    if (error.message === "Gecersiz_Paket_Degerleri") {
      return res.status(500).json({
        error: "Sistemdeki paket değerleri hatalı. Lütfen yöneticiye bildirin.",
      });
    }

    safeLog(`❌ Başlatma hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 2. OTURUMU MANUEL DURDURMA API'Sİ
// ---------------------------------------------------------
app.post("/api/stop-session", verifyUser, async (req, res) => {
  const { bayId, sessionId } = req.body;

  if (!bayId || !sessionId) {
    return res.status(400).json({ error: "Eksik parametre." });
  }

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

    return res.status(200).json({
      success: true,
      message: "Oturum durduruldu.",
    });
  } catch (error) {
    safeLog(`❌ Durdurma hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 3. MÜŞTERİ BAKİYE YÜKLEME API'Sİ
// ---------------------------------------------------------
app.post("/api/topup", verifyUser, async (req, res) => {
  const { uid, tokens, amountTRY, kartNo } = req.body;

  if (!uid || !tokens || !amountTRY) {
    return res.status(400).json({ error: "Eksik parametre." });
  }

  if (!kartNo || kartNo.length < 12) {
    return res.status(400).json({ error: "Geçersiz Kart Numarası" });
  }

  const eklenecekJeton = parseInt(tokens, 10);
  const eklenecekTutar = Number(amountTRY);

  if (!Number.isFinite(eklenecekJeton) || eklenecekJeton <= 0) {
    return res.status(400).json({
      error: "Geçersiz jeton miktarı! Sistem manipülasyonu engellendi.",
    });
  }

  if (!Number.isFinite(eklenecekTutar) || eklenecekTutar <= 0) {
    return res.status(400).json({ error: "Geçersiz ödeme tutarı!" });
  }

  try {
    const userRef = db.collection("users").doc(uid);
    const txRef = db.collection("transactions").doc();

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("Kullanıcı_Bulunamadi");

      if (userDoc.data().isBlocked === true) {
        throw new Error("Engellenmis_Kullanici");
      }

      const mevcutBakiye = Number(userDoc.data().walletTokens || 0);

      t.update(userRef, {
        walletTokens: mevcutBakiye + eklenecekJeton,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      t.set(txRef, {
        type: "topup",
        status: "success",
        tokens: eklenecekJeton,
        unitPriceTRY: eklenecekTutar / eklenecekJeton,
        amountTRY: eklenecekTutar,
        userId: uid,
        adminId: null,
        bayId: null,
        packageId: null,
        sessionId: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    safeLog(`✅ MÜŞTERİ ÖDEMESİ BAŞARILI: ${uid} -> ${eklenecekJeton} jeton eklendi.`);

    return res.status(200).json({
      success: true,
      message: "Bakiye başarıyla yüklendi.",
    });
  } catch (error) {
    safeLog(`❌ Müşteri ödeme hatası: ${error.message}`);

    if (error.message === "Engellenmis_Kullanici") {
      return res.status(403).json({
        error: "Hesabınız askıya alındığı için bakiye yükleyemezsiniz.",
      });
    }

    return res.status(500).json({
      error: "Sunucu hatası, yükleme yapılamadı.",
    });
  }
});

// ---------------------------------------------------------
// 4. ADMİN PANELİ API'LERİ
// ---------------------------------------------------------
app.get("/api/admin/bays", verifyAdmin, async (req, res) => {
  try {
    const snapshot = await rtdb.ref("bays").once("value");

    if (!snapshot.exists()) {
      return res.status(200).json({ bays: [] });
    }

    const data = snapshot.val();
    const bayListesi = Object.keys(data)
      .map((key) => ({ id: key, ...data[key] }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return res.status(200).json({ bays: bayListesi });
  } catch (error) {
    safeLog(`❌ Admin Bay Listesi Hatası: ${error.message}`);

    if (res.headersSent) return;
    return res.status(500).json({ error: "Bay listesi alınamadı." });
  }
});

app.post("/api/admin/update-bay", verifyAdmin, async (req, res) => {
  const { bayId, patch } = req.body;

  if (!bayId || !patch) {
    return res.status(400).json({ error: "Eksik parametre." });
  }

  try {
    const guncellemeVerisi = {
      ...patch,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    };

    if (patch.status === "available" || patch.status === "offline") {
      guncellemeVerisi.currentSessionId = "";
      guncellemeVerisi.lastUserId = "";
      guncellemeVerisi.requestedPackage = null;
      guncellemeVerisi.durationSec = null;
      guncellemeVerisi.tokensCost = null;
    }

    await rtdb.ref(`bays/${bayId}`).update(guncellemeVerisi);

    safeLog(`🛠️ Peron Güncellendi: ${bayId} -> ${JSON.stringify(patch)}`);

    return res.status(200).json({
      success: true,
      message: "Peron güncellendi.",
    });
  } catch (error) {
    safeLog(`❌ Bay Güncelleme Hatası: ${error.message}`);

    if (res.headersSent) return;
    return res.status(500).json({ error: "Güncelleme başarısız." });
  }
});

app.post("/api/admin/search-user", verifyAdmin, async (req, res) => {
  const { arama } = req.body;

  if (!arama) {
    return res.status(400).json({ error: "Arama terimi boş olamaz." });
  }

  try {
    const queryVal = arama.trim();

    if (!queryVal) {
      return res.status(400).json({ error: "Arama terimi boş olamaz." });
    }

    if (!queryVal.includes("@") && !queryVal.includes(" ") && queryVal.length >= 20) {
      const uidSnap = await db.collection("users").doc(queryVal).get();

      if (uidSnap.exists) {
        return res.status(200).json({
          user: { id: uidSnap.id, ...uidSnap.data() },
        });
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

        return res.status(200).json({
          user: { id: doc.id, ...doc.data() },
        });
      }
    }

    const telSnap = await db
      .collection("users")
      .where("telefon", "==", queryVal)
      .limit(1)
      .get();

    if (!telSnap.empty) {
      const doc = telSnap.docs[0];

      return res.status(200).json({
        user: { id: doc.id, ...doc.data() },
      });
    }

    return res.status(404).json({
      error: "Eşleşen kullanıcı bulunamadı.",
    });
  } catch (error) {
    safeLog(`❌ Kullanıcı Arama Hatası: ${error.message}`);

    if (res.headersSent) return;
    return res.status(500).json({
      error: "Arama sırasında hata oluştu.",
    });
  }
});

app.post("/api/admin/update-user", verifyAdmin, async (req, res) => {
  const { userId, patch } = req.body;

  if (!userId || !patch) {
    return res.status(400).json({ error: "Eksik parametre gönderildi." });
  }

  try {
    await db.collection("users").doc(userId).update({
      isBlocked: patch.isBlocked,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const islemTipi = patch.isBlocked ? "Engellendi" : "Engeli Kaldırıldı";
    safeLog(`🛡️ KULLANICI İŞLEMİ: ${userId} -> ${islemTipi}`);

    return res.status(200).json({
      success: true,
      message: "Kullanıcı durumu güncellendi.",
    });
  } catch (error) {
    safeLog(`❌ Kullanıcı Güncelleme Hatası: ${error.message}`);

    if (res.headersSent) return;
    return res.status(500).json({
      error: "Kullanıcı güncellenirken sunucu hatası oluştu.",
    });
  }
});

app.post("/api/admin/topup", verifyAdmin, async (req, res) => {
  const { userId, tokens } = req.body;

  if (!userId || !tokens) {
    return res.status(400).json({
      error: "Kullanıcı ID ve Jeton miktarı gerekli.",
    });
  }

  try {
    const adet = parseInt(tokens, 10);

    if (!Number.isFinite(adet) || adet <= 0) {
      return res.status(400).json({
        error: "Geçerli bir jeton miktarı girin.",
      });
    }

    const snap = await db.collection("packages").doc("jeton").get();
    const jetonFiyat = snap.exists ? Number(snap.data().jetonFiyat || 0) : 0;

    if (jetonFiyat <= 0) {
      return res.status(500).json({
        error: "Sistemde jeton fiyatı bulunamadı.",
      });
    }

    const amountTRY = adet * jetonFiyat;
    const userRef = db.collection("users").doc(userId);

    await db.runTransaction(async (tx) => {
      const uDoc = await tx.get(userRef);
      if (!uDoc.exists) throw new Error("Kullanıcı_Bulunamadi");

      const yeniBakiye = Number(uDoc.data().walletTokens || 0) + adet;

      tx.update(userRef, {
        walletTokens: yeniBakiye,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(db.collection("transactions").doc(), {
        userId,
        type: "admin_topup",
        tokens: adet,
        amountTRY,
        unitPriceTRY: jetonFiyat,
        bayId: null,
        packageId: null,
        status: "success",
        adminId: req.admin?.uid || req.admin?.email || "ELECTRON_ADMIN",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    safeLog(`💰 ADMİN BAKİYE YÜKLEDİ: ${userId} kullanıcısına ${adet} jeton eklendi.`);

    return res.status(200).json({
      success: true,
      tokensAdded: adet,
      amountTRY,
    });
  } catch (error) {
    safeLog(`❌ Admin Bakiye Yükleme Hatası: ${error.message}`);

    if (error.message === "Kullanıcı_Bulunamadi") {
      return res.status(404).json({ error: "Kullanıcı dokümanı bulunamadı." });
    }

    if (res.headersSent) return;
    return res.status(500).json({ error: "Bakiye yükleme başarısız oldu." });
  }
});

// =========================================================
// 🔥 SUNUCU AYAĞA KALKARKEN TEMİZLİK
// =========================================================
const systemStartupClean = async () => {
  try {
    safeLog("🔄 Veritabanı temizliği yapılıyor...");

    const baysSnap = await rtdb.ref("bays").once("value");

    if (baysSnap.exists()) {
      const updates = {};
      const bays = baysSnap.val();

      Object.keys(bays).forEach((bayId) => {
        updates[`bays/${bayId}/status`] = "available";
        updates[`bays/${bayId}/isActive`] = true;
        updates[`bays/${bayId}/autoOffline`] = null;
        updates[`bays/${bayId}/currentSessionId`] = "";
        updates[`bays/${bayId}/requestedPackage`] = null;
        updates[`bays/${bayId}/durationSec`] = null;
        updates[`bays/${bayId}/tokensCost`] = null;
        updates[`bays/${bayId}/lastUserId`] = null;
        updates[`bays/${bayId}/updatedAt`] = admin.database.ServerValue.TIMESTAMP;
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
// 🔥 MAIL GÖNDERME - BREVO HTTP API
// =========================================================
const mailCooldown = {};
const MAIL_COOLDOWN_MS = 10 * 60 * 1000;

const sendAdminAlert = async (bayId, type) => {
  const cooldownKey = `${bayId}_${type}`;
  const lastSent = mailCooldown[cooldownKey] || 0;

  if (Date.now() - lastSent < MAIL_COOLDOWN_MS) {
    safeLog(`📧 Mail atlandı: ${bayId} ${type} bildirimi cooldown içinde.`);
    return;
  }

  mailCooldown[cooldownKey] = Date.now();

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
      `📧 E-Posta başarıyla gönderildi: ${type === "down" ? "Kopma" : "Düzelme"} bildirimi.`,
    );
  } catch (error) {
    safeLog(`❌ Mail API Bağlantı Hatası: ${error.message}`);
  }
};

// =========================================================
// 🔥 TEKİL VE OPTİMİZE EDİLMİŞ CRON JOB (SÜPER CRON)
// =========================================================
let isHeartbeatCronRunning = false;

cron.schedule("* * * * *", async () => {
  if (isHeartbeatCronRunning) {
    safeLog("⏭️ [CRON] Önceki kontrol hâlâ çalışıyor, bu tur atlandı.");
    return;
  }

  isHeartbeatCronRunning = true;
  safeLog("🔍 [CRON] Sistem kontrolü çalışıyor...");

  try {
    const now = Date.now();

    // ---------------------------------------------------------
    // 1. SÜRESİ DOLMUŞ "RUNNING" OTURUMLARI KAPAT
    // ---------------------------------------------------------
    const expiredSessions = await db.collection("sessions")
      .where("status", "==", "running")
      .where("expectedEndTime", "<=", admin.firestore.Timestamp.fromMillis(now))
      .get();

    if (!expiredSessions.empty) {
      const batch = db.batch();
      const bayUpdates = {};

      expiredSessions.forEach((doc) => {
        batch.update(doc.ref, {
          status: "ended",
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          endedReason: "time_up",
        });

        const bayId = doc.data().bayId;
        bayUpdates[`bays/${bayId}/status`] = "waiting";
        bayUpdates[`bays/${bayId}/currentSessionId`] = "";
        bayUpdates[`bays/${bayId}/requestedPackage`] = null;
        bayUpdates[`bays/${bayId}/durationSec`] = null;
        bayUpdates[`bays/${bayId}/tokensCost`] = null;
        bayUpdates[`bays/${bayId}/updatedAt`] = admin.database.ServerValue.TIMESTAMP;

        safeLog(`🏁 [CRON] OTOMATİK KAPATMA: ${bayId} süresi doldu, bekleme moduna alındı.`);
      });

      await batch.commit();
      if (Object.keys(bayUpdates).length > 0) {
        await rtdb.ref().update(bayUpdates);
      }
    }

    // ---------------------------------------------------------
    // 2. 60 SANİYEDİR "WAITING" DURUMUNDA OLANLARI TEMİZLE
    // ---------------------------------------------------------
    const waitingBaysSnap = await rtdb.ref("bays")
      .orderByChild("status")
      .equalTo("waiting")
      .once("value");

    if (waitingBaysSnap.exists()) {
      const waitingBays = waitingBaysSnap.val();
      const waitingUpdates = {};

      for (const [bayId, bay] of Object.entries(waitingBays)) {
        if (bay.updatedAt && (now - bay.updatedAt > 60000)) {
          waitingUpdates[`bays/${bayId}/status`] = "available";
          waitingUpdates[`bays/${bayId}/updatedAt`] = admin.database.ServerValue.TIMESTAMP;
          safeLog(`⏳ [CRON] ZAMAN AŞIMI: ${bayId} 60sn işlem yapılmadığı için boşa çıkarıldı.`);
        }
      }

      if (Object.keys(waitingUpdates).length > 0) {
        await rtdb.ref().update(waitingUpdates);
      }
    }

    // ---------------------------------------------------------
    // 3. NABIZ KONTROLÜ - SADECE KOPANLARI ÇEK
    // ---------------------------------------------------------
    const timeoutMs = 2 * 60 * 1000;
    
    // Son görülmesi 2 dakikadan eski olanları bul
    const deadBaysSnap = await rtdb.ref("bays")
      .orderByChild("lastSeen")
      .endAt(now - timeoutMs)
      .once("value");

    if (deadBaysSnap.exists()) {
      const deadBays = deadBaysSnap.val();
      for (const [bayId, bay] of Object.entries(deadBays)) {
        if ((bay.status === "offline" && !bay.autoOffline) || bay.status === "maintenance") {
          continue;
        }

        if (bay.status !== "offline" || bay.autoOffline !== true) {
          safeLog(`⚠️ [CRON] KOPMA TESPİT EDİLDİ: ${bayId} otomatik kapatılıyor...`);
          await rtdb.ref(`bays/${bayId}`).update({
            status: "offline",
            isActive: false,
            autoOffline: true,
            updatedAt: admin.database.ServerValue.TIMESTAMP,
          });
          await sendAdminAlert(bayId, "down");
        }
      }
    }

    // ---------------------------------------------------------
    // 4. BAĞLANTISI GERİ GELENLERİ BUL VE AÇ
    // ---------------------------------------------------------
    const autoOfflineBaysSnap = await rtdb.ref("bays")
      .orderByChild("autoOffline")
      .equalTo(true)
      .once("value");

    if (autoOfflineBaysSnap.exists()) {
      const autoOfflineBays = autoOfflineBaysSnap.val();
      for (const [bayId, bay] of Object.entries(autoOfflineBays)) {
        if (bay.lastSeen && (now - bay.lastSeen <= timeoutMs)) {
          safeLog(`✅ [CRON] İNTERNET GELDİ: ${bayId} otomatik olarak açılıyor...`);
          await rtdb.ref(`bays/${bayId}`).update({
            status: "available",
            isActive: true,
            autoOffline: null,
            updatedAt: admin.database.ServerValue.TIMESTAMP,
          });
          await sendAdminAlert(bayId, "up");
        }
      }
    }

  } catch (error) {
    safeLog(`❌ Cron Job Hatası: ${error.message}`);
  } finally {
    isHeartbeatCronRunning = false;
  }
});

// =========================================================
// 🚀 BAŞLATMA
// =========================================================
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

systemStartupClean().then(() => {
  app.listen(PORT, HOST, () => {
    safeLog("🚀 QWash Sunucusu Başarıyla Başlatıldı!");
    safeLog(`📡 API Portu: ${PORT}`);
  });
});