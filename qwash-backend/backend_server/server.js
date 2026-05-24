require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const cron = require("node-cron");
const mqtt = require("mqtt");
const Iyzipay = require("iyzipay");
const { z } = require("zod");
const rateLimit = require("express-rate-limit");

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 dakika
  max: 30, // IP başına 1 dakikada max 30 istek
  message: { error: "Çok fazla istek attınız, lütfen biraz bekleyin." },
});

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

let server = null;
let isShuttingDown = false;
let cronTask = null;

app.set("trust proxy", 1);

app.use(cors());
app.use("/api/", (req, res, next) => {
  // İyzico webhook'unu rate limit engeline takılmaması için muaf tutuyoruz
  if (req.path === "/topup-callback") {
    return next();
  }
  return apiLimiter(req, res, next);
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  if (isShuttingDown) {
    return res.status(503).json({
      error:
        "Sunucu yeniden başlatılıyor. Lütfen birkaç saniye sonra tekrar deneyin.",
    });
  }

  return next();
});

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

const EXTERNAL_TIMEOUT_MS = Number(process.env.EXTERNAL_TIMEOUT_MS || 10000);
const BREVO_TIMEOUT_MS = Number(process.env.BREVO_TIMEOUT_MS || 5000);
const IYZICO_TIMEOUT_MS = Number(process.env.IYZICO_TIMEOUT_MS || 10000);
const MQTT_PUBLISH_TIMEOUT_MS = Number(
  process.env.MQTT_PUBLISH_TIMEOUT_MS || 5000,
);

const withTimeout = (promise, timeoutMs, label) => {
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} zaman aşımına uğradı.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
};

const fetchWithTimeout = async (
  url,
  options = {},
  timeoutMs = EXTERNAL_TIMEOUT_MS,
) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

const initializeIyzicoCheckoutForm = (request) => {
  return withTimeout(
    new Promise((resolve, reject) => {
      iyzipay.checkoutFormInitialize.create(request, (err, result) => {
        if (err) return reject(err);
        return resolve(result);
      });
    }),
    IYZICO_TIMEOUT_MS,
    "Iyzico checkout initialize",
  );
};

const retrieveIyzicoCheckoutForm = (request) => {
  return withTimeout(
    new Promise((resolve, reject) => {
      iyzipay.checkoutForm.retrieve(request, (err, result) => {
        if (err) return reject(err);
        return resolve(result);
      });
    }),
    IYZICO_TIMEOUT_MS,
    "Iyzico checkout retrieve",
  );
};

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

const MQTT_CLIENT_ID =
  process.env.MQTT_CLIENT_ID ||
  `qwash_backend_${process.env.RENDER_INSTANCE_ID || process.pid}_${Date.now()}`;

const mqttClient = mqtt.connect(mqttUrl, {
  clientId: MQTT_CLIENT_ID,
  username: MQTT_USER,
  password: MQTT_PASS,
  reconnectPeriod: 3000,
  connectTimeout: 20000,
  clean: true,
  queueQoSZero: false,
});

const mqttTopic = {
  commands: (bayId) => `qwash/bays/${bayId}/commands`,
  status: (bayId) => `qwash/bays/${bayId}/status`,
  heartbeat: (bayId) => `qwash/bays/${bayId}/heartbeat`,
  selection: (bayId) => `qwash/bays/${bayId}/selection`,
  event: (bayId) => `qwash/bays/${bayId}/event`,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForMqttConnected = async (timeoutMs = 3000) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (mqttClient.connected) {
      return true;
    }

    await sleep(100);
  }

  return mqttClient.connected;
};

const mqttPublish = async (topic, payload, options = {}) => {
  return withTimeout(
    new Promise(async (resolve, reject) => {
      const connected = await waitForMqttConnected(3000);

      if (!connected) {
        return reject(new Error("MQTT broker bağlı değil."));
      }

      mqttClient.publish(topic, String(payload), options, (error) => {
        if (error) return reject(error);
        return resolve();
      });
    }),
    MQTT_PUBLISH_TIMEOUT_MS,
    "MQTT publish",
  );
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

const getClientIp = (req) => {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return String(forwardedFor[0]).split(",")[0].trim();
  }

  return (
    req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || ""
  );
};

// =========================================================
// HELPERS
// =========================================================

const isInvalidBayId = (bayId) => {
  if (!bayId || typeof bayId !== "string") return true;

  const normalized = bayId.trim();

  return (
    normalized === "" ||
    normalized === "bay_000000000000" ||
    normalized.includes("000000000000")
  );
};

const firebaseKeySchema = z
  .string({ required_error: "Zorunlu alan eksik." })
  .trim()
  .min(1, "Zorunlu alan boş olamaz.")
  .max(128, "Alan çok uzun.")
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "Alan sadece harf, rakam, alt çizgi ve tire içerebilir.",
  );

const clientUidSchema = firebaseKeySchema.optional();

const packageIdInputSchema = z
  .string()
  .trim()
  .max(128, "Paket bilgisi çok uzun.")
  .regex(
    /^[A-Za-z0-9_-]*$/,
    "Paket bilgisi sadece harf, rakam, alt çizgi ve tire içerebilir.",
  )
  .optional()
  .default("");

const topupSchema = z
  .object({
    uid: clientUidSchema,
    tokens: z.coerce
      .number()
      .int("Jeton miktarı tam sayı olmalıdır.")
      .min(1, "Jeton miktarı en az 1 olmalıdır.")
      .max(100, "Tek seferde en fazla 100 jeton yüklenebilir."),
  })
  .strict();

const prepareBaySchema = z
  .object({
    uid: clientUidSchema,
    bayId: firebaseKeySchema,
  })
  .strict();
const cancelWaitingSchema = prepareBaySchema;

const startSessionSchema = z
  .object({
    uid: clientUidSchema,
    bayId: firebaseKeySchema,
    packageId: packageIdInputSchema,
  })
  .strict();

const stopSessionSchema = z
  .object({
    uid: clientUidSchema,
    bayId: firebaseKeySchema,
    sessionId: firebaseKeySchema,
  })
  .strict();

const topupCallbackBodySchema = z
  .object({
    token: z.string().trim().min(1, "token gerekli.").max(512),
  })
  .passthrough();

const topupCallbackQuerySchema = z
  .object({
    orderId: firebaseKeySchema,
  })
  .passthrough();

