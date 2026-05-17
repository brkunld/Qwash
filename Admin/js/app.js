import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  onValue,
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";

const firebaseConfig =
  window.electronAPI?.getFirebaseConfig?.() || window.FIREBASE_CONFIG;
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);
const API_BASE = "https://qwash-8q4y.onrender.com/api/admin";

async function getAdminToken() {
  const user = auth.currentUser;
  if (!user)
    throw new Error("Admin oturumu bulunamadı. Lütfen tekrar giriş yapın.");
  return await user.getIdToken(true);
}

async function adminFetch(path, options = {}) {
  const token = await getAdminToken();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
  };
  return await fetch(`${API_BASE}${path}`, { ...options, headers });
}


document.addEventListener("DOMContentLoaded", async () => {
  const views = ["monitor", "stats", "users", "bays"];
  for (const view of views) {
    try {
      const res = await fetch(`views/${view}.html`);
      if (res.ok) {
        const html = await res.text();
        document.getElementById(`tab-${view}`).innerHTML = html;
      }
    } catch (e) {
      console.error(`${view} sayfası yüklenemedi:`, e);
    }
  }
});

// --- ÖZEL BİLDİRİM (TOAST) SİSTEMİ ---
window.showToast = function (mesaj, tip = "error") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.style.cssText =
      "position: fixed; top: 24px; right: 24px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; pointer-events: none;";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  const bgRenk =
    tip === "success" ? "#10b981" : tip === "warning" ? "#f5a623" : "#ef4444";
  toast.style.cssText = `
          background: ${bgRenk}; color: white; padding: 16px 24px; border-radius: 12px;
          font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 600;
          box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); opacity: 0; transform: translateX(100%);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        `;
  toast.textContent = mesaj;
  container.appendChild(toast);

  // Animasyonla ekrana giriş yap
  requestAnimationFrame(() => {
    setTimeout(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(0)";
    }, 10);
  });

  // 3 saniye sonra ekrandan çık
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
};

// --- ÖZEL ONAY (CONFIRM) SİSTEMİ ---
window.showConfirm = function (mesaj) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("custom-confirm-overlay");
    const msgEl = document.getElementById("custom-confirm-msg");
    const btnYes = document.getElementById("custom-confirm-yes");
    const btnNo = document.getElementById("custom-confirm-no");

    msgEl.textContent = mesaj;
    overlay.style.display = "flex";

    // Temizleme ve kapatma işlemi
    const cleanup = () => {
      overlay.style.display = "none";
      btnYes.onclick = null;
      btnNo.onclick = null;
    };

    // "Evet"e basılırsa true döndür
    btnYes.onclick = () => {
      cleanup();
      resolve(true);
    };

    // "Hayır"a basılırsa false döndür
    btnNo.onclick = () => {
      cleanup();
      resolve(false);
    };
  });
};

window.appendLocalLog = function (mesaj, type = "info") {
  const entries = document.getElementById("log-entries");
  const div = document.createElement("div");
  div.className = "log-row";
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  let tagHtml = '<span class="log-tag lt-info">SİSTEM</span>';
  if (type === "error") tagHtml = '<span class="log-tag lt-err">HATA</span>';
  if (type === "success") tagHtml = '<span class="log-tag lt-ok">BİLGİ</span>';
  if (type === "warning")
    tagHtml = '<span class="log-tag lt-warn">UYARI</span>';
  div.innerHTML = `<span class="log-ts">${ts}</span>${tagHtml}<span class="log-msg">${mesaj}</span>`;
  entries.appendChild(div);
  entries.scrollTop = entries.scrollHeight;
};

const tabMeta = {
  monitor: { title: "Sistem Monitörü", crumb: "qwash / monitor" },
  stats: { title: "İstatistikler", crumb: "qwash / stats" },
  users: { title: "Kullanıcı İşlemleri", crumb: "qwash / users" },
  bays: { title: "Peron Yönetimi", crumb: "qwash / bays" },
  simulator: { title: "Cihaz Simülatörü", crumb: "qwash / simulator" },
};

