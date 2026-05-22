require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const cron = require("node-cron");
const mqtt = require("mqtt");
const Iyzipay = require("iyzipay"); // 1. Iyzico Paketi Eklendi

const APP_BASE_URL = process.env.APP_BASE_URL;

if (!APP_BASE_URL) {
  throw new Error(
    "❌ APP_BASE_URL env eksik. Örn: https://qwash-****.onrender.com",
  );
}

// =========================================================
// IYZICO SANDBOX YAPILANDIRMASI
// =========================================================
const iyzipay = new Iyzipay({
  apiKey: process.env.IYZICO_API_KEY,
  secretKey: process.env.IYZICO_SECRET_KEY,
  uri: process.env.IYZICO_URI || "https://sandbox-api.iyzipay.com",
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

    const durationSec = Number(session.durationSec || 0);
    const startedAtMs =
      Number(session.startedAtMs || 0) ||
      (session.startedAt && typeof session.startedAt.toMillis === "function"
        ? session.startedAt.toMillis()
        : 0);

    const usedMs = startedAtMs > 0 ? Date.now() - startedAtMs : 0;
    const totalMs = durationSec > 0 ? durationSec * 1000 : 0;
    const usedRatio = totalMs > 0 ? usedMs / totalMs : 0;

    const noRefundAfterRatio = 0.8;

    if (
      reason !== "mqtt_start_failed" &&
      totalMs > 0 &&
      usedRatio >= noRefundAfterRatio
    ) {
      tx.update(sessionRef, {
        status: "ended",
        refunded: false,
        refundSkipped: true,
        refundSkippedReason: "usage_over_refund_limit",
        usedRatio,
        usedMs,
        totalMs,
        endedAt: admin.firestore.FieldValue.serverTimestamp(),
        endedReason: reason,
      });

      tx.set(db.collection("transactions").doc(), {
        type: "refund_skipped",
        status: "skipped",
        userId,
        sessionId,
        bayId: session.bayId || null,
        packageId: session.packageId || session.type || null,
        tokens: 0,
        originalTokensCost: tokensCost,
        reason,
        usedRatio,
        usedMs,
        totalMs,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        refunded: false,
        reason: "usage_over_refund_limit",
        usedRatio,
        usedMs,
        totalMs,
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
      usedRatio,
      usedMs,
      totalMs,
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
      usedRatio,
      usedMs,
      totalMs,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      refunded: true,
      userId,
      tokens: tokensCost,
      usedRatio,
      usedMs,
      totalMs,
    };
  });
};

const reserveBayForSession = async (bayId, uid) => {
  const bayRef = rtdb.ref(`bays/${bayId}`);

  const result = await bayRef.transaction((currentBay) => {
    if (!currentBay) {
      return;
    }

    const status = currentBay.status || "available";

    const canReserveFromAvailable =
      status === "available" &&
      !currentBay.currentSessionId &&
      currentBay.isActive !== false;

    const canReserveFromWaiting =
      status === "waiting" &&
      currentBay.lastUserId === uid &&
      !currentBay.currentSessionId &&
      currentBay.isActive !== false;

    if (!canReserveFromAvailable && !canReserveFromWaiting) {
      return;
    }

    return {
      ...currentBay,
      status: "starting",
      lastUserId: uid,
      startingAt: admin.database.ServerValue.TIMESTAMP,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    };
  });

  if (!result.committed) {
    return {
      success: false,
      reason: "bay_not_available",
    };
  }

  return {
    success: true,
    bayData: result.snapshot.val(),
  };
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

    if (!requestEmail) {
      safeLog("🚨 ADMIN GİRİŞ DENEMESİ: Token içinde e-posta yok.");

      return res.status(403).json({
        error: "Admin erişimi için e-posta bilgisi gerekli.",
      });
    }

    if (decodedToken.email_verified !== true) {
      safeLog(`🚨 DOĞRULANMAMIŞ ADMIN E-POSTASI DENEMESİ: ${requestEmail}`);

      return res.status(403).json({
        error: "Admin erişimi için e-posta adresinizi doğrulamanız gerekiyor.",
      });
    }

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
  const uid = req.user.uid;

  if (!bayId) {
    return res.status(400).json({ error: "bayId gerekli." });
  }

  try {
    const bayRef = rtdb.ref(`bays/${bayId}`);

    const result = await bayRef.transaction((currentBay) => {
      if (!currentBay) {
        return;
      }

      const status = currentBay.status || "available";

      if (
        status === "available" &&
        !currentBay.currentSessionId &&
        currentBay.isActive !== false
      ) {
        return {
          ...currentBay,
          status: "waiting",
          lastUserId: uid,
          hardwareSelection: "",
          updatedAt: admin.database.ServerValue.TIMESTAMP,
        };
      }

      if (
        status === "waiting" &&
        currentBay.lastUserId === uid &&
        !currentBay.currentSessionId &&
        currentBay.isActive !== false
      ) {
        return {
          ...currentBay,
          hardwareSelection: "",
          updatedAt: admin.database.ServerValue.TIMESTAMP,
        };
      }

      return;
    });

    if (!result.committed) {
      return res.status(409).json({
        error:
          "Peron şu anda başka bir kullanıcı tarafından kullanılıyor veya hazırlanıyor.",
      });
    }

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
  const uid = req.user.uid;
  const { bayId, packageId } = req.body;

  if (!bayId || !packageId) {
    return res.status(400).json({ error: "Eksik parametre gönderildi." });
  }

  let bayReserved = false;
  let newSessionId = null;
  let finalTokensCost = 0;
  let finalDurationSec = 0;

  try {
    const userRef = db.collection("users").doc(uid);
    const rtdbBayRef = rtdb.ref(`bays/${bayId}`);
    const packageRef = db.collection("packages").doc(packageId);

    // 1. Önce peronu atomik şekilde kilitle / rezerve et
    const reserveResult = await reserveBayForSession(bayId, uid);

    if (!reserveResult.success) {
      return res.status(409).json({
        error:
          "Peron şu anda başka bir kullanıcı tarafından kullanılıyor veya hazırlanıyor.",
      });
    }

    bayReserved = true;

    // 2. Sadece rezervasyonu alan istek jeton düşebilir ve session oluşturabilir
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);

      if (!userDoc.exists) {
        throw new Error("Kullanıcı_Bulunamadi");
      }

      const packageDoc = await t.get(packageRef);

      if (!packageDoc.exists) {
        throw new Error("Paket_Bulunamadi");
      }

      finalTokensCost = Number(packageDoc.data().tokensCost || 0);
      finalDurationSec = Number(packageDoc.data().durationSec || 0);

      if (finalTokensCost <= 0 || finalDurationSec <= 0) {
        throw new Error("Gecersiz_Paket_Degerleri");
      }

      if (userDoc.data().isBlocked === true) {
        throw new Error("Engellenmis_Kullanici");
      }

      const mevcutBakiye = Number(userDoc.data().walletTokens || 0);

      if (mevcutBakiye < finalTokensCost) {
        throw new Error("Yetersiz_Bakiye");
      }

      const sessionRef = db.collection("sessions").doc();
      newSessionId = sessionRef.id;

      t.update(userRef, {
        walletTokens: mevcutBakiye - finalTokensCost,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const startedAtMs = Date.now();
      const expectedEndTimeMs = startedAtMs + finalDurationSec * 1000;

      t.set(sessionRef, {
        bayId,
        userId: uid,
        type: packageId,
        packageId,
        tokensCost: finalTokensCost,
        durationSec: finalDurationSec,
        status: "running",
        startedAt: admin.firestore.Timestamp.fromMillis(startedAtMs),
        startedAtMs,
        expectedEndTime:
          admin.firestore.Timestamp.fromMillis(expectedEndTimeMs),
        expectedEndTimeMs,
      });
    });

    // 3. Peronu kesin olarak busy durumuna al
    await rtdbBayRef.update({
      status: "busy",
      requestedPackage: packageId,
      durationSec: finalDurationSec,
      tokensCost: finalTokensCost,
      lastUserId: uid,
      currentSessionId: newSessionId,
      hardwareSelection: "",
      startingAt: null,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    // 4. ESP32'ye MQTT komutu gönder
    const mqttOk = await safeSendBayCommand(
      bayId,
      `BUSY|${packageId}|${finalDurationSec}`,
    );

    // 5. MQTT başarısızsa jetonu iade et ve peronu waiting'e geri al
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
          `İade: ${
            refundResult.refunded
              ? `${refundResult.tokens} jeton`
              : refundResult.reason
          }`,
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
    // Session oluşmadan hata olduysa peron starting durumunda kalmasın
    if (bayReserved && !newSessionId) {
      try {
        await clearBaySessionFields(bayId, {
          status: "available",
        });

        await safeSendBayCommand(bayId, "AVAILABLE");
      } catch (rollbackError) {
        safeLog(`❌ Peron rollback hatası: ${rollbackError.message}`);
      }
    }

    if (error.message === "Engellenmis_Kullanici") {
      safeLog(
        `🚨 GÜVENLİK İHLALİ: Engelli kullanıcı (${uid}) işlem yapmayı denedi!`,
      );

      return res.status(403).json({
        error: "Hesabınız askıya alındığı için işlem yapamazsınız.",
      });
    }

    if (error.message === "Yetersiz_Bakiye") {
      return res.status(400).json({
        error: "Jeton bakiyeniz yetersiz.",
      });
    }

    if (error.message === "Paket_Bulunamadi") {
      return res.status(404).json({
        error: "İstenilen paket sistemde bulunamadı.",
      });
    }

    if (error.message === "Gecersiz_Paket_Degerleri") {
      return res.status(500).json({
        error: "Sistemdeki paket değerleri hatalı. Lütfen yöneticiye bildirin.",
      });
    }

    if (error.message === "Kullanıcı_Bulunamadi") {
      return res.status(404).json({
        error: "Kullanıcı bulunamadı.",
      });
    }

    safeLog(`❌ Başlatma hatası: ${error.message}`);

    return res.status(500).json({
      error: "Sunucu hatası.",
    });
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
        error:
          "Bu peronu iptal etme yetkiniz yok veya peron şu an iptal edilebilir durumda değil.",
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
  const uid = req.user.uid;

  if (!bayId || !sessionId) {
    return res.status(400).json({ error: "Eksik parametre." });
  }

  try {
    const sessionRef = db.collection("sessions").doc(sessionId);
    const bayRef = rtdb.ref(`bays/${bayId}`);

    const [sessionDoc, baySnap] = await Promise.all([
      sessionRef.get(),
      bayRef.once("value"),
    ]);

    if (!sessionDoc.exists) {
      return res.status(404).json({ error: "Oturum bulunamadı." });
    }

    if (!baySnap.exists()) {
      return res.status(404).json({ error: "Peron bulunamadı." });
    }

    const session = sessionDoc.data();
    const bayData = baySnap.val() || {};

    // 1) Session gerçekten bu kullanıcıya mı ait?
    if (session.userId !== uid) {
      safeLog(
        `🚨 YETKİSİZ OTURUM DURDURMA DENEMESİ: Saldırgan=${uid}, Session=${sessionId}, SessionUser=${session.userId || "yok"}`,
      );

      return res.status(403).json({
        error: "Bu oturumu durdurma yetkiniz yok.",
      });
    }

    // 2) İstekle gelen bayId, session içindeki bayId ile eşleşiyor mu?
    if (session.bayId !== bayId) {
      safeLog(
        `🚨 BAY/SESSION EŞLEŞME HATASI: User=${uid}, İstekBay=${bayId}, SessionBay=${session.bayId}, Session=${sessionId}`,
      );

      return res.status(400).json({
        error: "Oturum ve peron bilgisi eşleşmiyor.",
      });
    }

    // 3) Session hâlâ durdurulabilir durumda mı?
    if (session.status !== "running") {
      return res.status(409).json({
        error: "Bu oturum zaten aktif değil.",
      });
    }

    // 4) RTDB tarafında bu peronda gerçekten bu session mı aktif?
    if (bayData.currentSessionId !== sessionId) {
      safeLog(
        `🚨 AKTİF SESSION EŞLEŞMİYOR: User=${uid}, Bay=${bayId}, İstekSession=${sessionId}, BaySession=${bayData.currentSessionId || "yok"}`,
      );

      return res.status(409).json({
        error: "Bu peronda belirtilen oturum aktif değil.",
      });
    }

    // 5) RTDB tarafında son kullanıcı da aynı mı? Ek savunma katmanı.
    if (bayData.lastUserId !== uid) {
      safeLog(
        `🚨 BAY KULLANICI EŞLEŞMİYOR: User=${uid}, Bay=${bayId}, BayLastUser=${bayData.lastUserId || "yok"}`,
      );

      return res.status(403).json({
        error: "Bu peronu yönetme yetkiniz yok.",
      });
    }

    await sessionRef.update({
      status: "ended",
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
      endedReason: "user_stopped",
    });

    await clearBaySessionFields(bayId, {
      status: "waiting",
    });

    const mqttOk = await safeSendBayCommand(bayId, "WAITING");

    safeLog(
      `⛔ MANUEL DURDURMA BAŞARILI: User=${uid}, Bay=${bayId}, Session=${sessionId}`,
    );

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
  const uid = req.user.uid;
  const { tokens } = req.body;

  if (!tokens) {
    return res.status(400).json({
      error: "Eksik parametre gönderildi. tokens zorunludur.",
    });
  }

  const eklenecekJeton = Number(tokens);
  if (
    !Number.isFinite(eklenecekJeton) ||
    !Number.isInteger(eklenecekJeton) ||
    eklenecekJeton <= 0 ||
    eklenecekJeton > 100
  ) {
    return res.status(400).json({
      error: "Geçersiz jeton miktarı.",
    });
  }

  try {
    const jetonPackageDoc = await db.collection("packages").doc("jeton").get();

    if (!jetonPackageDoc.exists) {
      return res.status(500).json({
        error: "Jeton fiyat ayarı bulunamadı.",
      });
    }

    const jetonFiyat = Number(jetonPackageDoc.data().jetonFiyat || 0);

    if (!Number.isFinite(jetonFiyat) || jetonFiyat <= 0) {
      return res.status(500).json({
        error: "Jeton fiyat ayarı hatalı.",
      });
    }

    const eklenecekTutar = eklenecekJeton * jetonFiyat;
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Kullanıcı bulunamadı." });
    }

    if (userDoc.data().isBlocked === true) {
      return res.status(403).json({
        error: "Hesabınız askıya alındığı için bakiye yükleyemezsiniz.",
      });
    }

    const orderRef = db.collection("topupOrders").doc();

    await orderRef.set({
      userId: uid,
      tokens: eklenecekJeton,
      unitPriceTRY: jetonFiyat,
      amountTRY: eklenecekTutar,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const callbackUrl = `${APP_BASE_URL}/api/topup-callback?orderId=${orderRef.id}`;

    const iyzicoRequest = {
      locale: Iyzipay.LOCALE.TR,
      conversationId: orderRef.id,
      price: eklenecekTutar.toString(),
      paidPrice: eklenecekTutar.toString(),
      currency: Iyzipay.CURRENCY.TRY,
      installment: "1",
      basketId: orderRef.id,
      paymentChannel: Iyzipay.PAYMENT_CHANNEL.MOBILE,
      callbackUrl,

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
        zipCode: "34000",
      },

      shippingAddress: {
        contactName: "QWash Müşterisi",
        city: "Istanbul",
        country: "Turkey",
        address: "QWash Mobil Uygulaması",
        zipCode: "34000",
      },

      billingAddress: {
        contactName: "QWash Müşterisi",
        city: "Istanbul",
        country: "Turkey",
        address: "QWash Mobil Uygulaması",
        zipCode: "34000",
      },

      basketItems: [
        {
          id: "JETON_PK_" + eklenecekJeton,
          name: `${eklenecekJeton} Adet QWash Jetonu`,
          category1: "Uygulama İçi Satın Alma",
          itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL,
          price: eklenecekTutar.toString(),
        },
      ],
    };

    iyzipay.checkoutFormInitialize.create(
      iyzicoRequest,
      async (err, result) => {
        if (err || result.status === "failure") {
          await orderRef.update({
            status: "init_failed",
            errorMessage: result ? result.errorMessage : err.message,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          safeLog(
            `❌ Iyzico Form Başlatılamadı: ${
              result ? result.errorMessage : err.message
            }`,
          );

          return res.status(400).json({
            error: "Ödeme oturumu başlatılamadı.",
          });
        }

        await orderRef.update({
          iyzicoCheckoutToken: result.token || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(200).json({
          success: true,
          paymentUrl: result.paymentPageUrl,
        });
      },
    );
  } catch (error) {
    safeLog(`❌ Sunucu Ödeme Hatası: ${error.message}`);
    return res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---------------------------------------------------------
// 2. IYZICO GERİ DÖNÜŞ (CALLBACK) ENDPOINT'İ
// ---------------------------------------------------------
app.post("/api/topup-callback", async (req, res) => {
  const { token } = req.body;
  const { orderId } = req.query;

  if (!token || !orderId) {
    return res.status(400).send("<h1>Geçersiz İstek</h1>");
  }

  const orderRef = db.collection("topupOrders").doc(orderId);

  try {
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      safeLog(`🚨 Geçersiz ödeme callback orderId: ${orderId}`);
      return res.status(404).send("<h1>Sipariş bulunamadı.</h1>");
    }

    const order = orderDoc.data();

    if (order.status !== "pending") {
      safeLog(`ℹ️ Tekrarlanan callback engellendi. Order: ${orderId}`);

      return res.send(`
        <html lang="tr">
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
          <body style="text-align:center; padding-top:50px; font-family:sans-serif;">
            <h1>Bu ödeme daha önce işlendi.</h1>
            <p>Uygulamaya geri dönebilirsiniz.</p>
          </body>
        </html>
      `);
    }

    iyzipay.checkoutForm.retrieve(
      {
        locale: Iyzipay.LOCALE.TR,
        conversationId: orderId,
        token,
      },
      async (err, result) => {
        if (
          err ||
          result.status !== "success" ||
          result.paymentStatus !== "SUCCESS"
        ) {
          await orderRef.update({
            status: "failed",
            iyzicoStatus: result?.status || null,
            iyzicoPaymentStatus: result?.paymentStatus || null,
            errorMessage: result?.errorMessage || err?.message || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          safeLog(`❌ Ödeme Başarısız veya İptal Edildi. Order: ${orderId}`);

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
        if (result.conversationId !== orderId || result.basketId !== orderId) {
          await orderRef.update({
            status: "iyzico_order_mismatch",
            iyzicoConversationId: result.conversationId || null,
            iyzicoBasketId: result.basketId || null,
            paymentId: result.paymentId || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          safeLog(
            `🚨 IYZICO ORDER UYUŞMAZLIĞI: Order=${orderId}, Conversation=${result.conversationId}, Basket=${result.basketId}`,
          );

          return res.status(400).send(`
            <html lang="tr">
              <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
              <body style="text-align:center; padding-top:50px; font-family:sans-serif; background-color:#fff3f3;">
                <h1 style="color:#d9534f;">❌ Ödeme Doğrulanamadı!</h1>
                <p>Ödeme sipariş bilgileri sistemdeki kayıtla eşleşmedi.</p>
                <p>Lütfen destek ile iletişime geçin.</p>
              </body>
            </html>
          `);
        }

        const toKurus = (value) => Math.round(Number(value) * 100);

        const expectedAmount = Number(order.amountTRY);
        const paidPrice = Number(result.paidPrice);
        const expectedKurus = toKurus(order.amountTRY);
        const paidKurus = toKurus(result.paidPrice);

        if (
          !Number.isFinite(expectedAmount) ||
          !Number.isFinite(paidPrice) ||
          expectedKurus !== paidKurus
        ) {
          await orderRef.update({
            status: "amount_mismatch",
            expectedAmountTRY: expectedAmount,
            expectedKurus,
            iyzicoPaidPrice: result.paidPrice || null,
            iyzicoPaidKurus: paidKurus,
            paymentId: result.paymentId || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          safeLog(
            `🚨 IYZICO TUTAR UYUŞMAZLIĞI: Order=${orderId}, Expected=${expectedAmount}, Paid=${result.paidPrice}`,
          );

          return res.status(400).send(`
            <html lang="tr">
              <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
              <body style="text-align:center; padding-top:50px; font-family:sans-serif; background-color:#fff3f3;">
                <h1 style="color:#d9534f;">❌ Ödeme Doğrulanamadı!</h1>
                <p>Ödeme tutarı sistemdeki siparişle eşleşmedi.</p>
                <p>Lütfen destek ile iletişime geçin.</p>
              </body>
            </html>
          `);
        }

        try {
          await db.runTransaction(async (t) => {
            const freshOrderDoc = await t.get(orderRef);

            if (!freshOrderDoc.exists) {
              throw new Error("Order_Bulunamadi");
            }

            const freshOrder = freshOrderDoc.data();

            if (freshOrder.status !== "pending") {
              throw new Error("Order_Zaten_Islendi");
            }

            const userRef = db.collection("users").doc(freshOrder.userId);
            const userDoc = await t.get(userRef);

            if (!userDoc.exists) {
              throw new Error("Kullanici_Bulunamadi");
            }

            const tokensToAdd = Number(freshOrder.tokens);
            const amountTRY = Number(freshOrder.amountTRY);
            const mevcutBakiye = Number(userDoc.data().walletTokens || 0);

            t.update(userRef, {
              walletTokens: mevcutBakiye + tokensToAdd,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            t.update(orderRef, {
              status: "success",
              paymentId: result.paymentId || null,
              iyzicoPaidPrice: result.paidPrice || null,
              iyzicoPrice: result.price || null,
              iyzicoConversationId: result.conversationId || null,
              iyzicoBasketId: result.basketId || null,
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            t.set(db.collection("transactions").doc(), {
              type: "topup",
              status: "success",
              paymentId: result.paymentId || null,
              orderId,
              tokens: tokensToAdd,
              unitPriceTRY: amountTRY / tokensToAdd,
              amountTRY,
              userId: freshOrder.userId,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          });

          safeLog(
            `✅ CHECKOUT ÖDEMESİ BAŞARILI: Order=${orderId}, ${order.userId} -> ${order.tokens} jeton yüklendi.`,
          );

          return res.send(`
            <html lang="tr">
              <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
              <body style="text-align:center; padding-top:50px; font-family:sans-serif; background-color:#f4fbf7;">
                <h1 style="color:#5cb85c;">✅ Ödeme Başarılı!</h1>
                <p><b>${order.tokens} Jeton</b> hesabınıza başarıyla tanımlandı.</p>
                <p>Uygulamaya geri dönüp bakiyenizi kontrol edebilirsiniz.</p>
              </body>
            </html>
          `);
        } catch (dbError) {
          if (dbError.message === "Order_Zaten_Islendi") {
            return res.send(`
              <html lang="tr">
                <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
                <body style="text-align:center; padding-top:50px; font-family:sans-serif;">
                  <h1>Bu ödeme daha önce işlendi.</h1>
                  <p>Uygulamaya geri dönebilirsiniz.</p>
                </body>
              </html>
            `);
          }

          safeLog(`❌ Ödeme alındı ama DB yazma hatası: ${dbError.message}`);

          return res
            .status(500)
            .send(
              "<h1>Ödeme Alındı fakat bir veritabanı hatası oluştu. Lütfen destekle iletişime geçin.</h1>",
            );
        }
      },
    );
  } catch (error) {
    safeLog(`❌ Callback sunucu hatası: ${error.message}`);
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
    const allowedPatch = {};

    if (patch.status !== undefined) {
      const allowedStatuses = [
        "available",
        "waiting",
        "offline",
        "maintenance",
      ];

      if (!allowedStatuses.includes(patch.status)) {
        return res.status(400).json({
          error: "Geçersiz peron durumu.",
        });
      }

      allowedPatch.status = patch.status;
    }

    if (patch.isActive !== undefined) {
      if (typeof patch.isActive !== "boolean") {
        return res.status(400).json({
          error: "isActive boolean olmalıdır.",
        });
      }

      allowedPatch.isActive = patch.isActive;
    }

    if (Object.keys(allowedPatch).length === 0) {
      return res.status(400).json({
        error: "Güncellenecek geçerli alan yok.",
      });
    }

    const guncellemeVerisi = {
      ...allowedPatch,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    };

    if (
      allowedPatch.status === "available" ||
      allowedPatch.status === "offline"
    ) {
      guncellemeVerisi.currentSessionId = null;
      guncellemeVerisi.lastUserId = null;
      guncellemeVerisi.requestedPackage = null;
      guncellemeVerisi.durationSec = null;
      guncellemeVerisi.tokensCost = null;
      guncellemeVerisi.hardwareSelection = "";
    }

    await rtdb.ref(`bays/${bayId}`).update(guncellemeVerisi);

    let mqttOk = null;

    if (allowedPatch.status) {
      const statusCommandMap = {
        available: "AVAILABLE",
        waiting: "WAITING",
        offline: "OFFLINE",
        maintenance: "MAINTENANCE",
      };

      const command = statusCommandMap[allowedPatch.status];

      if (command) {
        mqttOk = await safeSendBayCommand(bayId, command);
      }
    }

    if (allowedPatch.isActive === true) {
      mqttOk = await safeSendBayCommand(bayId, "ACTIVE_ON");
    }

    if (allowedPatch.isActive === false) {
      mqttOk = await safeSendBayCommand(bayId, "ACTIVE_OFF");
    }

    safeLog(
      `🛠️ Peron Güncellendi: ${bayId} -> ${JSON.stringify(allowedPatch)}`,
    );

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
    const adet = Number(tokens);

    if (
      !Number.isFinite(adet) ||
      !Number.isInteger(adet) ||
      adet <= 0 ||
      adet > 10000
    ) {
      return res.status(400).json({
        error:
          "Geçerli bir jeton miktarı girin. Tek seferde en fazla 10000 jeton yüklenebilir.",
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
      for (const doc of runningSessions.docs) {
        const refundResult = await refundSessionIfNeeded(
          doc.id,
          "server_restart",
        );

        if (refundResult.refunded) {
          safeLog(
            `💸 SERVER RESTART İADESİ: Session=${doc.id}, User=${refundResult.userId}, ${refundResult.tokens} jeton iade edildi.`,
          );
        } else {
          safeLog(
            `ℹ️ SERVER RESTART sırasında iade yapılmadı: Session=${doc.id} - ${refundResult.reason}`,
          );
        }
      }
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
        bayUpdates[`bays/${bayId}/lastUserId`] = null;
        bayUpdates[`bays/${bayId}/requestedPackage`] = null;
        bayUpdates[`bays/${bayId}/durationSec`] = null;
        bayUpdates[`bays/${bayId}/tokensCost`] = null;
        bayUpdates[`bays/${bayId}/hardwareSelection`] = "";
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
          waitingUpdates[`bays/${bayId}/currentSessionId`] = null;
          waitingUpdates[`bays/${bayId}/lastUserId`] = null;
          waitingUpdates[`bays/${bayId}/requestedPackage`] = null;
          waitingUpdates[`bays/${bayId}/durationSec`] = null;
          waitingUpdates[`bays/${bayId}/tokensCost`] = null;
          waitingUpdates[`bays/${bayId}/hardwareSelection`] = "";
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