const adminUpdateBaySchema = z
  .object({
    bayId: firebaseKeySchema,
    patch: z
      .object({
        status: z
          .enum(["available", "waiting", "offline", "maintenance"])
          .optional(),
        isActive: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const adminSearchUserSchema = z
  .object({
    arama: z.string().trim().min(1, "Arama terimi boş olamaz.").max(254),
  })
  .strict();

const adminUpdateUserSchema = z
  .object({
    userId: firebaseKeySchema,
    patch: z.object({ isBlocked: z.boolean() }).strict(),
  })
  .strict();

const adminTopupSchema = z
  .object({
    userId: firebaseKeySchema,
    tokens: z.coerce
      .number()
      .int("Jeton miktarı tam sayı olmalıdır.")
      .min(1, "Jeton miktarı en az 1 olmalıdır.")
      .max(10000, "Tek seferde en fazla 10000 jeton yüklenebilir."),
  })
  .strict();

const formatZodError = (error) => {
  return error.issues?.[0]?.message || "Geçersiz istek.";
};

const validateRequestBody = (schema) => (req, res, next) => {
  const parsed = schema.safeParse(req.body || {});

  if (!parsed.success) {
    return res.status(400).json({
      error: formatZodError(parsed.error),
    });
  }

  req.validatedBody = parsed.data;
  return next();
};

const validateRequestQuery = (schema) => (req, res, next) => {
  const parsed = schema.safeParse(req.query || {});

  if (!parsed.success) {
    return res.status(400).send("<h1>Geçersiz İstek</h1>");
  }

  req.validatedQuery = parsed.data;
  return next();
};

const normalizeText = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i")
    .replaceAll("İ", "i");
};

const isCancelValue = (value) => {
  const text = normalizeText(value);

  return [
    "",
    "cancel",
    "cancelled",
    "canceled",
    "iptal",
    "abort",
    "stop",
    "back",
    "geri",
    "none",
    "null",
    "undefined",
  ].includes(text);
};

const parseMqttJsonOrText = (message) => {
  const raw = String(message || "").trim();

  if (!raw) {
    return {
      raw,
      isJson: false,
      payload: null,
    };
  }

  if (raw.startsWith("{")) {
    try {
      return {
        raw,
        isJson: true,
        payload: JSON.parse(raw),
      };
    } catch {
      return {
        raw,
        isJson: false,
        payload: null,
      };
    }
  }

  return {
    raw,
    isJson: false,
    payload: null,
  };
};

const createFallbackEventId = (bayId, eventType, raw) => {
  const normalizedRaw = normalizeText(raw).slice(0, 64);
  return `${bayId}_${eventType}_${normalizedRaw}_${Date.now()}`;
};

const getMqttEventId = (bayId, eventType, parsed) => {
  const eventId = parsed?.payload?.eventId;

  if (eventId && typeof eventId === "string") {
    return eventId.trim().slice(0, 128);
  }

  return createFallbackEventId(bayId, eventType, parsed?.raw || "");
};

const getSelectionPackageId = (parsed) => {
  const rawValue =
    parsed?.payload?.packageId ||
    parsed?.payload?.package ||
    parsed?.payload?.selection ||
    parsed?.raw ||
    "";

  const normalizedSelection = normalizeText(rawValue);

  if (
    normalizedSelection === "foam" ||
    normalizedSelection === "kopuk" ||
    normalizedSelection === "köpük"
  ) {
    return "foam";
  }

  if (
    normalizedSelection === "wash" ||
    normalizedSelection === "su" ||
    normalizedSelection === "water" ||
    normalizedSelection === "yikama" ||
    normalizedSelection === "yıkama"
  ) {
    return "wash";
  }

  return "";
};

const getEventAction = (parsed) => {
  const value =
    parsed?.payload?.type ||
    parsed?.payload?.event ||
    parsed?.payload?.action ||
    parsed?.raw ||
    "";

  return normalizeText(value);
};

const wasMqttEventProcessed = async (bayId, eventId) => {
  if (!eventId) return false;

  const eventRef = rtdb.ref(`processedMqttEvents/${bayId}/${eventId}`);
  const snap = await eventRef.once("value");

  return snap.exists();
};

const markMqttEventProcessed = async (bayId, eventId, patch = {}) => {
  if (!eventId) return;

  await rtdb.ref(`processedMqttEvents/${bayId}/${eventId}`).set({
    processedAt: admin.database.ServerValue.TIMESTAMP,
    ...patch,
  });
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

    tx.update(userRef, {
      walletTokens: admin.firestore.FieldValue.increment(tokensCost),
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

  const beforeSnap = await bayRef.once("value");

  if (!beforeSnap.exists()) {
    return {
      success: false,
      reason: "bay_not_found",
    };
  }

  const beforeBay = beforeSnap.val();

  const result = await bayRef.transaction((currentBay) => {
    const bay = currentBay || beforeBay;

    if (!bay) {
      return;
    }

    const status = bay.status || "available";
    const nowMs = Date.now(); // <-- YENİ EKLENDİ

    const canReserveFromAvailable =
      ["available", "baslangic"].includes(status) &&
      !bay.currentSessionId &&
      bay.isActive !== false;

    const canReserveFromWaiting =
      status === "waiting" &&
      (!bay.lastUserId || bay.lastUserId === uid) &&
      !bay.currentSessionId &&
      bay.isActive !== false;

    if (!canReserveFromAvailable && !canReserveFromWaiting) {
      return;
    }

    return {
      ...bay,
      status: "starting",
      lastUserId: uid,
      startingAt: nowMs, // <-- DEĞİŞTİRİLDİ
      updatedAt: nowMs, // <-- DEĞİŞTİRİLDİ
    };
  });

  if (!result.committed) {
    const bayData = result.snapshot?.val() || beforeBay;

    if (!bayData) {
      return {
        success: false,
        reason: "bay_not_found",
      };
    }

    if (
      bayData.isActive === false ||
      bayData.status === "offline" ||
      bayData.status === "maintenance"
    ) {
      return {
        success: false,
        reason: "bay_disabled",
      };
    }

    return {
      success: false,
      reason: "bay_not_available",
      bayData,
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
const setBayPresence = async (bayId, patch = {}) => {
  if (isInvalidBayId(bayId)) {
    safeLog(`🚨 bayPresence yazımı engellendi, geçersiz bayId: ${bayId}`);
    return;
  }

  await rtdb.ref(`bayPresence/${bayId}`).update({
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    ...patch,
  });
};

const clearBaySessionFields = async (bayId, extraPatch = {}) => {
  // Heartbeat / connection fields are intentionally kept outside bays/{bayId}.
  // This prevents RTDB transaction maxretry errors while users prepare/start sessions.
  const { isActive, autoOffline, lastSeen, ...bayPatch } = extraPatch || {};

  await rtdb.ref(`bays/${bayId}`).update({
    currentSessionId: null,
    lastUserId: null,
    requestedPackage: null,
    durationSec: null,
    tokensCost: null,
    hardwareSelection: "",
    pendingPackage: null,
    pendingPackageSource: null,
    pendingSelectionId: null,
    pendingPackageAt: null,
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    ...bayPatch,
  });

  const presencePatch = {};

  if (isActive !== undefined) presencePatch.isActive = isActive;
  if (autoOffline !== undefined) presencePatch.autoOffline = autoOffline;
  if (lastSeen !== undefined) presencePatch.lastSeen = lastSeen;

  if (Object.keys(presencePatch).length > 0) {
    await setBayPresence(bayId, presencePatch);
  }
};

const resumeOrClearSessionAfterBoot = async (bayId, bayData = {}) => {
  const sessionId = bayData.currentSessionId;

  if (!sessionId) {
    await clearBaySessionFields(bayId, {
      status: "available",
      isActive: true,
      autoOffline: null,
      lastSeen: admin.database.ServerValue.TIMESTAMP,
    });

    await safeSendBayCommand(bayId, "AVAILABLE");

    return {
      resumed: false,
      reason: "no_active_session",
    };
  }

  const sessionRef = db.collection("sessions").doc(sessionId);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    await clearBaySessionFields(bayId, {
      status: "available",
      isActive: true,
      autoOffline: null,
      lastSeen: admin.database.ServerValue.TIMESTAMP,
    });

    await safeSendBayCommand(bayId, "AVAILABLE");

    return {
      resumed: false,
      reason: "session_not_found",
    };
  }

  const session = sessionDoc.data();

  if (session.status !== "running") {
    await clearBaySessionFields(bayId, {
      status: "available",
      isActive: true,
      autoOffline: null,
      lastSeen: admin.database.ServerValue.TIMESTAMP,
    });

    await safeSendBayCommand(bayId, "AVAILABLE");

    return {
      resumed: false,
      reason: `session_not_running_${session.status}`,
    };
  }

  const expectedEndTimeMs =
    Number(session.expectedEndTimeMs || 0) ||
    (session.expectedEndTime &&
    typeof session.expectedEndTime.toMillis === "function"
      ? session.expectedEndTime.toMillis()
      : 0);

  const remainingSec = Math.max(
    0,
    Math.ceil((expectedEndTimeMs - Date.now()) / 1000),
  );

  if (remainingSec <= 0) {
    await sessionRef.update({
      status: "ended",
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
      endedReason: "time_up_after_boot",
    });

    await clearBaySessionFields(bayId, {
      status: "waiting",
      isActive: true,
      autoOffline: null,
      lastSeen: admin.database.ServerValue.TIMESTAMP,
      lastUserId: session.userId || bayData.lastUserId || null, // <-- KULLANICIYI TUTUYORUZ
    });

    await safeSendBayCommand(bayId, "WAITING");

    return {
      resumed: false,
      reason: "session_expired",
    };
  }

  const packageId =
    session.packageId || session.type || bayData.requestedPackage;
  const tokensCost = Number(session.tokensCost || bayData.tokensCost || 0);

  if (!packageId) {
    await clearBaySessionFields(bayId, {
      status: "available",
      isActive: true,
      autoOffline: null,
      lastSeen: admin.database.ServerValue.TIMESTAMP,
    });

    await safeSendBayCommand(bayId, "AVAILABLE");

    return {
      resumed: false,
      reason: "missing_package_id",
    };
  }

  await rtdb.ref(`bays/${bayId}`).update({
    status: "busy",
    requestedPackage: packageId,
    durationSec: remainingSec,
    tokensCost,
    currentSessionId: sessionId,
    lastUserId: session.userId || bayData.lastUserId || null,
    hardwareSelection: "",
    pendingPackage: null,
    pendingPackageSource: null,
    pendingSelectionId: null,
    pendingPackageAt: null,
    updatedAt: admin.database.ServerValue.TIMESTAMP,
  });

  await setBayPresence(bayId, {
    isActive: true,
    autoOffline: null,
    lastSeen: admin.database.ServerValue.TIMESTAMP,
  });

  const mqttOk = await safeSendBayCommand(
    bayId,
    `BUSY|${packageId}|${remainingSec}`,
  );

  return {
    resumed: mqttOk,
    reason: mqttOk ? "session_resumed" : "mqtt_resume_failed",
    sessionId,
    packageId,
    remainingSec,
  };
};

const clearWaitingBayAfterCancel = async (bayId, uid = null) => {
  const bayRef = rtdb.ref(`bays/${bayId}`);
  const baySnap = await bayRef.once("value");
  const bayData = baySnap.val();

  if (!bayData) {
    return {
      cleared: false,
      commandSent: false,
      reason: "bay_not_found",
    };
  }

  const alreadyAvailable =
    bayData.status === "available" &&
    !bayData.currentSessionId &&
    !bayData.lastUserId &&
    !bayData.requestedPackage &&
    !bayData.durationSec &&
    !bayData.tokensCost;

  if (alreadyAvailable) {
    return {
      cleared: false,
      commandSent: false,
      reason: "already_available",
    };
  }

  if (bayData.currentSessionId) {
    return {
      cleared: false,
      commandSent: false,
      reason: "active_session_exists",
    };
  }

  if (
    uid &&
    bayData.lastUserId &&
    bayData.lastUserId !== uid &&
    bayData.status !== "available"
  ) {
    return {
      cleared: false,
      commandSent: false,
      reason: "different_user",
    };
  }

  if (["waiting", "starting", "available"].includes(bayData.status)) {
    await clearBaySessionFields(bayId, {
      status: "available",
      isActive: true,
      autoOffline: null,
      lastSeen: admin.database.ServerValue.TIMESTAMP,
    });

    const mqttOk = await safeSendBayCommand(bayId, "AVAILABLE");

    return {
      cleared: true,
      commandSent: mqttOk,
      reason: "cancelled",
    };
  }

  return {
    cleared: false,
    commandSent: false,
    reason: `not_cancelable_${bayData.status}`,
  };
};

// =========================================================
// MAIL
// =========================================================
const MAIL_COOLDOWN_MS = 10 * 60 * 1000;

const sendAdminAlert = async (bayId, type) => {
  if (isInvalidBayId(bayId)) {
    safeLog(`🚨 Mail uyarısı atlandı, geçersiz bayId: ${bayId}`);
    return;
  }

  const now = Date.now();
  const alertRef = rtdb.ref(`bayAlerts/${bayId}/${type}`);

  const claimResult = await alertRef.transaction((currentAlert) => {
    const lastSent = Number(currentAlert?.lastSent || 0);

    if (now - lastSent < MAIL_COOLDOWN_MS) {
      return;
    }

    return {
      lastSent: now,
      updatedAt: now, // <-- DEĞİŞTİRİLDİ: ServerValue.TIMESTAMP yerine 'now' kullanıyoruz.
    };
  });

  if (!claimResult.committed) {
    safeLog(`📧 Mail atlandı: ${bayId} ${type} bildirimi cooldown içinde.`);
    return;
  }

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
    const response = await fetchWithTimeout(
      "https://api.brevo.com/v3/smtp/email",
      {
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
      },
      BREVO_TIMEOUT_MS,
    );

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
    if (error.name === "AbortError") {
      safeLog("❌ Mail API zaman aşımı: Brevo 5 saniye içinde yanıt vermedi.");
      return;
    }

    safeLog(`❌ Mail API Bağlantı Hatası: ${error.message}`);
  }
};

// =========================================================
// MQTT EVENTS
// =========================================================
mqttClient.on("connect", () => {
  safeLog(`✅ MQTT Broker bağlantısı başarılı. clientId=${MQTT_CLIENT_ID}`);

  mqttClient.subscribe("qwash/bays/+/status", { qos: 1 });
  mqttClient.subscribe("qwash/bays/+/heartbeat", { qos: 0 });
  mqttClient.subscribe("qwash/bays/+/selection", { qos: 1 });
  mqttClient.subscribe("qwash/bays/+/event", { qos: 1 });

  safeLog("📡 MQTT topic abonelikleri aktif.");
});

mqttClient.on("reconnect", () => {
  safeLog("🔄 MQTT yeniden bağlanıyor...");
});

mqttClient.on("error", (error) => {
  safeLog(`❌ MQTT hata: ${error.message}`);
});

mqttClient.on("close", () => {
  safeLog(`⚠️ MQTT bağlantısı kapandı. clientId=${MQTT_CLIENT_ID}`);
});

mqttClient.on("offline", () => {
  safeLog(`⚠️ MQTT offline oldu. clientId=${MQTT_CLIENT_ID}`);
});

mqttClient.on("message", async (topic, messageBuffer, packet) => {
  const message = messageBuffer.toString();
  const parts = topic.split("/");

  if (parts.length !== 4 || parts[0] !== "qwash" || parts[1] !== "bays") {
    return;
  }

  const bayId = parts[2];
  const eventType = parts[3];

  if (isInvalidBayId(bayId)) {
    safeLog(
      `🚨 GEÇERSİZ BAY ID ENGELLENDİ: topic=${topic}, message=${message}`,
    );
    return;
  }

  try {
    if (eventType === "status") {
      const bayRef = rtdb.ref(`bays/${bayId}`);
      const presenceRef = rtdb.ref(`bayPresence/${bayId}`);
      const nextStatus = String(message || "").trim();
      if (packet?.retain === true && nextStatus === "offline") {
        safeLog(`ℹ️ Retained OFFLINE status yok sayıldı: ${bayId}`);
        return;
      }

      if (nextStatus === "offline") {
        const baySnap = await bayRef.once("value");
        const bayData = baySnap.val() || {};

        if (bayData.currentSessionId) {
          const refundResult = await refundSessionIfNeeded(
            bayData.currentSessionId,
            "bay_power_loss",
          );

          if (refundResult.refunded) {
            safeLog(
              `💸 OFFLINE İADESİ: ${bayId} bağlantı kesildi, ${refundResult.tokens} jeton iade edildi.`,
            );
          } else {
            safeLog(
              `ℹ️ OFFLINE sırasında iade yapılmadı: ${bayId} - ${refundResult.reason}`,
            );
          }
        }

        await clearBaySessionFields(bayId, {
          status: "offline",
        });

        await presenceRef.update({
          isActive: false,
          autoOffline: true,
          offlineAt: admin.database.ServerValue.TIMESTAMP,
          updatedAt: admin.database.ServerValue.TIMESTAMP,
        });

        await sendAdminAlert(bayId, "down");

        safeLog(`📥 MQTT STATUS: ${bayId} -> ${nextStatus}`);
        return;
      }

      const baySnap = await bayRef.once("value");
      const currentBay = baySnap.val();

      if (!currentBay) {
        await bayRef.update({
          status: nextStatus || "available",
          currentSessionId: null,
          lastUserId: null,
          requestedPackage: null,
          durationSec: null,
          tokensCost: null,
          pendingPackage: null,
          pendingPackageSource: null,
          pendingSelectionId: null,
          pendingPackageAt: null,
          createdAt: admin.database.ServerValue.TIMESTAMP,
          updatedAt: admin.database.ServerValue.TIMESTAMP,
        });
      } else {
        const currentStatus = currentBay.status || "available";

        const hardwareTryingToFreeActiveSession =
          currentBay.currentSessionId &&
          ["busy", "starting"].includes(currentStatus) &&
          ["available", "waiting"].includes(nextStatus);

        if (!hardwareTryingToFreeActiveSession) {
          await bayRef.update({
            status: nextStatus || currentStatus,
            isActive: true,
            autoOffline: null,
            updatedAt: admin.database.ServerValue.TIMESTAMP,
          });
        }
      }

      await presenceRef.update({
        isActive: true,
        autoOffline: null,
        lastSeen: admin.database.ServerValue.TIMESTAMP,
        updatedAt: admin.database.ServerValue.TIMESTAMP,
      });

      safeLog(`📥 MQTT STATUS: ${bayId} -> ${nextStatus}`);
      return;
    }

    if (eventType === "heartbeat") {
      if (isInvalidBayId(bayId)) {
        safeLog(
          `🚨 GEÇERSİZ BAY ID ENGELLENDİ: topic=${topic}, message=${message}`,
        );
        return;
      }
      const bayRef = rtdb.ref(`bays/${bayId}`);
      const snap = await bayRef.once("value");
      const isBoot = message === "BOOT";

      if (!snap.exists()) {
        const now = admin.database.ServerValue.TIMESTAMP;

        await bayRef.update({
          status: "available",
          isActive: true,
          autoOffline: null,
          currentSessionId: null,
          lastUserId: null,
          requestedPackage: null,
          durationSec: null,
          tokensCost: null,
          pendingPackage: null,
          pendingPackageSource: null,
          pendingSelectionId: null,
          pendingPackageAt: null,
          createdAt: now,
          updatedAt: now,
        });

        await setBayPresence(bayId, {
          lastSeen: now,
          isActive: true,
          autoOffline: null,
        });

        safeLog(`🆕 Yeni peron MQTT ile kaydedildi: ${bayId}`);
        return;
      }

      if (isBoot) {
        const bayData = snap.val() || {};

        const bootResult = await resumeOrClearSessionAfterBoot(bayId, bayData);

        if (bootResult.resumed) {
          safeLog(
            `🔄 BOOT DEVAM: ${bayId} session devam ettirildi. ` +
              `Session=${bootResult.sessionId}, Paket=${bootResult.packageId}, Kalan=${bootResult.remainingSec}sn`,
          );
        } else {
          safeLog(`🔄 BOOT TEMİZLİĞİ: ${bayId} result=${bootResult.reason}`);
        }

        return;
      }

      const presenceRef = rtdb.ref(`bayPresence/${bayId}`);
      const presenceSnap = await presenceRef.once("value");
      const oldPresence = presenceSnap.val() || {};
      const wasAutoOffline = oldPresence.autoOffline === true;

      await setBayPresence(bayId, {
        lastSeen: admin.database.ServerValue.TIMESTAMP,
        isActive: true,
        autoOffline: null,
      });

      if (wasAutoOffline) {
        safeLog(`✅ HEARTBEAT GERİ GELDİ: ${bayId} yeniden çevrimiçi.`);
        await sendAdminAlert(bayId, "up");
      }

      // Legacy uyumluluk:

      // Legacy uyumluluk:
      // prepare-bay halen bays/{bayId}.isActive alanına bakıyor.
      // Eski kayıtta isActive=false kaldıysa heartbeat gelince düzelt.
      const bayDataForActiveFix = snap.val() || {};

      if (
        bayDataForActiveFix.isActive === false ||
        bayDataForActiveFix.autoOffline === true
      ) {
        await bayRef.update({
          isActive: true,
          autoOffline: null,
          updatedAt: admin.database.ServerValue.TIMESTAMP,
        });
      }

      safeLog(`💓 MQTT HEARTBEAT: ${bayId}`);
      return;
    }

    if (eventType === "event") {
      const parsed = parseMqttJsonOrText(message);
      const eventId = getMqttEventId(bayId, "event", parsed);
      const action = getEventAction(parsed);

      if (await wasMqttEventProcessed(bayId, eventId)) {
        safeLog(
          `ℹ️ MQTT EVENT duplicate yok sayıldı: ${bayId}, eventId=${eventId}`,
        );
        return;
      }

      if (isCancelValue(action)) {
        const cancelResult = await clearWaitingBayAfterCancel(bayId);

        await markMqttEventProcessed(bayId, eventId, {
          type: "cancel",
          result: cancelResult.reason || null,
        });

        if (cancelResult.cleared) {
          safeLog(
            `↩️ MQTT EVENT CANCEL: ${bayId} result=${JSON.stringify(
              cancelResult,
            )}`,
          );
        } else {
          safeLog(
            `ℹ️ MQTT EVENT CANCEL yok sayıldı: ${bayId} reason=${cancelResult.reason}`,
          );
        }

        return;
      }

      await markMqttEventProcessed(bayId, eventId, {
        type: "event",
        raw: parsed.raw.slice(0, 256),
      });

      safeLog(`ℹ️ MQTT EVENT: ${bayId} -> ${parsed.raw}`);
      return;
    }

    if (eventType === "selection") {
      const parsed = parseMqttJsonOrText(message);
      const eventId = getMqttEventId(bayId, "selection", parsed);

      if (await wasMqttEventProcessed(bayId, eventId)) {
        safeLog(
          `ℹ️ MQTT SEÇİM duplicate yok sayıldı: ${bayId}, eventId=${eventId}`,
        );
        return;
      }

      const action = getEventAction(parsed);

      if (isCancelValue(action)) {
        const cancelResult = await clearWaitingBayAfterCancel(bayId);

        await markMqttEventProcessed(bayId, eventId, {
          type: "selection_cancel",
          result: cancelResult.reason || null,
        });

        if (cancelResult.cleared) {
          safeLog(
            `↩️ MQTT SELECTION CANCEL: ${bayId} result=${JSON.stringify(
              cancelResult,
            )}`,
          );
        } else {
          safeLog(
            `ℹ️ MQTT SELECTION CANCEL yok sayıldı: ${bayId} reason=${cancelResult.reason}`,
          );
        }

        return;
      }

      const packageId = getSelectionPackageId(parsed);

      if (!packageId) {
        safeLog(`⚠️ MQTT SEÇİM bilinmeyen paket: ${bayId} -> ${parsed.raw}`);
        return;
      }

      const bayRef = rtdb.ref(`bays/${bayId}`);
      const baySnap = await bayRef.once("value");
      const bayData = baySnap.val() || {};

      if (
        bayData.status !== "waiting" ||
        bayData.currentSessionId ||
        !bayData.lastUserId
      ) {
        safeLog(
          `⚠️ MQTT SEÇİM yok sayıldı: ${bayId} status=${bayData.status}, lastUserId=${bayData.lastUserId || "yok"}`,
        );

        await markMqttEventProcessed(bayId, eventId, {
          type: "selection_ignored",
          packageId,
          status: bayData.status || null,
          reason: "bay_not_waiting_or_no_user",
        });

        return;
      }

      await bayRef.update({
        hardwareSelection: packageId,
        pendingPackage: packageId,
        pendingSelectionId: eventId,
        pendingPackageSource: "esp32",
        pendingPackageAt: admin.database.ServerValue.TIMESTAMP,
        lastProcessedSelectionId: eventId,
        updatedAt: admin.database.ServerValue.TIMESTAMP,
      });

      await markMqttEventProcessed(bayId, eventId, {
        type: "selection",
        packageId,
      });

      safeLog(
        `🧼 MQTT SEÇİM KAYDEDİLDİ: ${bayId} -> ${packageId}, eventId=${eventId}`,
      );
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

app.post(
  "/api/prepare-bay",
  verifyUser,
  validateRequestBody(prepareBaySchema),
  async (req, res) => {
    const { bayId } = req.validatedBody;
    const uid = req.user.uid;

    safeLog(`🟡 PREPARE GELDİ: bayId="${bayId}", uid="${uid}"`);

    try {
      const bayRef = rtdb.ref(`bays/${bayId}`);

      const snap = await bayRef.once("value");
      const bay = snap.val();

      safeLog(
        `🟡 PREPARE CURRENT: exists=${snap.exists()} data=${JSON.stringify(bay)}`,
      );

      if (!snap.exists() || !bay) {
        return res.status(404).json({
          error: `Peron bulunamadı: ${bayId}`,
        });
      }

      const status = bay.status || "available";

      if (
        bay.isActive === false ||
        status === "offline" ||
        status === "maintenance"
      ) {
        return res.status(409).json({
          error: "Peron şu anda aktif değil veya bakım modunda.",
        });
      }

      if (bay.currentSessionId) {
        return res.status(409).json({
          error: "Peron şu anda aktif bir yıkama oturumunda.",
        });
      }

      if (status === "waiting" && bay.lastUserId && bay.lastUserId !== uid) {
        return res.status(409).json({
          error: "Peron şu anda başka bir kullanıcı tarafından hazırlanıyor.",
        });
      }

      if (!["available", "baslangic", "waiting"].includes(status)) {
        return res.status(409).json({
          error:
            "Peron şu anda başka bir kullanıcı tarafından kullanılıyor veya hazırlanıyor.",
        });
      }

      await bayRef.update({
        status: "waiting",
        lastUserId: uid,
        currentSessionId: null,
        requestedPackage: null,
        durationSec: null,
        tokensCost: null,
        hardwareSelection: "",
        pendingPackage: null,
        pendingPackageSource: null,
        pendingSelectionId: null,
        pendingPackageAt: null,
        updatedAt: Date.now(),
      });

      const mqttOk = await safeSendBayCommand(bayId, "WAITING");

      safeLog(`🟢 PREPARE OK: bayId=${bayId}, mqttOk=${mqttOk}`);

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
  },
);

// ---------------------------------------------------------
// OTURUM BAŞLATMA
// ---------------------------------------------------------
app.post(
  "/api/start-session",
  verifyUser,
  validateRequestBody(startSessionSchema),
  async (req, res) => {
    const uid = req.user.uid;
    const { bayId, packageId } = req.validatedBody;

    if (!packageId || isCancelValue(packageId)) {
      safeLog(
        `ℹ️ START SESSION İPTAL SAYILDI: User=${uid}, Bay=${bayId}, packageId=${packageId}`,
      );

      try {
        const cancelResult = await clearWaitingBayAfterCancel(bayId, uid);

        safeLog(
          `ℹ️ START SESSION İPTAL TEMİZLİĞİ: ${bayId} result=${JSON.stringify(
            cancelResult,
          )}`,
        );
      } catch (cancelCleanupError) {
        safeLog(
          `ℹ️ İptal temizliği yapılamadı ama hata sayılmadı: ${cancelCleanupError.message}`,
        );
      }

      return res.status(200).json({
        success: false,
        cancelled: true,
        code: "operation_cancelled",
        message: "İşlem kullanıcı veya cihaz tarafından iptal edildi.",
      });
    }

    let bayReserved = false;
    let newSessionId = null;
    let finalTokensCost = 0;
    let finalDurationSec = 0;

    try {
      const userRef = db.collection("users").doc(uid);
      const rtdbBayRef = rtdb.ref(`bays/${bayId}`);
      const packageRef = db.collection("packages").doc(packageId);

      const reserveResult = await reserveBayForSession(bayId, uid);

      if (!reserveResult.success) {
        if (reserveResult.reason === "bay_not_found") {
          return res
            .status(404)
            .json({ error: "Peron bulunamadı veya cihaz tamamen kapalı." });
        }

        if (reserveResult.reason === "bay_disabled") {
          return res
            .status(403)
            .json({ error: "Bu peron şu anda hizmet dışıdır." });
        }

        return res.status(409).json({
          error:
            "Peron şu anda başka bir kullanıcı tarafından kullanılıyor veya hazırlanıyor.",
        });
      }

      bayReserved = true;

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
          walletTokens: admin.firestore.FieldValue.increment(-finalTokensCost),
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

      await rtdbBayRef.update({
        status: "busy",
        requestedPackage: packageId,
        durationSec: finalDurationSec,
        tokensCost: finalTokensCost,
        lastUserId: uid,
        currentSessionId: newSessionId,
        hardwareSelection: "",
        pendingPackage: null,
        pendingPackageSource: null,
        pendingSelectionId: null,
        pendingPackageAt: null,
        startingAt: null,
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
          lastUserId: uid, // <-- KULLANICIYI TUTUYORUZ
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
      const shouldKeepWaitingAfterStartError =
        error.message === "Yetersiz_Bakiye";

      if (bayReserved && !newSessionId) {
        try {
          if (shouldKeepWaitingAfterStartError) {
            await rtdb.ref(`bays/${bayId}`).update({
              status: "waiting",
              lastUserId: uid,
              startingAt: null,
              updatedAt: admin.database.ServerValue.TIMESTAMP,
            });

            await safeSendBayCommand(bayId, "WAITING");
          } else {
            await clearBaySessionFields(bayId, {
              status: "available",
            });

            await safeSendBayCommand(bayId, "AVAILABLE");
          }
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
        const baySnap = await rtdb.ref(`bays/${bayId}`).once("value");
        const bayData = baySnap.val();

        if (
          !bayData ||
          (!bayData.currentSessionId &&
            ["available", "waiting", "starting"].includes(bayData.status))
        ) {
          safeLog(
            `ℹ️ Paket bulunamadı ama akış iptal sayıldı: User=${uid}, Bay=${bayId}, packageId=${packageId}`,
          );

          return res.status(200).json({
            success: false,
            cancelled: true,
            code: "operation_cancelled",
            message: "İşlem iptal edildi.",
          });
        }

        return res.status(404).json({
          error: "İstenilen paket sistemde bulunamadı.",
        });
      }

      if (error.message === "Gecersiz_Paket_Degerleri") {
        return res.status(500).json({
          error:
            "Sistemdeki paket değerleri hatalı. Lütfen yöneticiye bildirin.",
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
  },
);

// ---------------------------------------------------------
// PERONDAN MANUEL ÇIKIŞ
// ---------------------------------------------------------
app.post(
  "/api/cancel-waiting",
  verifyUser,
  validateRequestBody(cancelWaitingSchema),
  async (req, res) => {
    const { bayId } = req.validatedBody;

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

      const alreadyAvailable =
        bayData.status === "available" &&
        !bayData.currentSessionId &&
        !bayData.lastUserId &&
        !bayData.requestedPackage;

      if (alreadyAvailable) {
        return res.status(200).json({
          success: true,
          mqttOk: false,
          reason: "already_available",
          message: "Peron zaten serbest.",
        });
      }

      const canCancel =
        !bayData.currentSessionId &&
        ["waiting", "starting", "available"].includes(bayData.status) &&
        (!bayData.lastUserId || bayData.lastUserId === req.user.uid);

      if (!canCancel) {
        safeLog(
          `🚨 YETKİSİZ İPTAL DENEMESİ: ${req.user.uid}, Peron: ${bayId}, status=${bayData.status}, lastUserId=${bayData.lastUserId || "yok"}`,
        );

        return res.status(403).json({
          error:
            "Bu peronu iptal etme yetkiniz yok veya peron şu an iptal edilebilir durumda değil.",
        });
      }

      const cancelResult = await clearWaitingBayAfterCancel(
        bayId,
        req.user.uid,
      );

      return res.status(200).json({
        success:
          cancelResult.cleared || cancelResult.reason === "already_available",
        mqttOk: cancelResult.commandSent || false,
        reason: cancelResult.reason,
        message:
          cancelResult.reason === "already_available"
            ? "Peron zaten serbest."
            : cancelResult.commandSent
              ? "Peron başarıyla serbest bırakıldı."
              : "Peron veritabanında serbest bırakıldı.",
      });
    } catch (error) {
      safeLog(`❌ Cancel Waiting Hatası: ${error.message}`);

      return res.status(500).json({
        error: "Sunucu hatası, işlem iptal edilemedi.",
      });
    }
  },
);

// ---------------------------------------------------------
// OTURUMU MANUEL DURDURMA
// ---------------------------------------------------------
app.post(
  "/api/stop-session",
  verifyUser,
  validateRequestBody(stopSessionSchema),
  async (req, res) => {
    const { bayId, sessionId } = req.validatedBody;
    const uid = req.user.uid;

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

      if (session.userId !== uid) {
        safeLog(
          `🚨 YETKİSİZ OTURUM DURDURMA DENEMESİ: Saldırgan=${uid}, Session=${sessionId}, SessionUser=${session.userId || "yok"}`,
        );

        return res.status(403).json({
          error: "Bu oturumu durdurma yetkiniz yok.",
        });
      }

      if (session.bayId !== bayId) {
        safeLog(
          `🚨 BAY/SESSION EŞLEŞME HATASI: User=${uid}, İstekBay=${bayId}, SessionBay=${session.bayId}, Session=${sessionId}`,
        );

        return res.status(400).json({
          error: "Oturum ve peron bilgisi eşleşmiyor.",
        });
      }

      if (session.status !== "running") {
        return res.status(409).json({
          error: "Bu oturum zaten aktif değil.",
        });
      }

      if (bayData.currentSessionId !== sessionId) {
        safeLog(
          `🚨 AKTİF SESSION EŞLEŞMİYOR: User=${uid}, Bay=${bayId}, İstekSession=${sessionId}, BaySession=${bayData.currentSessionId || "yok"}`,
        );

        return res.status(409).json({
          error: "Bu peronda belirtilen oturum aktif değil.",
        });
      }

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
        lastUserId: uid, // <-- KULLANICIYI TUTUYORUZ
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
  },
);

// ---------------------------------------------------------
// IYZICO CHECKOUT FORM BAŞLATMA
// ---------------------------------------------------------
app.post(
  "/api/topup",
  verifyUser,
  validateRequestBody(topupSchema),
  async (req, res) => {
    const uid = req.user.uid;
    const eklenecekJeton = req.validatedBody.tokens;

    try {
      const jetonPackageDoc = await db
        .collection("packages")
        .doc("jeton")
        .get();

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

      const buyerIp = getClientIp(req);

      if (!buyerIp) {
        await orderRef.update({
          status: "ip_missing",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(400).json({
          error: "Kullanıcı IP adresi alınamadı.",
        });
      }

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
          ip: buyerIp,
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

      const result = await initializeIyzicoCheckoutForm(iyzicoRequest);

      if (!result || result.status === "failure") {
        await orderRef.update({
          status: "init_failed",
          errorMessage: result?.errorMessage || "Iyzico yanıtı geçersiz.",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        safeLog(
          `❌ Iyzico Form Başlatılamadı: ${
            result?.errorMessage || "Iyzico yanıtı geçersiz."
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
    } catch (error) {
      safeLog(`❌ Sunucu Ödeme Hatası: ${error.message}`);
      return res.status(500).json({ error: "Sunucu hatası." });
    }
  },
);

// ---------------------------------------------------------
// IYZICO CALLBACK
// ---------------------------------------------------------
app.post(
  "/api/topup-callback",
  validateRequestBody(topupCallbackBodySchema),
  validateRequestQuery(topupCallbackQuerySchema),
  async (req, res) => {
    const { token } = req.validatedBody;
    const { orderId } = req.validatedQuery;

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

      const result = await retrieveIyzicoCheckoutForm({
        locale: Iyzipay.LOCALE.TR,
        conversationId: orderId,
        token,
      });

      if (
        !result ||
        result.status !== "success" ||
        result.paymentStatus !== "SUCCESS"
      ) {
        await orderRef.update({
          status: "failed",
          iyzicoStatus: result?.status || null,
          iyzicoPaymentStatus: result?.paymentStatus || null,
          errorMessage: result?.errorMessage || null,
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
            walletTokens: admin.firestore.FieldValue.increment(tokensToAdd),
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
    } catch (error) {
      safeLog(`❌ Callback sunucu hatası: ${error.message}`);
      return res.status(500).send("<h1>Sunucu hatası oluştu.</h1>");
    }
  },
);

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
app.post(
  "/api/admin/update-bay",
  verifyAdmin,
  validateRequestBody(adminUpdateBaySchema),
  async (req, res) => {
    const { bayId, patch } = req.validatedBody;

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

      let adminSessionCloseResult = null;

      const statusWillForceCloseSession = [
        "available",
        "offline",
        "maintenance",
      ].includes(allowedPatch.status);

      if (statusWillForceCloseSession) {
        const baySnap = await rtdb.ref(`bays/${bayId}`).once("value");
        const bayData = baySnap.val();

        if (bayData?.currentSessionId) {
          adminSessionCloseResult = await refundSessionIfNeeded(
            bayData.currentSessionId,
            `admin_set_${allowedPatch.status}`,
          );

          safeLog(
            `🛠️ ADMIN PERON KAPATMA: ${bayId}, Session=${bayData.currentSessionId}, ` +
              `Status=${allowedPatch.status}, Refund=${adminSessionCloseResult.refunded ? "yes" : "no"}, ` +
              `Reason=${adminSessionCloseResult.reason || "ok"}`,
          );
        }
      }

      const guncellemeVerisi = {
        ...allowedPatch,
        updatedAt: admin.database.ServerValue.TIMESTAMP,
      };

      if (
        allowedPatch.status === "available" ||
        allowedPatch.status === "offline" ||
        allowedPatch.status === "maintenance"
      ) {
        guncellemeVerisi.currentSessionId = null;
        guncellemeVerisi.lastUserId = null;
        guncellemeVerisi.requestedPackage = null;
        guncellemeVerisi.durationSec = null;
        guncellemeVerisi.tokensCost = null;
        guncellemeVerisi.hardwareSelection = "";
        guncellemeVerisi.pendingPackage = null;
        guncellemeVerisi.pendingPackageSource = null;
        guncellemeVerisi.pendingSelectionId = null;
        guncellemeVerisi.pendingPackageAt = null;
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
        adminSessionCloseResult,
        message: "Peron güncellendi.",
      });
    } catch (error) {
      safeLog(`❌ Bay Güncelleme Hatası: ${error.message}`);

      if (res.headersSent) return;
      return res.status(500).json({ error: "Güncelleme başarısız." });
    }
  },
);

// ---------------------------------------------------------
// ADMIN USER SEARCH
// ---------------------------------------------------------
app.post(
  "/api/admin/search-user",
  verifyAdmin,
  validateRequestBody(adminSearchUserSchema),
  async (req, res) => {
    const { arama } = req.validatedBody;

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
  },
);

// ---------------------------------------------------------
// ADMIN USER UPDATE
// ---------------------------------------------------------
app.post(
  "/api/admin/update-user",
  verifyAdmin,
  validateRequestBody(adminUpdateUserSchema),
  async (req, res) => {
    const { userId, patch } = req.validatedBody;

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
  },
);

// ---------------------------------------------------------
// ADMIN TOPUP
// ---------------------------------------------------------
app.post(
  "/api/admin/topup",
  verifyAdmin,
  validateRequestBody(adminTopupSchema),
  async (req, res) => {
    const { userId, tokens } = req.validatedBody;

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

        tx.update(userRef, {
          walletTokens: admin.firestore.FieldValue.increment(adet),
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
        return res
          .status(404)
          .json({ error: "Kullanıcı dokümanı bulunamadı." });
      }

      if (res.headersSent) return;
      return res.status(500).json({ error: "Bakiye yükleme başarısız oldu." });
    }
  },
);

// =========================================================
// STARTUP CLEAN
// =========================================================
// NOT:
// Eski startup clean üretimde tehlikeliydi.
// Render deploy/restart sırasında aktif yıkama devam ederken:
// - running session refund ediliyordu
// - tüm peronlar available yapılıyordu
// Bu yüzden şimdilik non-destructive hale getirildi.
// Geri almak gerekirse aşağıdaki eski kod kontrollü şekilde açılabilir.
const systemStartupClean = async () => {
  safeLog(
    "ℹ️ Startup clean devre dışı: restart sırasında aktif session/peron state'i bozulmayacak.",
  );

  /*
  try {
    safeLog("🔄 Veritabanı temizliği yapılıyor...");

    const baysSnap = await rtdb.ref("bays").once("value");

    if (baysSnap.exists()) {
      const updates = {};
      const bays = baysSnap.val();

      Object.keys(bays).forEach((bayId) => {
        updates[`bays/${bayId}/status`] = "available";
        updates[`bayPresence/${bayId}/isActive`] = true;
        updates[`bayPresence/${bayId}/autoOffline`] = null;
        updates[`bays/${bayId}/currentSessionId`] = null;
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
  */
};

// =========================================================
// CRON
// =========================================================
let isHeartbeatCronRunning = false;

const ENABLE_CRON = process.env.ENABLE_CRON !== "false";

const acquireCronLock = async () => {
  const lockRef = rtdb.ref("systemLocks/heartbeatCron");
  const now = Date.now();
  const owner =
    process.env.RENDER_INSTANCE_ID ||
    process.env.RENDER_SERVICE_ID ||
    String(process.pid);

  const result = await lockRef.transaction((lock) => {
    const lockedUntil = Number(lock?.lockedUntil || 0);

    if (lockedUntil > now) {
      return;
    }

    return {
      owner,
      lockedAt: now,
      lockedUntil: now + 55 * 1000, // 55 saniye (Cron her 1 dakikada bir rahatça çalışsın)
    };
  });

  return result.committed;
};

if (ENABLE_CRON) {
  cronTask = cron.schedule("* * * * *", async () => {
    if (isHeartbeatCronRunning) {
      safeLog("⏭️ [CRON] Önceki kontrol hâlâ çalışıyor, bu tur atlandı.");
      return;
    }

    const lockOk = await acquireCronLock();

    if (!lockOk) {
      safeLog("⏭️ [CRON] Başka instance çalıştırıyor, bu tur atlandı.");
      return;
    }

    isHeartbeatCronRunning = true;
    safeLog("🔍 [CRON] Sistem kontrolü çalışıyor...");

    try {
      const now = Date.now();

      const expiredSessions = await db
        .collection("sessions")
        .where("status", "==", "running")
        .where(
          "expectedEndTime",
          "<=",
          admin.firestore.Timestamp.fromMillis(now),
        )
        .get();

      if (!expiredSessions.empty) {
        const FIRESTORE_BATCH_LIMIT = 450;
        const bayUpdates = {};
        const mqttWaitingCommands = [];

        let batch = db.batch();
        let batchWriteCount = 0;

        const commitBatchIfNeeded = async (force = false) => {
          if (batchWriteCount === 0) return;

          if (force || batchWriteCount >= FIRESTORE_BATCH_LIMIT) {
            await batch.commit();
            batch = db.batch();
            batchWriteCount = 0;
          }
        };

        for (const doc of expiredSessions.docs) {
          batch.update(doc.ref, {
            status: "ended",
            endedAt: admin.firestore.FieldValue.serverTimestamp(),
            endedReason: "time_up",
          });
          batchWriteCount += 1;

          await commitBatchIfNeeded();

          const bayId = doc.data().bayId;

          bayUpdates[`bays/${bayId}/status`] = "waiting";
          bayUpdates[`bays/${bayId}/currentSessionId`] = null;
          bayUpdates[`bays/${bayId}/lastUserId`] = null;
          bayUpdates[`bays/${bayId}/requestedPackage`] = null;
          bayUpdates[`bays/${bayId}/durationSec`] = null;
          bayUpdates[`bays/${bayId}/tokensCost`] = null;
          bayUpdates[`bays/${bayId}/updatedAt`] =
            admin.database.ServerValue.TIMESTAMP;

          mqttWaitingCommands.push(bayId);

          safeLog(
            `🏁 [CRON] OTOMATİK KAPATMA: ${bayId} süresi doldu, bekleme moduna alındı.`,
          );
        }

        await commitBatchIfNeeded(true);

        if (Object.keys(bayUpdates).length > 0) {
          await rtdb.ref().update(bayUpdates);
        }

        for (const bayId of mqttWaitingCommands) {
          await safeSendBayCommand(bayId, "WAITING");
        }
      }
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

        for (const bayId of mqttAvailableCommands) {
          await safeSendBayCommand(bayId, "AVAILABLE");
        }
      }

      const timeoutMs = 2 * 60 * 1000;

      const presenceSnap = await rtdb.ref("bayPresence").once("value");

      if (presenceSnap.exists()) {
        const presenceData = presenceSnap.val();

        for (const [bayId, presence] of Object.entries(presenceData)) {
          if (isInvalidBayId(bayId)) {
            safeLog(`🚨 CRON GEÇERSİZ BAY ID ATLANDI: ${bayId}`);
            continue;
          }

          const lastSeen = Number(presence.lastSeen || 0);

          if (!lastSeen) {
            continue;
          }

          const bayRef = rtdb.ref(`bays/${bayId}`);
          const baySnap = await bayRef.once("value");
          const bay = baySnap.val();

          if (!bay) {
            continue;
          }

          const isTimedOut = now - lastSeen > timeoutMs;
          const isBackOnline = presence.autoOffline === true && !isTimedOut;

          if (isTimedOut) {
            if (
              (bay.status === "offline" && presence.autoOffline !== true) ||
              bay.status === "maintenance"
            ) {
              continue;
            }

            if (bay.status !== "offline" || presence.autoOffline !== true) {
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
                  safeLog(
                    `ℹ️ İade yapılmadı: ${bayId} - ${refundResult.reason}`,
                  );
                }
              }

              await clearBaySessionFields(bayId, {
                status: "offline",
              });

              await setBayPresence(bayId, {
                isActive: false,
                autoOffline: true,
              });

              await sendAdminAlert(bayId, "down");
            }

            continue;
          }

          // if (isBackOnline) {
          //   safeLog(
          //     `✅ [CRON] İNTERNET GELDİ: ${bayId} otomatik olarak açılıyor...`,
          //   );

          //   await clearBaySessionFields(bayId, {
          //     status: "available",
          //   });

          //   await setBayPresence(bayId, {
          //     isActive: true,
          //     autoOffline: null,
          //   });

          //   await safeSendBayCommand(bayId, "AVAILABLE");
          //   await sendAdminAlert(bayId, "up");
          // }
        }
      }
    } catch (error) {
      safeLog(`❌ Cron Job Hatası: ${error.message}`);
    } finally {
      isHeartbeatCronRunning = false;
    }
  });
} else {
  safeLog("ℹ️ Cron devre dışı. ENABLE_CRON=false.");
}

process.on("unhandledRejection", (reason) => {
  const message =
    reason instanceof Error
      ? reason.stack || reason.message
      : JSON.stringify(reason);
  safeLog(`🚨 UNHANDLED REJECTION: ${message}`);
});

process.on("uncaughtException", (error) => {
  safeLog(`🚨 UNCAUGHT EXCEPTION: ${error.stack || error.message}`);
});

const waitForCronToFinish = async (timeoutMs = 10000) => {
  const startedAt = Date.now();

  while (isHeartbeatCronRunning && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (isHeartbeatCronRunning) {
    safeLog("⚠️ Cron hâlâ çalışıyor, kapanış devam ediyor.");
  }
};

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  safeLog(`🛑 ${signal} alındı. Güvenli kapanış başlatılıyor...`);

  const forceExitTimer = setTimeout(() => {
    safeLog("⏰ Güvenli kapanış zaman aşımına uğradı. Zorla çıkılıyor.");
    process.exit(1);
  }, 25000);

  try {
    if (cronTask) {
      cronTask.stop();
      safeLog("✅ Cron task yeni tetiklemelere kapatıldı.");
    }

    await waitForCronToFinish(10000);

    if (server) {
      await new Promise((resolve) => {
        server.close(() => {
          safeLog("✅ HTTP sunucusu yeni istekleri kapattı.");
          resolve();
        });
      });
    }

    if (mqttClient) {
      mqttClient.options.reconnectPeriod = 0;

      await new Promise((resolve) => {
        mqttClient.end(false, {}, () => {
          safeLog("✅ MQTT bağlantısı düzgün kapatıldı.");
          resolve();
        });
      });
    }

    await admin.app().delete();
    safeLog("✅ Firebase Admin bağlantısı kapatıldı.");

    clearTimeout(forceExitTimer);

    safeLog("✅ Güvenli kapanış tamamlandı.");
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);

    safeLog(`❌ Güvenli kapanış hatası: ${error.message}`);
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// =========================================================
// Global Express Error Middleware
// Catches synchronous errors in middleware/routers and ensures a JSON response
// so clients don't hang waiting for a response.
// =========================================================
app.use((err, req, res, next) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  safeLog(`🚨 EXPRESS ERROR MIDDLEWARE: ${message}`);

  if (res.headersSent) {
    return next(err);
  }

  const statusCode = (err && err.status && Number(err.status)) || 500;

  return res.status(statusCode).json({
    error: err && err.message ? err.message : "Sunucu hatası.",
  });
});

// =========================================================
// START
// =========================================================
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const RUN_STARTUP_CLEAN = process.env.RUN_STARTUP_CLEAN === "true";

const startServer = () => {
  server = app.listen(PORT, HOST, () => {
    safeLog("🚀 QWash Sunucusu Başarıyla Başlatıldı!");
    safeLog(`📡 API Portu: ${PORT}`);
  });

  server.on("error", (error) => {
    safeLog(`❌ HTTP Server hatası: ${error.message}`);
  });
};

if (RUN_STARTUP_CLEAN) {
  systemStartupClean()
    .then(startServer)
    .catch((error) => {
      safeLog(`❌ Startup temizliği başlatılamadı: ${error.message}`);
      startServer();
    });
} else {
  safeLog("ℹ️ Startup temizliği atlandı. RUN_STARTUP_CLEAN=true değil.");
  startServer();
}