window.switchTab = function (name, el) {
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.remove("active"));
  document
    .querySelectorAll(".nav-item")
    .forEach((n) => n.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  el.classList.add("active");
  document.getElementById("topbar-title").textContent = tabMeta[name].title;
  document.getElementById("topbar-crumb").textContent = tabMeta[name].crumb;
};

window.reloadCurrent = function () {
  const active = document.querySelector(".tab.active");
  active.style.opacity = "0.5";
  setTimeout(() => {
    active.style.opacity = "1";
  }, 300);
};

window.doLogin = async function () {
  const email = document.getElementById("email").value.trim();
  const pass = document.getElementById("password").value.trim();
  const err = document.getElementById("error-msg");
  const btn = document.getElementById("login-btn");
  if (!email || !pass) {
    err.textContent = "E-posta ve şifre zorunludur.";
    err.style.display = "block";
    return;
  }
  err.style.display = "none";
  btn.textContent = "Kontrol ediliyor...";
  btn.disabled = true;
  try {
    const credential = await signInWithEmailAndPassword(auth, email, pass);
    const tokenResult = await credential.user.getIdTokenResult();
    if (
      tokenResult.claims.admin === true ||
      tokenResult.claims.role === "admin"
    ) {
      document.getElementById("login-screen").style.display = "none";
      const displayName = credential.user.displayName || credential.user.email;
      const initials = displayName
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
      document.getElementById("sidebar-ava").textContent = initials;
      document.getElementById("sidebar-name").textContent = displayName;
      appendLocalLog(`Admin girişi yapıldı: ${displayName}`, "info");
      window.initBaysListener();
    } else {
      await signOut(auth);
      err.textContent = "Bu hesaba admin yetkisi tanımlanmamış!";
      err.style.display = "block";
    }
  } catch (e) {
    err.textContent = e.message;
    err.style.display = "block";
  } finally {
    btn.textContent = "Giriş Yap →";
    btn.disabled = false;
  }
};

["email", "password"].forEach((id) => {
  document.getElementById(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") window.doLogin();
  });
});

// --- YÜKLEME (LOADER) GÖSTER/GİZLE YARDIMCILARI ---
window.showLoader = function (mesaj = "Lütfen bekleyin...") {
  document.getElementById("loader-text").textContent = mesaj;
  document.getElementById("global-loader").style.display = "flex";
};

window.hideLoader = function () {
  document.getElementById("global-loader").style.display = "none";
};

// --- ÇIKIŞ YAPMA İŞLEMİ (GÜNCELLENDİ) ---
window.doLogout = async function () {
  // Çıkış yaparken dönen halkayı göster
  window.showLoader("Güvenli çıkış yapılıyor...");

  try {
    await signOut(auth);
  } catch (e) {
    console.error("Çıkış hatası:", e);
  } finally {
    // Kısa bir bekleme (animasyonun görünmesi için) sonrası giriş ekranına at
    setTimeout(() => {
      window.hideLoader();
      document.getElementById("login-screen").style.display = "flex";
      document.getElementById("email").value = "";
      document.getElementById("password").value = "";
      document.getElementById("error-msg").style.display = "none";
    }, 800); // 800 milisaniye (0.8 saniye) gösterip kapatır
  }
};

// --- UYGULAMAYI KAPATMA İŞLEMİ (GÜNCELLENDİ) ---
window.quitApplication = async function () {
  const onaylandi = await showConfirm(
    "Uygulamayı kapatmak istediğinize emin misiniz?",
  );

  if (onaylandi) {
    // Uygulama kapanırken de halkayı göster
    window.showLoader("Oturum kapatılıyor, uygulama sonlandırılıyor...");

    try {
      await signOut(auth);
    } catch (e) {
      console.error("Kapanış çıkış hatası:", e);
    }

    // Kapanma emrini gönder
    setTimeout(() => {
      if (window.electronAPI && window.electronAPI.closeApp) {
        window.electronAPI.closeApp();
      } else {
        window.hideLoader();
        showToast(
          "Tarayıcı modunda uygulama kapatılamaz, sadece sekmeyi kapatabilirsiniz.",
          "warning",
        );
      }
    }, 1000); // 1 saniye loading animasyonu gösterip sonra uygulamayı komple kapatır
  }
};

