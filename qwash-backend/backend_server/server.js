require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const cron = require("node-cron");
const mqtt = require("mqtt");
const Iyzipay = require("iyzipay"); // 1. Iyzico Paketi Eklendi

// =========================================================
// IYZICO SANDBOX YAPILANDIRMASI
// =========================================================
const iyzipay = new Iyzipay({
  apiKey: process.env.IYZICO_API_KEY,
  secretKey: process.env.IYZICO_SECRET_KEY,
  uri: process.env.IYZICO_URI || "https://sandbox-api.iyzipay.com"
});

// =========================================================
// FIREBASE SERVICE ACCOUNT
// =========================================================
const renderSecretPath = "/etc/secrets/serviceAccountKey.json";
const localSecretPath = path.join(__dirname, "serviceAccountKey.json");

let serviceAccountPath = null;

if (fs.existsSync(renderSecretPath)) {
  serviceAccountPath = renderSecretPath;
  console.log("✅ Render Secret File bulundu ve kullanılıyor.");
} else if (fs.existsSync(localSecretPath)) {
  serviceAccountPath = localSecretPath;
  console.log("✅ Lokal Secret File bulundu ve kullanılıyor.");
} else {
  throw new Error(
    `❌ Firebase serviceAccountKey.json bulunamadı.
Render için beklenen yol: ${renderSecretPath}
Local için beklenen yol: ${localSecretPath}`,
  );
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
// Iyzico'dan dönen form verilerini okuyabilmek için AŞAĞIDAKİ SATIRI EKLEYİN:
app.use(express.urlencoded({ extended: true }));


// =========================================================
// LOG
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
// MQTT
// =========================================================
const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_PORT = Number(process.env.MQTT_PORT || 8883);
const MQTT_USER = process.env.MQTT_USER;
const MQTT_PASS = process.env.MQTT_PASS;

if (!MQTT_HOST || !MQTT_USER || !MQTT_PASS) {
  throw new Error(
    "❌ MQTT env eksik: MQTT_HOST, MQTT_USER, MQTT_PASS gerekli.",
  );
}

const mqttUrl = `mqtts://${MQTT_HOST}:${MQTT_PORT}`;

const mqttClient = mqtt.connect(mqttUrl, {
  username: MQTT_USER,
  password: MQTT_PASS,
  reconnectPeriod: 3000,
  connectTimeout: 20000,
  clean: true,
});

const mqttTopic = {
  commands: (bayId) => `qwash/bays/${bayId}/commands`,
  status: (bayId) => `qwash/bays/${bayId}/status`,
  heartbeat: (bayId) => `qwash/bays/${bayId}/heartbeat`,
  selection: (bayId) => `qwash/bays/${bayId}/selection`,
};

const mqttPublish = (topic, payload, options = {}) => {
  return new Promise((resolve, reject) => {
    if (!mqttClient.connected) {
      return reject(new Error("MQTT broker bağlı değil."));
    }

    mqttClient.publish(topic, String(payload), options, (error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
};

const sendBayCommand = async (bayId, command) => {
  const topic = mqttTopic.commands(bayId);

  await mqttPublish(topic, command, {
    qos: 1,
    retain: false,
  });

  safeLog(`📡 MQTT KOMUT: ${bayId} -> ${command}`);
};

const safeSendBayCommand = async (bayId, command) => {
  try {
    await sendBayCommand(bayId, command);
    return true;
  } catch (error) {
    safeLog(
      `❌ MQTT komut gönderilemedi: ${bayId} -> ${command} | ${error.message}`,
    );
    return false;
  }
};

// =========================================================
// REFUND
// =========================================================
const refundSessionIfNeeded = async (sessionId, reason = "bay_power_loss") => {
  if (!sessionId) {
    return {
      refunded: false,
      reason: "no_session_id",
    };
  }

  const sessionRef = db.collection("sessions").doc(sessionId);

  return await db.runTransaction(async (tx) => {
    const sessionDoc = await tx.get(sessionRef);

    if (!sessionDoc.exists) {
      return {
        refunded: false,
        reason: "session_not_found",
      };
    }

    const session = sessionDoc.data();

    if (session.status !== "running") {
      return {
        refunded: false,
        reason: `session_not_running_${session.status}`,
      };
    }

    if (session.refunded === true) {
      return {
        refunded: false,
        reason: "already_refunded",
      };
    }

    const userId = session.userId;
    const tokensCost = Number(session.tokensCost || 0);

    if (!userId || tokensCost <= 0) {
      tx.update(sessionRef, {
        status: "ended",
        endedAt: admin.firestore.FieldValue.serverTimestamp(),
        endedReason: reason,
        refundError: "missing_user_or_tokens",
      });

      return {
        refunded: false,
        reason: "missing_user_or_tokens",
      };
    }

    const userRef = db.collection("users").doc(userId);
    const userDoc = await tx.get(userRef);

    if (!userDoc.exists) {
      tx.update(sessionRef, {
        status: "ended",
        endedAt: admin.firestore.FieldValue.serverTimestamp(),
        endedReason: reason,
        refundError: "user_not_found",
      });

      return {
        refunded: false,
        reason: "user_not_found",
      };
    }

    const currentWallet = Number(userDoc.data().walletTokens || 0);
    const newWallet = currentWallet + tokensCost;

    tx.update(userRef, {
      walletTokens: newWallet,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.update(sessionRef, {
      status: "refunded",
      refunded: true,
      refundedTokens: tokensCost,
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
      endedReason: reason,
    });

    tx.set(db.collection("transactions").doc(), {
      type: "refund",
      status: "success",
      userId,
      sessionId,
      bayId: session.bayId || null,
      packageId: session.packageId || session.type || null,
      tokens: tokensCost,
      amountTRY: null,
      reason,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      refunded: true,
      userId,
      tokens: tokensCost,
    };
  });
};

// =========================================================
// RTDB BAY TEMIZLIK
// =========================================================
const clearBaySessionFields = async (bayId, extraPatch = {}) => {
  await rtdb.ref(`bays/${bayId}`).update({
    currentSessionId: null,
    lastUserId: null,
    requestedPackage: null,
    durationSec: null,
    tokensCost: null,
    hardwareSelection: "",
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    ...extraPatch,
  });
};

// =========================================================
// MQTT EVENTS
// =========================================================
mqttClient.on("connect", () => {
  safeLog("✅ MQTT Broker bağlantısı başarılı.");

  mqttClient.subscribe("qwash/bays/+/status", { qos: 1 });
  mqttClient.subscribe("qwash/bays/+/heartbeat", { qos: 0 });
  mqttClient.subscribe("qwash/bays/+/selection", { qos: 1 });

  safeLog("📡 MQTT topic abonelikleri aktif.");
});

mqttClient.on("reconnect", () => {
  safeLog("🔄 MQTT yeniden bağlanıyor...");
});

mqttClient.on("error", (error) => {
  safeLog(`❌ MQTT hata: ${error.message}`);
});

mqttClient.on("close", () => {
  safeLog("⚠️ MQTT bağlantısı kapandı.");
});

mqttClient.on("message", async (topic, messageBuffer) => {
  const message = messageBuffer.toString();
  const parts = topic.split("/");

  if (parts.length !== 4 || parts[0] !== "qwash" || parts[1] !== "bays") {
    return;
  }

  const bayId = parts[2];
  const eventType = parts[3];

  try {
    if (eventType === "status") {
      await rtdb.ref(`bays/${bayId}`).update({
        status: message,
        isActive: message !== "offline",
        autoOffline: null,
        lastSeen: admin.database.ServerValue.TIMESTAMP,
        updatedAt: admin.database.ServerValue.TIMESTAMP,
      });

      safeLog(`📥 MQTT STATUS: ${bayId} -> ${message}`);
      return;
    }

    if (eventType === "heartbeat") {
      const bayRef = rtdb.ref(`bays/${bayId}`);
      const snap = await bayRef.once("value");
      const isBoot = message === "BOOT";

      if (!snap.exists()) {
        await bayRef.update({
          status: "available",
          isActive: true,
          autoOffline: null,
          currentSessionId: null,
          lastUserId: null,
          requestedPackage: null,
          hardwareSelection: "",
          durationSec: null,
          tokensCost: null,
          createdAt: admin.database.ServerValue.TIMESTAMP,
          updatedAt: admin.database.ServerValue.TIMESTAMP,
          lastSeen: admin.database.ServerValue.TIMESTAMP,
        });

        safeLog(`🆕 Yeni peron MQTT ile kaydedildi: ${bayId}`);
        return;
      }

      if (isBoot) {
        const bayData = snap.val() || {};

        if (bayData.currentSessionId) {
          const refundResult = await refundSessionIfNeeded(
            bayData.currentSessionId,
            "bay_reboot_during_session",
          );

          if (refundResult.refunded) {
            safeLog(
              `💸 BOOT İADESİ: ${bayId} yeniden başladı, ${refundResult.tokens} jeton iade edildi.`,
            );
          } else {
            safeLog(
              `ℹ️ BOOT sırasında iade yapılmadı: ${bayId} - ${refundResult.reason}`,
            );
          }
        }

        await clearBaySessionFields(bayId, {
          status: "available",
          isActive: true,
          autoOffline: null,
          lastSeen: admin.database.ServerValue.TIMESTAMP,
        });

        safeLog(
          `🔄 BOOT TEMİZLİĞİ: ${bayId} eski session alanları temizlendi.`,
        );
        return;
      }

      await bayRef.update({
        lastSeen: admin.database.ServerValue.TIMESTAMP,
        isActive: true,
        autoOffline: null,
        updatedAt: admin.database.ServerValue.TIMESTAMP,
      });

      safeLog(`💓 MQTT HEARTBEAT: ${bayId}`);
      return;
    }

    if (eventType === "selection") {
      await rtdb.ref(`bays/${bayId}`).update({
        hardwareSelection: message,
        updatedAt: admin.database.ServerValue.TIMESTAMP,
      });

      safeLog(`🧼 MQTT SEÇİM: ${bayId} -> ${message}`);
      return;
    }
  } catch (error) {
    safeLog(`❌ MQTT mesaj işleme hatası: ${error.message}`);
  }
});

// =========================================================
// AUTH MIDDLEWARE
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
        error:
          "Güvenlik ihlali: Başka bir kullanıcının adına işlem yapamazsınız!",
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
// HEALTH CHECK
// =========================================================
app.get("/", (req, res) => {
  return res.status(200).send("QWash API Sapasağlam Ayakta! 🚀");
});

// ---------------------------------------------------------
// QR OKUTULUNCA PERONU WAITING MODUNA AL
// ---------------------------------------------------------
app.post("/api/prepare-bay", verifyUser, async (req, res) => {
  const { bayId } = req.body;

  if (!bayId) {
    return res.status(400).json({ error: "bayId gerekli." });
  }

  try {
    const bayRef = rtdb.ref(`bays/${bayId}`);
    const baySnap = await bayRef.once("value");
    const bayData = baySnap.val();

    if (!bayData) {
      return res.status(404).json({
        error: "Peron bulunamadı.",
      });
    }

    if (bayData.status !== "available" && bayData.status !== "waiting") {
      return res.status(400).json({
        error: "Peron şu anda kullanılıyor.",
      });
    }

    await bayRef.update({
      status: "waiting",
      lastUserId: req.user.uid,
      hardwareSelection: "",
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    const mqttOk = await safeSendBayCommand(bayId, "WAITING");

    return res.status(200).json({
      success: true,
      mqttOk,
      message: mqttOk
        ? "Peron seçim ekranına alındı."
        : "Peron waiting yapıldı ama MQTT komutu gönderilemedi.",
    });
  } catch (error) {
    safeLog(`❌ Prepare Bay Hatası: ${error.message}`);

    return res.status(500).json({
      error: "Peron hazırlanırken sunucu hatası oluştu.",
    });
  }
});

// ---------------------------------------------------------
// OTURUM BAŞLATMA
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

    if (
      !bayData ||
      (bayData.status !== "available" && bayData.status !== "waiting")
    ) {
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
        expectedEndTime: admin.firestore.Timestamp.fromMillis(
          Date.now() + finalDurationSec * 1000,
        ),
      });
    });

    await rtdbBayRef.update({
      status: "busy",
      requestedPackage: packageId,
      durationSec: finalDurationSec,
      tokensCost: finalTokensCost,
      lastUserId: uid,
      currentSessionId: newSessionId,
      hardwareSelection: "",
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    const mqttOk = await safeSendBayCommand(
      bayId,
      `BUSY|${packageId}|${finalDurationSec}`,
    );

    if (!mqttOk) {
      const refundResult = await refundSessionIfNeeded(
        newSessionId,
        "mqtt_start_failed",
      );

      await clearBaySessionFields(bayId, {
        status: "waiting",
      });

      safeLog(
        `💸 MQTT BAŞLATMA HATASI: ${bayId} başlatılamadı. ` +
          `Session: ${newSessionId}. ` +
          `İade: ${refundResult.refunded ? `${refundResult.tokens} jeton` : refundResult.reason}`,
      );

      return res.status(503).json({
        success: false,
        mqttOk: false,
        refunded: refundResult.refunded,
        refundedTokens: refundResult.tokens || 0,
        sessionId: newSessionId,
        error: refundResult.refunded
          ? "Makine başlatılamadı. Kesilen jetonlar hesabınıza iade edildi."
          : "Makine başlatılamadı. İade işlemi kontrol edilmeli.",
      });
    }

    safeLog(
      `✅ BAŞARILI: ${bayId} başlatıldı. Süre: ${finalDurationSec} sn, Kesilen: ${finalTokensCost} jeton`,
    );

    return res.status(200).json({
      success: true,
      mqttOk: true,
      sessionId: newSessionId,
      message: "Makine başlatıldı.",
    });
  } catch (error) {
    if (error.message === "Engellenmis_Kullanici") {
      safeLog(
        `🚨 GÜVENLİK İHLALİ: Engelli kullanıcı (${uid}) işlem yapmayı denedi!`,
      );
      return res.status(403).json({
        error: "Hesabınız askıya alındığı için işlem yapamazsınız.",
      });
    }

    if (error.message === "Yetersiz_Bakiye") {
      return res.status(400).json({ error: "Jeton bakiyeniz yetersiz." });
    }

    if (error.message === "Paket_Bulunamadi") {
      return res
        .status(404)
        .json({ error: "İtenilen paket sistemde bulunamadı." });
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
// PERONDAN MANUEL ÇIKIŞ (İPTAL / CANCEL WAITING)
// ---------------------------------------------------------
app.post("/api/cancel-waiting", verifyUser, async (req, res) => {
  const { bayId } = req.body;

  if (!bayId) {
    return res.status(400).json({ error: "bayId gerekli." });
  }

  try {
    const bayRef = rtdb.ref(`bays/${bayId}`);
    const baySnap = await bayRef.once("value");
    const bayData = baySnap.val();

    if (!bayData) {
      return res.status(404).json({ error: "Peron bulunamadı." });
    }

    if (bayData.currentSessionId) {
      safeLog(
        `🚨 AKTİF SESSION VARKEN İPTAL DENEMESİ: ${req.user.uid}, Peron: ${bayId}`,
      );

      return res.status(409).json({
        error: "Aktif oturum varken peron iptal edilemez.",
      });
    }

    if (bayData.status !== "waiting" || bayData.lastUserId !== req.user.uid) {
      safeLog(`🚨 YETKİSİZ İPTAL DENEMESİ: ${req.user.uid}, Peron: ${bayId}`);

      return res.status(403).json({
        error: "Bu peronu iptal etme yetkiniz yok veya peron şu an iptal edilebilir durumda değil.",
      });
    }

    await clearBaySessionFields(bayId, {
      status: "available",
    });

    const mqttOk = await safeSendBayCommand(bayId, "AVAILABLE");

    return res.status(200).json({
      success: true,
      mqttOk,
      message: mqttOk
        ? "Peron başarıyla serbest bırakıldı."
        : "Peron veritabanında serbest bırakıldı ancak cihaza MQTT komutu gönderilemedi.",
    });
  } catch (error) {
    safeLog(`❌ Cancel Waiting Hatası: ${error.message}`);

    return res.status(500).json({
      error: "Sunucu hatası, işlem iptal edilemedi.",
    });
  }
});

// ---------------------------------------------------------
// OTURUMU MANUEL DURDURMA
// ---------------------------------------------------------
app.post("/api/stop-session", verifyUser, async (req, res) => {
  const { bayId, sessionId } = req.body;

  if (!bayId || !sessionId) {
    return res.status(400).json({ error: "Eksik parametre." });
  }

  try {
    const sessionRef = db.collection("sessions").doc(sessionId);

    await sessionRef.update({
      status: "ended",
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
      endedReason: "user_stopped",
    });

    await clearBaySessionFields(bayId, {
      status: "waiting",
    });

    const mqttOk = await safeSendBayCommand(bayId, "WAITING");

    safeLog(`⛔ MANUEL DURDURMA BAŞARILI: ${bayId} durduruldu.`);

    return res.status(200).json({
      success: true,
      mqttOk,
      message: "Oturum durduruldu.",
    });
  } catch (error) {
    safeLog(`❌ Durdurma hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 1. IYZICO CHECKOUT FORM BAŞLATMA ENDPOINT'İ
// ---------------------------------------------------------
app.post("/api/topup", verifyUser, async (req, res) => {
  const { uid, tokens, amountTRY } = req.body;

  if (!uid || !tokens || !amountTRY) {
    return res.status(400).json({ error: "Eksik parametre gönderildi. uid, tokens ve amountTRY zorunludur." });
  }

  const eklenecekJeton = parseInt(tokens, 10);
  const eklenecekTutar = Number(amountTRY);

  try {
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Kullanıcı bulunamadı." });
    }

    if (userDoc.data().isBlocked === true) {
      return res.status(403).json({ error: "Hesabınız askıya alındığı için bakiye yükleyemezsiniz." });
    }

    // Render üzerindeki canlı adresiniz
    const RENDER_URL = "https://qwash-8q4y.onrender.com";
    
    // Ödeme bitince Iyzico'nun verileri göndereceği geri dönüş adresi (Query parametresi ile yükleme detaylarını taşıyoruz)
    const callbackUrl = `${RENDER_URL}/api/topup-callback?uid=${uid}&tokens=${eklenecekJeton}&amount=${eklenecekTutar}`;

    const iyzicoRequest = {
      locale: Iyzipay.LOCALE.TR,
      conversationId: "QWASH_" + Date.now(),
      price: eklenecekTutar.toString(),
      paidPrice: eklenecekTutar.toString(),
      currency: Iyzipay.CURRENCY.TRY,
      installment: "1",
      basketId: "BASKET_" + Date.now(),
      paymentChannel: Iyzipay.PAYMENT_CHANNEL.MOBILE,
      // BURASI ÖNEMLİ: Checkout form başlatıyoruz
      callbackUrl: callbackUrl, 
      buyer: {
        id: uid,
        name: userDoc.data().ad || "QWash",
        surname: userDoc.data().soyad || "Müşterisi",
        gsmNumber: userDoc.data().telefon || "+905555555555",
        email: req.user.email || "user@qwash.com",
        identityNumber: "11111111111",
        lastLoginDate: "2026-01-01 12:00:00",
        registrationDate: "2026-01-01 12:00:00",
        registrationAddress: "QWash Mobil",
        ip: req.ip || "85.34.78.112",
        city: "Istanbul",
        country: "Turkey",
        zipCode: "34000"
      },
      shippingAddress: {
        contactName: "QWash Müşterisi",
        city: "Istanbul",
        country: "Turkey",
        address: "QWash Mobil Uygulaması",
        zipCode: "34000"
      },
      billingAddress: {
        contactName: "QWash Müşterisi",
        city: "Istanbul",
        country: "Turkey",
        address: "QWash Mobil Uygulaması",
        zipCode: "34000"
      },
      basketItems: [
        {
          id: "JETON_PK_" + eklenecekJeton,
          name: `${eklenecekJeton} Adet QWash Jetonu`,
          category1: 'Uygulama İçi Satın Alma',
          itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL,
          price: eklenecekTutar.toString()
        }
      ]
    };

    // Checkout form oluşturma çağrısı
    iyzipay.checkoutFormInitialize.create(iyzicoRequest, (err, result) => {
      if (err || result.status === "failure") {
        safeLog(`❌ Iyzico Form Başlatılamadı: ${result ? result.errorMessage : err.message}`);
        return res.status(400).json({ error: "Ödeme oturumu başlatılamadı." });
      }

      // Mobil uygulamaya açacağı sayfanın web linkini döndürüyoruz
      return res.status(200).json({
        success: true,
        paymentUrl: result.paymentPageUrl
      });
    });

  } catch (error) {
    safeLog(`❌ Sunucu Ödeme Hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 2. IYZICO GERİ DÖNÜŞ (CALLBACK) ENDPOINT'İ
// ---------------------------------------------------------
app.post("/api/topup-callback", async (req, res) => {
  // Iyzico arka planda bir 'token' POST eder
  const { token } = req.body;
  // URL'e iliştirdiğimiz yükleme bilgileri
  const { uid, tokens, amount } = req.query; 

  if (!token) {
    return res.status(400).send("<h1>Geçersiz İstek</h1>");
  }

  const eklenecekJeton = parseInt(tokens, 10);
  const eklenecekTutar = Number(amount);

  try {
    // Iyzico'ya bu token'ın sonucunu soruyoruz (Gerçekten ödedi mi?)
    iyzipay.checkoutForm.retrieve({
      locale: Iyzipay.LOCALE.TR,
      conversationId: "QWASH_CHECK_" + Date.now(),
      token: token
    }, async (err, result) => {
      
      if (err || result.status !== "success" || result.paymentStatus !== "SUCCESS") {
        safeLog(`❌ Ödeme Başarısız veya İptal Edildi. UID: ${uid}`);
        return res.send(`
          <html lang="tr">
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
            <body style="text-align:center; padding-top:50px; font-family:sans-serif; background-color:#fff3f3;">
              <h1 style="color:#d9534f;">❌ Ödeme Başarısız!</h1>
              <p>İşlem bankanız tarafından reddedildi veya iptal edildi.</p>
              <p>Uygulamaya güvenle geri dönebilirsiniz.</p>
            </body>
          </html>
        `);
      }

      // ÖDEME ONAYLANDI -> Jetonları Firestore'a yükle
      try {
        const userRef = db.collection("users").doc(uid);
        const txRef = db.collection("transactions").doc();

        await db.runTransaction(async (t) => {
          const txUserDoc = await t.get(userRef);
          const mevcutBakiye = Number(txUserDoc.data().walletTokens || 0);

          t.update(userRef, {
            walletTokens: mevcutBakiye + eklenecekJeton,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          t.set(txRef, {
            type: "topup",
            status: "success",
            paymentId: result.paymentId,
            tokens: eklenecekJeton,
            unitPriceTRY: eklenecekTutar / eklenecekJeton,
            amountTRY: eklenecekTutar,
            userId: uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        safeLog(`✅ CHECKOUT ÖDEMESİ BAŞARILI: ${uid} -> ${eklenecekJeton} jeton yüklendi.`);
        
        // Kullanıcı ekranda şık bir başarı mesajı görsün
        return res.send(`
          <html lang="tr">
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
            <body style="text-align:center; padding-top:50px; font-family:sans-serif; background-color:#f4fbf7;">
              <h1 style="color:#5cb85c;">✅ Ödeme Başarılı!</h1>
              <p><b>${eklenecekJeton} Jeton</b> hesabınıza başarıyla tanımlandı.</p>
              <p>Uygulamaya geri dönüp bakiyenizi kontrol edebilirsiniz.</p>
            </body>
          </html>
        `);

      } catch (dbError) {
        safeLog(`❌ Ödeme alındı ama DB yazma hatası: ${dbError.message}`);
        return res.status(500).send("<h1>Ödeme Alındı fakat bir veritabanı hatası oluştu. Lütfen destekle iletişime geçin.</h1>");
      }
    });

  } catch (error) {
    return res.status(500).send("<h1>Sunucu hatası oluştu.</h1>");
  }
});

// ---------------------------------------------------------
// ADMIN BAY LISTESI
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

// ---------------------------------------------------------
// ADMIN BAY UPDATE
// ---------------------------------------------------------
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
      guncellemeVerisi.currentSessionId = null;
      guncellemeVerisi.lastUserId = null;
      guncellemeVerisi.requestedPackage = null;
      guncellemeVerisi.durationSec = null;
      guncellemeVerisi.tokensCost = null;
      guncellemeVerisi.hardwareSelection = "";
    }

    await rtdb.ref(`bays/${bayId}`).update(guncellemeVerisi);

    let mqttOk = null;

    if (patch.status) {
      const statusCommandMap = {
        available: "AVAILABLE",
        waiting: "WAITING",
        offline: "OFFLINE",
        maintenance: "MAINTENANCE",
      };

      const command = statusCommandMap[patch.status];

      if (command) {
        mqttOk = await safeSendBayCommand(bayId, command);
      }
    }

    if (patch.isActive === true) {
      mqttOk = await safeSendBayCommand(bayId, "ACTIVE_ON");
    }

    if (patch.isActive === false) {
      mqttOk = await safeSendBayCommand(bayId, "ACTIVE_OFF");
    }

    safeLog(`🛠️ Peron Güncellendi: ${bayId} -> ${JSON.stringify(patch)}`);

    return res.status(200).json({
      success: true,
      mqttOk,
      message: "Peron güncellendi.",
    });
  } catch (error) {
    safeLog(`❌ Bay Güncelleme Hatası: ${error.message}`);

    if (res.headersSent) return;
    return res.status(500).json({ error: "Güncelleme başarısız." });
  }
});

// ---------------------------------------------------------
// ADMIN USER SEARCH
// ---------------------------------------------------------
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

    if (
      !queryVal.includes("@") &&
      !queryVal.includes(" ") &&
      queryVal.length >= 20
    ) {
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

// ---------------------------------------------------------
// ADMIN USER UPDATE
// ---------------------------------------------------------
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

// ---------------------------------------------------------
// ADMIN TOPUP
// ---------------------------------------------------------
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

    safeLog(
      `💰 ADMİN BAKİYE YÜKLEDİ: ${userId} kullanıcısına ${adet} jeton eklendi.`,
    );

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
// STARTUP CLEAN
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
        updates[`bays/${bayId}/currentSessionId`] = null;
        updates[`bays/${bayId}/requestedPackage`] = null;
        updates[`bays/${bayId}/durationSec`] = null;
        updates[`bays/${bayId}/tokensCost`] = null;
        updates[`bays/${bayId}/lastUserId`] = null;
        updates[`bays/${bayId}/hardwareSelection`] = "";
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
// MAIL
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
      `📧 E-Posta başarıyla gönderildi: ${
        type === "down" ? "Kopma" : "Düzelme"
      } bildirimi.`,
    );
  } catch (error) {
    safeLog(`❌ Mail API Bağlantı Hatası: ${error.message}`);
  }
};

// =========================================================
// CRON
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

    // 1. SÜRESİ DOLMUŞ RUNNING OTURUMLARI KAPAT
    const expiredSessions = await db
      .collection("sessions")
      .where("status", "==", "running")
      .where("expectedEndTime", "<=", admin.firestore.Timestamp.fromMillis(now))
      .get();

    if (!expiredSessions.empty) {
      const batch = db.batch();
      const bayUpdates = {};
      const mqttWaitingCommands = [];

      expiredSessions.forEach((doc) => {
        batch.update(doc.ref, {
          status: "ended",
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          endedReason: "time_up",
        });

        const bayId = doc.data().bayId;

        bayUpdates[`bays/${bayId}/status`] = "waiting";
        bayUpdates[`bays/${bayId}/currentSessionId`] = null;
        bayUpdates[`bays/${bayId}/requestedPackage`] = null;
        bayUpdates[`bays/${bayId}/durationSec`] = null;
        bayUpdates[`bays/${bayId}/tokensCost`] = null;
        bayUpdates[`bays/${bayId}/updatedAt`] =
          admin.database.ServerValue.TIMESTAMP;

        mqttWaitingCommands.push(bayId);

        safeLog(
          `🏁 [CRON] OTOMATİK KAPATMA: ${bayId} süresi doldu, bekleme moduna alındı.`,
        );
      });

      await batch.commit();

      if (Object.keys(bayUpdates).length > 0) {
        await rtdb.ref().update(bayUpdates);
      }

      mqttWaitingCommands.forEach((bayId) => {
        safeSendBayCommand(bayId, "WAITING");
      });
    }

    // 2. 60 SANİYEDİR WAITING OLANLARI AVAILABLE YAP
    const waitingBaysSnap = await rtdb
      .ref("bays")
      .orderByChild("status")
      .equalTo("waiting")
      .once("value");

    if (waitingBaysSnap.exists()) {
      const waitingBays = waitingBaysSnap.val();
      const waitingUpdates = {};
      const mqttAvailableCommands = [];

      for (const [bayId, bay] of Object.entries(waitingBays)) {
        if (bay.updatedAt && now - bay.updatedAt > 60000) {
          waitingUpdates[`bays/${bayId}/status`] = "available";
          waitingUpdates[`bays/${bayId}/updatedAt`] =
            admin.database.ServerValue.TIMESTAMP;
          mqttAvailableCommands.push(bayId);

          safeLog(
            `⏳ [CRON] ZAMAN AŞIMI: ${bayId} 60sn işlem yapılmadığı için boşa çıkarıldı.`,
          );
        }
      }

      if (Object.keys(waitingUpdates).length > 0) {
        await rtdb.ref().update(waitingUpdates);
      }

      mqttAvailableCommands.forEach((bayId) => {
        safeSendBayCommand(bayId, "AVAILABLE");
      });
    }

    // 3. HEARTBEAT KONTROLÜ - ELEKTRİK / BAĞLANTI KESİNTİSİ
    const timeoutMs = 2 * 60 * 1000;

    const deadBaysSnap = await rtdb
      .ref("bays")
      .orderByChild("lastSeen")
      .endAt(now - timeoutMs)
      .once("value");

    if (deadBaysSnap.exists()) {
      const deadBays = deadBaysSnap.val();

      for (const [bayId, bay] of Object.entries(deadBays)) {
        if (
          (bay.status === "offline" && !bay.autoOffline) ||
          bay.status === "maintenance"
        ) {
          continue;
        }

        if (bay.status !== "offline" || bay.autoOffline !== true) {
          safeLog(
            `⚠️ [CRON] KOPMA TESPİT EDİLDİ: ${bayId} otomatik kapatılıyor...`,
          );

          let refundResult = {
            refunded: false,
            reason: "no_active_session",
          };

          if (bay.currentSessionId) {
            refundResult = await refundSessionIfNeeded(
              bay.currentSessionId,
              "bay_power_loss",
            );

            if (refundResult.refunded) {
              safeLog(
                `💸 JETON İADESİ: ${bayId} elektrik/bağlantı kesintisi nedeniyle ${refundResult.tokens} jeton iade edildi.`,
              );
            } else {
              safeLog(`ℹ️ İade yapılmadı: ${bayId} - ${refundResult.reason}`);
            }
          }

          await clearBaySessionFields(bayId, {
            status: "offline",
            isActive: false,
            autoOffline: true,
          });

          await sendAdminAlert(bayId, "down");
        }
      }
    }

    // 4. BAĞLANTISI GERİ GELENLERİ AÇ
    const autoOfflineBaysSnap = await rtdb
      .ref("bays")
      .orderByChild("autoOffline")
      .equalTo(true)
      .once("value");

    if (autoOfflineBaysSnap.exists()) {
      const autoOfflineBays = autoOfflineBaysSnap.val();

      for (const [bayId, bay] of Object.entries(autoOfflineBays)) {
        if (bay.lastSeen && now - bay.lastSeen <= timeoutMs) {
          safeLog(
            `✅ [CRON] İNTERNET GELDİ: ${bayId} otomatik olarak açılıyor...`,
          );

          await clearBaySessionFields(bayId, {
            status: "available",
            isActive: true,
            autoOffline: null,
          });

          await safeSendBayCommand(bayId, "AVAILABLE");
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
// START
// =========================================================
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

systemStartupClean().then(() => {
  app.listen(PORT, HOST, () => {
    safeLog("🚀 QWash Sunucusu Başarıyla Başlatıldı!");
    safeLog(`📡 API Portu: ${PORT}`);
  });
});