let selectedUserId = null;
let isUserBlocked = false;
window.doSearch = async function () {
  const term = document.getElementById("searchInput").value.trim();
  if (!term) return;
  const btn = document.getElementById("search-btn");
  const card = document.getElementById("userCard");
  btn.textContent = "Aranıyor...";
  btn.disabled = true;
  try {
    const res = await adminFetch("/search-user", {
      method: "POST",
      body: JSON.stringify({ arama: term }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "Kullanıcı bulunamadı!", "error");
      card.style.display = "none";
      selectedUserId = null;
      return;
    }
    const u = data.user;
    selectedUserId = u.id;
    isUserBlocked = !!u.isBlocked;
    const fullName = ((u.ad || "") + " " + (u.soyad || "")).trim() || u.email;
    const initials = fullName
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
    document.getElementById("uc-ava-icon").textContent = initials;
    document.getElementById("res-name").textContent = fullName;
    document.getElementById("res-email").textContent = u.email || "-";
    document.getElementById("res-tokens").textContent = u.walletTokens ?? 0;
    document.getElementById("res-phone").textContent =
      u.telefon || "Belirtilmemiş";
    document.getElementById("res-uid").textContent = u.id || "-";
    const badge = document.getElementById("res-blocked-badge");
    const blockBtn = document.getElementById("block-user-btn");
    if (isUserBlocked) {
      badge.style.display = "inline-block";
      blockBtn.textContent = "Engeli Kaldır";
      blockBtn.className = "btn-sm-accent btn-success";
    } else {
      badge.style.display = "none";
      blockBtn.textContent = "Kullanıcıyı Sistemden Engelle";
      blockBtn.className = "btn-sm-accent btn-danger";
    }
    card.style.display = "block";
  } catch (e) {
    showToast("Sunucuya ulaşılamadı!", "error");
  } finally {
    btn.textContent = "Bul";
    btn.disabled = false;
  }
};

document.getElementById("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") window.doSearch();
});

window.toggleUserBlock = async function () {
  if (!selectedUserId) return;
  const newState = !isUserBlocked;
  const isConfirmed = await showConfirm(
    newState
      ? "Kullanıcıyı engellemek istediğinize emin misiniz?"
      : "Kullanıcının engelini kaldırmak istediğinize emin misiniz?",
  );

  if (!isConfirmed) return;

  const btn = document.getElementById("block-user-btn");
  btn.disabled = true;
  try {
    const res = await adminFetch("/update-user", {
      method: "POST",
      body: JSON.stringify({
        userId: selectedUserId,
        patch: { isBlocked: newState },
      }),
    });
    if (!res.ok) {
      showToast("İşlem başarısız.", "error");
      return;
    }
    isUserBlocked = newState;
    const badge = document.getElementById("res-blocked-badge");
    if (isUserBlocked) {
      badge.style.display = "inline-block";
      btn.textContent = "Engeli Kaldır";
      btn.className = "btn-sm-accent btn-success";
      appendLocalLog(`Kullanıcı (${selectedUserId}) engellendi.`, "error");
    } else {
      badge.style.display = "none";
      btn.textContent = "Kullanıcıyı Sistemden Engelle";
      btn.className = "btn-sm-accent btn-danger";
      appendLocalLog(
        `Kullanıcı (${selectedUserId}) engeli kaldırıldı.`,
        "success",
      );
    }
  } catch (e) {
    showToast("Sunucu hatası.", "error");
  } finally {
    btn.disabled = false;
  }
};

document.getElementById("add-token-btn").addEventListener("click", async () => {
  if (!selectedUserId) return;

  const inputEl = document.getElementById("tokenAmt");
  const amount = parseInt(inputEl.value);

  if (isNaN(amount) || amount <= 0) {
    showToast("Geçerli jeton girin.", "warning");
    return;
  }

  const btn = document.getElementById("add-token-btn");

  // İşlem süresince butonu ve input'u geçici olarak kilitle
  btn.disabled = true;
  inputEl.disabled = true;

  try {
    const res = await adminFetch("/topup", {
      method: "POST",
      body: JSON.stringify({ userId: selectedUserId, tokens: amount }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast("Hata: " + data.error, "error");
      return;
    }

    const el = document.getElementById("res-tokens");
    el.textContent = parseInt(el.textContent || "0", 10) + amount;

    // İşlem başarılı oldu. UI kilitlerini kaldırıp kutuyu temizle
    inputEl.value = "";
    btn.disabled = false;
    inputEl.disabled = false;

    // --- SAĞ ÜSTTE ÇIKAN BİLDİRİM (FİYAT EKLENDİ) ---
    showToast(
      `${data.tokensAdded} jeton (${data.amountTRY} ₺) başarıyla eklendi.`,
      "success",
    );

    // Küçük bir gecikmeyle input'a tekrar odaklan
    setTimeout(() => {
      inputEl.focus();
    }, 50);

    // Sol taraftaki sistem loglarına da yazdır
    appendLocalLog(
      `Kullanıcıya (${selectedUserId}) ${data.tokensAdded} jeton (${data.amountTRY} ₺ karşılığında) yüklendi.`,
      "success",
    );
  } catch (e) {
    showToast("Sunucuya ulaşılamadı!", "error");
  } finally {
    // Hata olsa bile mutlaka kilitleri kaldır
    btn.disabled = false;
    inputEl.disabled = false;
  }
});

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
function setBar(id, labelId, percent) {
  const safePercent = Math.max(0, Math.min(100, percent));
  const bar = document.getElementById(id);
  const label = document.getElementById(labelId);
  if (bar) bar.style.width = `${safePercent}%`;
  if (label) label.textContent = `${safePercent}%`;
}

function updateStats(baysArray) {
  const total = baysArray.length;
  const active = baysArray.filter((b) => b.isActive !== false).length;
  const available = baysArray.filter(
    (b) => (b.status || "available") === "available" && b.isActive !== false,
  ).length;
  const busy = baysArray.filter(
    (b) => b.status === "busy" && b.isActive !== false,
  ).length;
  const maintenance = baysArray.filter(
    (b) => b.status === "maintenance",
  ).length;
  const offline = baysArray.filter(
    (b) => b.status === "offline" || b.isActive === false,
  ).length;
  const pct = (count) => (total > 0 ? Math.round((count / total) * 100) : 0);
  setText("stat-total-bays", total);
  setText("stat-active-bays", active);
  setText("stat-available-bays", available);
  setText("stat-busy-bays", busy);
  setText("stat-maint-bays", maintenance);
  setText("stat-offline-bays", offline);
  setBar("stat-bar-available", "stat-bar-available-label", pct(available));
  setBar("stat-bar-busy", "stat-bar-busy-label", pct(busy));
  setBar(
    "stat-bar-offline",
    "stat-bar-offline-label",
    pct(offline + maintenance),
  );
}

const STATUS_LABELS = {
  available: {
    text: "BOŞ",
    cls: "bb-avail",
    barCls: "bp-none",
    barW: "0%",
  },
  busy: { text: "DOLU", cls: "bb-busy", barCls: "bp-amber", barW: "65%" },
  maintenance: {
    text: "BAKIM",
    cls: "bb-maint",
    barCls: "bp-blue",
    barW: "45%",
  },
  offline: {
    text: "KAPALI",
    cls: "bb-off",
    barCls: "bp-none",
    barW: "0%",
  },
  waiting: {
    text: "BEKLEMEDE",
    cls: "bb-maint",
    barCls: "bp-blue",
    barW: "20%",
  },
};
const STATUS_CYCLE = ["available", "maintenance", "offline"];

let isBaysListening = false;
let previousBaysState = null;

window.initBaysListener = function () {
  if (isBaysListening) return;
  isBaysListening = true;
  const grid = document.getElementById("bay-list");
  const baysRef = ref(database, "bays");
  onValue(baysRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    grid.innerHTML = "";
    const baysArray = Object.keys(data)
      .map((key) => ({ id: key, ...data[key] }))
      .sort((a, b) => a.id.localeCompare(b.id));
    updateStats(baysArray);
    let aktifSayi = 0,
      mesgulSayi = 0;
    baysArray.forEach((bay) => {
      if (bay.isActive !== false) aktifSayi++;
      if (bay.status === "busy") mesgulSayi++;
      if (previousBaysState && previousBaysState[bay.id]) {
        const oldStatus = previousBaysState[bay.id].status;
        const newStatus = bay.status || "available";
        if (oldStatus !== newStatus) {
          if (newStatus === "busy")
            appendLocalLog(`${bay.id} çalışmaya başladı.`, "success");
          else if (newStatus === "maintenance")
            appendLocalLog(`${bay.id} bakıma alındı.`, "warn");
        }
      }
    });
    previousBaysState = data;
    document.getElementById("bay-count-label").textContent =
      `${baysArray.length} Peron · ${aktifSayi} Aktif`;
    document.getElementById("live-status-text").textContent =
      mesgulSayi > 0 ? `${mesgulSayi} Peron Çalışıyor` : "Tüm Peronlar Uygun";

    baysArray.forEach((bay) => {
      const status = bay.status || "available";
      const isActive = bay.isActive ?? true;
      const s = STATUS_LABELS[status] || STATUS_LABELS.offline;
      const card = document.createElement("div");
      card.className = `bay-card ${!isActive ? "passive" : ""}`;
      card.innerHTML = `
              <div class="bay-head">
                <span class="bay-name">${bay.id}</span>
                <span class="bay-badge ${s.cls}">${s.text}</span>
              </div>
              <div class="bay-meta">Sistem: <span>${bay.currentSessionId ? "Aktif İşlem Var" : "Boşta"}</span></div>
              <div class="bay-progress"><div class="bay-progress-bar ${s.barCls}" style="width:${s.barW}"></div></div>
              <div class="bay-btns">
                <button class="bay-btn" onclick="changeBayStatus('${bay.id}','${status}',${isActive})" ${!isActive ? "disabled" : ""}>Durum Değiştir</button>
                <button class="bay-btn ${isActive ? "red" : "green"}" onclick="toggleBayActive('${bay.id}',${isActive})">${isActive ? "Kapat" : "Aç"}</button>
              </div>`;
      grid.appendChild(card);
    });
  });
};

// === GÜNCELLENMİŞ PERON İŞLEMLERİ (ONAY SİSTEMLİ) ===

window.changeBayStatus = async function (bayId, currentStatus, isActive) {
  if (!isActive) return;
  const idx = STATUS_CYCLE.indexOf(currentStatus);
  const next = STATUS_CYCLE[idx === -1 ? 0 : (idx + 1) % STATUS_CYCLE.length];

  // Artık "available" durumuna geçerken de içeride müşteri varsa onay isteyecek
  if (previousBaysState && previousBaysState[bayId]) {
    const bay = previousBaysState[bayId];
    if (bay.status === "busy" || bay.currentSessionId) {
      const isConfirmed = await showConfirm(
        `DİKKAT: ${bayId} peronunda şu anda aktif bir araç yıkama işlemi var!\n\nYine de durumunu "${STATUS_LABELS[next].text}" olarak değiştirmek istiyor musunuz? (İşlem yarıda kesilebilir)`,
      );
      if (!isConfirmed) return; // Yönetici iptal etti
    }
  }

  adminFetch("/update-bay", {
    method: "POST",
    body: JSON.stringify({ bayId, patch: { status: next } }),
  });
};

window.toggleBayActive = async function (bayId, isCurrentlyActive) {
  // Eğer peron KAPATILIYORSA (offline) ve içeride müşteri varsa onay iste
  if (isCurrentlyActive && previousBaysState && previousBaysState[bayId]) {
    const bay = previousBaysState[bayId];
    if (bay.status === "busy" || bay.currentSessionId) {
      const isConfirmed = await showConfirm(
        `DİKKAT: ${bayId} peronunda şu anda aktif bir araç yıkama işlemi var!\n\nYine de peronu tamamen KAPATMAK istiyor musunuz?`,
      );
      if (!isConfirmed) return; // Yönetici iptal etti
    }
  }

  const patch = isCurrentlyActive
    ? { isActive: false, status: "offline" }
    : { isActive: true, status: "available" };
  adminFetch("/update-bay", {
    method: "POST",
    body: JSON.stringify({ bayId, patch }),
  });
};

window.bulkUpdateBays = async function (targetStatus) {
  const baysRef = ref(database, "bays");
  onValue(
    baysRef,
    async (snap) => {
      const data = snap.val();
      if (!data) return;

      // Artık targetStatus === "available" olsa BİLE içeride araç varsa kontrol edecek
      const busyBays = Object.values(data).filter(
        (bay) => bay.status === "busy" || bay.currentSessionId,
      );
      if (busyBays.length > 0) {
        const durumMetni =
          targetStatus === "maintenance"
            ? "BAKIMA ALMAK"
            : targetStatus === "available"
              ? "BOŞ YAPMAK"
              : targetStatus;
        const isConfirmed = await showConfirm(
          `DİKKAT: Şu anda ${busyBays.length} peronda aktif yıkama işlemi devam ediyor!\n\nYine de TÜM peronları toplu olarak "${durumMetni}" istiyor musunuz?`,
        );
        if (!isConfirmed) return; // Yönetici iptal etti
      }

      Object.keys(data).forEach((bayId) =>
        adminFetch("/update-bay", {
          method: "POST",
          body: JSON.stringify({
            bayId,
            patch: { isActive: true, status: targetStatus },
          }),
        }),
      );
    },
    { onlyOnce: true },
  );
};

window.bulkDisableBays = async function () {
  const baysRef = ref(database, "bays");
  onValue(
    baysRef,
    async (snap) => {
      const data = snap.val();
      if (!data) return;

      // Toplu kapatma öncesi meşgul peronları bul
      const busyBays = Object.values(data).filter(
        (bay) => bay.status === "busy" || bay.currentSessionId,
      );
      if (busyBays.length > 0) {
        const isConfirmed = await showConfirm(
          `DİKKAT: Şu anda ${busyBays.length} peronda aktif yıkama işlemi devam ediyor!\n\nYine de TÜM peronları toplu olarak KAPATMAK istiyor musunuz?`,
        );
        if (!isConfirmed) return; // Yönetici iptal etti
      }

      Object.keys(data).forEach((bayId) =>
        adminFetch("/update-bay", {
          method: "POST",
          body: JSON.stringify({
            bayId,
            patch: { isActive: false, status: "offline" },
          }),
        }),
      );
    },
    { onlyOnce: true },
  );
};

window.bulkEnableBays = async function () {
  const baysRef = ref(database, "bays");
  onValue(
    baysRef,
    async (snap) => {
      const data = snap.val();
      if (!data) return;

      // "Tümünü Aktif Et" (Available) butonuna da onay mekanizması eklendi
      const busyBays = Object.values(data).filter(
        (bay) => bay.status === "busy" || bay.currentSessionId,
      );
      if (busyBays.length > 0) {
        const isConfirmed = await showConfirm(
          `DİKKAT: Şu anda ${busyBays.length} peronda aktif yıkama işlemi devam ediyor!\n\nYine de TÜM peronları toplu olarak AKTİF VE BOŞ hale getirmek istiyor musunuz?`,
        );
        if (!isConfirmed) return; // Yönetici iptal etti
      }

      Object.keys(data).forEach((bayId) =>
        adminFetch("/update-bay", {
          method: "POST",
          body: JSON.stringify({
            bayId,
            patch: { isActive: true, status: "available" },
          }),
        }),
      );
    },
    { onlyOnce: true },
  );
};

setInterval(() => {
  const now = new Date();
  document.getElementById("clock").textContent =
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}, 1000);
