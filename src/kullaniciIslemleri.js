import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import NfcManager, { Ndef, NfcEvents } from "react-native-nfc-manager";

import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  doc,
  serverTimestamp as firestoreServerTimestamp,
  getDoc,
  onSnapshot,
  setDoc,
} from "firebase/firestore";

// DİKKAT: RTDB fonksiyonları eklendi
import {
  onValue,
  ref,
  serverTimestamp as rtdbServerTimestamp,
  update,
} from "firebase/database";

import { auth, db, rtdb } from "../firebase"; // rtdb exportunuzu import etmeyi unutmayın

export function useKullaniciIslemleri() {
  const { bayId } = useLocalSearchParams();
  const router = useRouter();

  const [currentUser, setCurrentUser] = useState(null);
  const [authYukleniyor, setAuthYukleniyor] = useState(true);
  const uid = currentUser?.uid ?? null;

  const [seciliBay, setSeciliBay] = useState(null);
  const [bayYukleniyor, setBayYukleniyor] = useState(false);

  const [bakiye, setBakiye] = useState(0);
  const [bakiyeYukleniyor, setBakiyeYukleniyor] = useState(true);

  const [jetonAdet, setJetonAdet] = useState("1");
  const [jetonFiyat, setJetonFiyat] = useState(null);
  const [fiyatYukleniyor, setFiyatYukleniyor] = useState(true);

  const [profilAcik, setProfilAcik] = useState(false);
  const [profilYukleniyor, setProfilYukleniyor] = useState(true);
  const [profilKaydediyor, setProfilKaydediyor] = useState(false);
  const [ad, setAd] = useState("");
  const [soyad, setSoyad] = useState("");
  const [telefon, setTelefon] = useState("");

  const [yuklemeAcik, setYuklemeAcik] = useState(false);
  const [yuklemeIslemde, setYuklemeIslemde] = useState(false);
  const [kartNo, setKartNo] = useState("");
  const [sonKullanma, setSonKullanma] = useState("");
  const [cvv, setCvv] = useState("");

  const [aktifSession, setAktifSession] = useState(null);
  const [sessionYukleniyor, setSessionYukleniyor] = useState(false);
  const [sayacKalanSn, setSayacKalanSn] = useState(null);

  const [sessionBitiriliyor, setSessionBitiriliyor] = useState(false);
  const sessionBitiriliyorRef = useRef(false);
  const timeoutKapattiRef = useRef(false);

  const adetNum = useMemo(() => {
    const n = parseInt(String(jetonAdet || "0"), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, 100);
  }, [jetonAdet]);

  const toplamTRY = useMemo(() => {
    if (!jetonFiyat) return 0;
    return adetNum * jetonFiyat;
  }, [adetNum, jetonFiyat]);

  const toplamText = useMemo(() => {
    try {
      return toplamTRY.toLocaleString("tr-TR");
    } catch {
      return String(toplamTRY);
    }
  }, [toplamTRY]);

  // --- NFC SESSİZ DİNLEME VE REZERVASYON (ARKAPLAN) ---
  useEffect(() => {
    let isMounted = true;

    const initNfc = async () => {
      try {
        await NfcManager.start();

        // Veritabanı işlemini (update) bekleyebilmek için callback'i async yapıyoruz
        NfcManager.setEventListener(NfcEvents.DiscoverTag, async (tag) => {
          if (!isMounted) return;

          try {
            if (tag.ndefMessage && tag.ndefMessage.length > 0) {
              const ndefRecord = tag.ndefMessage[0];
              const raw = Ndef.text.decodePayload(ndefRecord.payload);
              let okunantBayId = raw.trim();

              if (okunantBayId.startsWith("{")) {
                try {
                  const obj = JSON.parse(okunantBayId);
                  if (obj?.id) okunantBayId = String(obj.id).trim();
                } catch {}
              }

              okunantBayId = okunantBayId.replace(/^\/?bays\//i, "").trim();
              okunantBayId = okunantBayId.replace(/\s+/g, "");

              const re = /^bay_\d{5}_\d{2}_\d{2}$/i;

              if (!re.test(okunantBayId)) {
                Alert.alert(
                  "Geçersiz NFC",
                  `Okunan: "${raw}"\nBeklenen örnek: bay_42060_01_01`,
                );
                return;
              }

              // 1. NFC geçerli, yükleme durumunu başlat
              setBayYukleniyor(true);

              try {
                // 2. RTDB'de modülü "waiting" olarak güncelle
                const bayRef = ref(rtdb, `bays/${okunantBayId}`);
                await update(bayRef, {
                  status: "waiting",
                  updatedAt: rtdbServerTimestamp(), // Eğer import isminiz rtdbServerTimestamp ise
                });
              } catch (updateErr) {
                console.log("NFC Waiting Update Hatası", updateErr);
                Alert.alert("Hata", "Peron rezerve edilemedi.");
                setBayYukleniyor(false);
                return; // Veritabanı hatası varsa perona bağlanmayı durdur
              }

              // 3. Güncelleme başarılıysa URL parametresini ayarla ve perona bağlan
              router.setParams({ bayId: okunantBayId });
            }
          } catch (err) {
            console.log("NFC Parse Hatası:", err);
            setBayYukleniyor(false);
          } finally {
            NfcManager.unregisterTagEvent().catch(() => {});
            setTimeout(() => {
              // Sadece bileşen hala ekrandaysa tekrar okumaya aç
              if (isMounted) NfcManager.registerTagEvent().catch(() => {});
            }, 1000);
          }
        });

        await NfcManager.registerTagEvent();
      } catch (ex) {
        console.log("NFC başlatılamadı veya desteklenmiyor", ex);
      }
    };

    initNfc();

    return () => {
      isMounted = false;
      NfcManager.setEventListener(NfcEvents.DiscoverTag, null);
      NfcManager.unregisterTagEvent().catch(() => {});
    };
  }, [router]);
  // ------------------------------------

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user ?? null);
      setAuthYukleniyor(false);
      if (!user) router.replace("/login");
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    const fiyatRef = doc(db, "packages", "jeton");
    setFiyatYukleniyor(true);

    const unsub = onSnapshot(
      fiyatRef,
      (snap) => {
        if (!snap.exists()) {
          setJetonFiyat(null);
          setFiyatYukleniyor(false);
          return;
        }

        const data = snap.data();
        const fiyatRaw =
          data?.jetonFiyat ??
          data?.jetonfiyat ??
          data?.unitPriceTRY ??
          data?.unitPrice ??
          null;

        const fiyat = typeof fiyatRaw === "number" ? fiyatRaw : null;
        setJetonFiyat(fiyat && fiyat > 0 ? fiyat : null);
        setFiyatYukleniyor(false);
      },
      () => {
        setJetonFiyat(null);
        setFiyatYukleniyor(false);
      },
    );

    return () => unsub();
  }, []);

  useEffect(() => {
    if (!uid) return;

    const userRef = doc(db, "users", uid);
    setBakiyeYukleniyor(true);
    setProfilYukleniyor(true);

    const unsub = onSnapshot(
      userRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          setBakiye(Number(data?.walletTokens ?? 0));
          setAd(String(data?.ad ?? ""));
          setSoyad(String(data?.soyad ?? ""));
          setTelefon(String(data?.telefon ?? ""));
        } else {
          setBakiye(0);
          setAd("");
          setSoyad("");
          setTelefon("");
        }

        setBakiyeYukleniyor(false);
        setProfilYukleniyor(false);
      },
      () => {
        Alert.alert("Hata", "Kullanıcı bilgileri alınamadı.");
        setBakiyeYukleniyor(false);
        setProfilYukleniyor(false);
      },
    );

    return () => unsub();
  }, [uid]);

  // --- OTOMATİK BAĞLANTI KESME (1 Dk İşlemsizlik) ---
  // Sadece ekrandan atmak için görsel zamanlayıcı (Firebase işlemi sunucuda)
  // Sunucunun süreyi bitirip bitirmediğini dinleyen sistem
  useEffect(() => {
    // Eğer ekranda bir peron seçiliyse (bayId varsa)
    // VE sunucu o peronun durumunu "available" (müsait) yaptıysa:
    if (bayId && seciliBay?.status === "available") {
      Alert.alert(
        "Zaman Aşımı",
        "Süreniz doldu veya işlem yapmadığınız için peron bağlantısı kesildi.",
      );
      router.setParams({ bayId: "" }); // Kullanıcıyı peron ekranından at
    }
  }, [bayId, seciliBay?.status, router]);
  // ---------------------------------------------------

  // ========================================================
  // BAY (PERON) DİNLEME MANTIĞI RTDB'YE TAŞINDI
  // ========================================================
  useEffect(() => {
    if (!bayId) {
      setSeciliBay(null);
      return;
    }

    const id = String(bayId).trim();
    const re = /^bay_\d{5}_\d{2}_\d{2}$/i;

    if (!re.test(id)) {
      setSeciliBay(null);
      Alert.alert("Geçersiz QR", "Beklenen format: bay_42060_01_01");
      return;
    }

    setBayYukleniyor(true);
    const bayRef = ref(rtdb, `bays/${id}`);

    // RTDB'den onValue ile anlık dinleme yapıyoruz
    const unsubscribe = onValue(
      bayRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setSeciliBay(null);
          setBayYukleniyor(false);
          return;
        }

        const data = snapshot.val();

        if (data?.isActive === false || data?.status === "maintenance") {
          setSeciliBay(null);
          setBayYukleniyor(false);
          return;
        }

        setSeciliBay({ id, ...data });
        setBayYukleniyor(false);
      },
      (error) => {
        console.error("RTDB Dinleme Hatası:", error);
        setSeciliBay(null);
        setBayYukleniyor(false);
        Alert.alert("Hata", "Bay bilgisi alınamadı.");
      },
    );

    return () => unsubscribe();
  }, [bayId]);

  // Session dinleme Firestore'da kalıyor (Geçmiş ve kalıcı kayıtlar olduğu için)
  useEffect(() => {
    const sessionId = seciliBay?.currentSessionId ?? null;

    // YENİ: ZOMBİ SESSION TEMİZLİĞİ
    // Eğer ESP32 biz uygulamayı kapatmışken süreyi bitirip RTDB'yi temizlediyse
    // ama bizim uygulamada aktifSession hala 'running' kaldıysa Firestore'u temizle.
    if (!sessionId && aktifSession?.status === "running") {
      const sRef = doc(db, "sessions", aktifSession.id);
      setDoc(
        sRef,
        {
          status: "ended",
          endedAt: firestoreServerTimestamp(),
          endedReason: "machine_timeout_background",
        },
        { merge: true },
      ).catch((err) => console.log("Zombi session kapatılamadı:", err));
    }

    if (!sessionId) {
      setAktifSession(null);
      setSayacKalanSn(null);
      timeoutKapattiRef.current = false;
      return;
    }

    const sRef = doc(db, "sessions", sessionId);
    setSessionYukleniyor(true);

    const unsub = onSnapshot(
      sRef,
      (snap) => {
        if (!snap.exists()) {
          setAktifSession(null);
          setSessionYukleniyor(false);
          return;
        }

        setAktifSession({ id: snap.id, ...snap.data() });
        setSessionYukleniyor(false);
      },
      () => {
        setAktifSession(null);
        setSessionYukleniyor(false);
      },
    );

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seciliBay?.currentSessionId]);

  // kullaniciIslemleri.js içerisindeki YENİ sessionBitir fonksiyonu

  const sessionBitir = useCallback(
    async (reason = "user_stop") => {
      if (!uid) return router.replace("/login");
      if (!seciliBay?.id || !seciliBay?.currentSessionId) return;
      if (sessionBitiriliyorRef.current) return;

      sessionBitiriliyorRef.current = true;
      setSessionBitiriliyor(true);

      try {
        // DİKKAT: Buradaki IP adresini de kendi Kendi PC IP adresin ile değiştir!
        const API_URL = "http://192.168.1.159:3000/api/stop-session";

        const response = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uid: uid,
            bayId: seciliBay.id,
            sessionId: seciliBay.currentSessionId,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          Alert.alert("Hata", data.error || "Oturum durdurulamadı.");
        }
        // Başarılı olursa RTDB anında güncellenir ve ekran zaten boşa döner.
      } catch (err) {
        console.error("Session kapatma hatası:", err);
        Alert.alert("Sunucu Hatası", "Sunucuya ulaşılamadı.");
      } finally {
        sessionBitiriliyorRef.current = false;
        setSessionBitiriliyor(false);
      }
    },
    [uid, router, seciliBay],
  );

  const sessionId = aktifSession?.id;
  const sessionStatus = aktifSession?.status;
  const startedAt = aktifSession?.startedAt;
  const durSec = aktifSession?.durationSec;

  useEffect(() => {
    if (!sessionId || sessionStatus !== "running") {
      setSayacKalanSn(null);
      timeoutKapattiRef.current = false;
      return;
    }

    const startedMs = startedAt?.toMillis?.();
    const durationSecNum = Number(durSec ?? 0);

    if (!startedMs || !Number.isFinite(durationSecNum) || durationSecNum <= 0) {
      setSayacKalanSn(null);
      return;
    }

    const tick = () => {
      const biterMs = startedMs + durationSecNum * 1000;
      const kalan = Math.ceil((biterMs - Date.now()) / 1000);
      setSayacKalanSn(Math.max(0, kalan));

      if (kalan <= 0 && !timeoutKapattiRef.current) {
        timeoutKapattiRef.current = true;
        sessionBitir("timeout").catch(() => {});
      }
    };

    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [sessionId, sessionStatus, startedAt, durSec, sessionBitir]);

  const paketGetir = async (packageId) => {
    const snap = await getDoc(doc(db, "packages", packageId));
    if (!snap.exists()) return null;

    const d = snap.data();
    return {
      packageId,
      title: String(d?.title ?? packageId),
      durationSec: Number(d?.durationSec ?? 0),
      tokensCost: Number(d?.tokensCost ?? 0),
    };
  };

  // kullaniciIslemleri.js içerisindeki YENİ sessionBaslat fonksiyonu

  const sessionBaslat = async (packageId) => {
    if (!uid) return router.replace("/login");
    if (!seciliBay?.id) return Alert.alert("Bay yok", "Önce peron bağlayın.");

    if (
      (seciliBay?.status !== "available" && seciliBay?.status !== "waiting") ||
      seciliBay?.currentSessionId
    ) {
      return Alert.alert("Peron Dolu", "Bu peron şu anda kullanımda.");
    }

    if (sessionYukleniyor) return;
    setSessionYukleniyor(true);

    try {
      const paket = await paketGetir(packageId);
      if (!paket) {
        Alert.alert("Hata", "Paket bilgisi bulunamadı.");
        setSessionYukleniyor(false);
        return;
      }

      // DİKKAT: Buradaki IP adresini KENDİ IPv4 ADRESİN İLE DEĞİŞTİR!
      // Eğer Android Emulator kullanıyorsan "http://10.0.2.2:3000/api/start-session" yap.
      const API_URL = "http://192.168.1.159:3000/api/start-session";

      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uid: uid,
          bayId: seciliBay.id,
          packageId: packageId,
          tokensCost: paket.tokensCost,
          durationSec: paket.durationSec,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        Alert.alert("Hata", data.error || "İşlem yapılamadı.");
      }
    } catch (e) {
      console.error("API İletişim Hatası:", e);
      Alert.alert(
        "Sunucu Hatası",
        "Kendi sunucumuza ulaşılamadı. Node.js çalışıyor mu?",
      );
    } finally {
      setSessionYukleniyor(false);
    }
  };

  // kullaniciIslemleri.js içerisindeki YENİ bakiyeYukle fonksiyonu

  const bakiyeYukle = async (tokens, amountTRYParam) => {
    if (!uid) return router.replace("/login");

    if (!jetonFiyat || fiyatYukleniyor) {
      Alert.alert("Fiyat Alınamadı", "Fiyat bilgisi alınamadı.");
      return;
    }

    // Kart bilgilerini temizle ve doğrula
    const kart = String(kartNo).replace(/\s/g, "");
    const skt = String(sonKullanma).trim();
    const c = String(cvv).trim();

    if (kart.length < 12 || kart.length > 19) {
      Alert.alert("Hata", "Kart numarası geçersiz.");
      return;
    }
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(skt)) {
      Alert.alert("Hata", "Son kullanma formatı AA/YY olmalı.");
      return;
    }
    if (!/^\d{3,4}$/.test(c)) {
      Alert.alert("Hata", "CVV geçersiz.");
      return;
    }

    setYuklemeIslemde(true);
    const unitPriceTRY = jetonFiyat;
    const amountTRY =
      typeof amountTRYParam === "number"
        ? amountTRYParam
        : tokens * unitPriceTRY;

    try {
      // DİKKAT: IP adresini kendi PC adresin ile değiştirmeyi unutma!
      const API_URL = "http://192.168.1.159:3000/api/topup";

      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uid: uid,
          tokens: tokens,
          amountTRY: amountTRY,
          kartNo: kart,
          sonKullanma: skt,
          cvv: c,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        Alert.alert("Hata", data.error || "Bakiye yükleme başarısız.");
        return;
      }

      // İşlem Başarılıysa Formu Temizle
      Alert.alert("Başarılı", `${tokens} Jeton hesabınıza eklendi!`);
      setYuklemeAcik(false);
      setKartNo("");
      setSonKullanma("");
      setCvv("");
    } catch (e) {
      console.error("Yükleme API Hatası:", e);
      Alert.alert("Bağlantı Hatası", "Sunucuya ulaşılamadı.");
    } finally {
      setYuklemeIslemde(false);
    }
  };

  const profilKaydet = async () => {
    if (!uid) return router.replace("/login");

    const adTemiz = ad.trim();
    const soyadTemiz = soyad.trim();
    const telTemiz = telefon.trim();

    if (!adTemiz) return Alert.alert("Hata", "Ad boş olamaz.");
    if (!soyadTemiz) return Alert.alert("Hata", "Soyad boş olamaz.");
    if (!/^[1-9][0-9]{9}$/.test(telTemiz)) {
      return Alert.alert(
        "Hata",
        "Telefon 10 haneli olmalı ve 0 ile başlamamalı.",
      );
    }

    setProfilKaydediyor(true);

    try {
      const userRef = doc(db, "users", uid);

      await setDoc(
        userRef,
        {
          ad: adTemiz,
          soyad: soyadTemiz,
          telefon: telTemiz,
          updatedAt: firestoreServerTimestamp(),
        },
        { merge: true },
      );

      Alert.alert("Başarılı", "Profil güncellendi.");
      setProfilAcik(false);
    } catch {
      Alert.alert("Hata", "Profil güncellenemedi.");
    } finally {
      setProfilKaydediyor(false);
    }
  };

  const cikisYap = async () => {
    try {
      await signOut(auth);
      router.replace("/login");
    } catch {
      Alert.alert("Hata", "Çıkış yapılamadı.");
    }
  };

  // ========================================================
  // ESP32 FİZİKSEL DOKUNMATİK EKRAN (TOUCH) SİNYALİ DİNLEME
  // ========================================================
  useEffect(() => {
    // Eğer donanımdan bir seçim (wash veya foam) geldiyse
    if (seciliBay?.hardwareSelection) {
      const secilenPaket = seciliBay.hardwareSelection;

      // 1. Sonsuz döngüye girmemek için RTDB'den bu talebi anında temizle
      const rtdbBayRef = ref(rtdb, `bays/${seciliBay.id}`);

      update(rtdbBayRef, { hardwareSelection: null })
        .then(() => {
          // 2. Mobildeki ödeme ve başlatma sürecini otomatik tetikle
          sessionBaslat(secilenPaket);
        })
        .catch((err) =>
          console.error("Donanım seçimini temizleme hatası:", err),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seciliBay?.hardwareSelection, seciliBay?.id]);

  const bayDurum = seciliBay?.status ?? "available";
  const bayBagliMi = !!seciliBay?.id;
  const bayMusaitMi =
    (bayDurum === "available" || bayDurum === "waiting") &&
    !seciliBay?.currentSessionId;

  const sessionVarMi = !!seciliBay?.currentSessionId;
  const sessionRunningMi = aktifSession?.status === "running";

  const butonKilitli =
    !bayBagliMi ||
    !bayMusaitMi ||
    sessionYukleniyor ||
    sessionBitiriliyor ||
    bakiyeYukleniyor;

  const sayacText =
    sayacKalanSn == null
      ? null
      : `${Math.floor(sayacKalanSn / 60)}:${String(sayacKalanSn % 60).padStart(2, "0")}`;

  const sessionTurLabel =
    aktifSession?.type === "wash"
      ? "Su"
      : aktifSession?.type === "foam"
        ? "Köpük"
        : String(aktifSession?.type ?? "-");

  return {
    authYukleniyor,
    uid,

    seciliBay,
    bayYukleniyor,

    bakiye,
    bakiyeYukleniyor,

    jetonAdet,
    setJetonAdet,
    jetonFiyat,
    fiyatYukleniyor,
    toplamTRY,
    toplamText,
    adetNum,

    profilAcik,
    setProfilAcik,
    profilYukleniyor,
    profilKaydediyor,
    ad,
    setAd,
    soyad,
    setSoyad,
    telefon,
    setTelefon,

    yuklemeAcik,
    setYuklemeAcik,
    yuklemeIslemde,
    kartNo,
    setKartNo,
    sonKullanma,
    setSonKullanma,
    cvv,
    setCvv,

    aktifSession,
    sessionYukleniyor,
    sayacText,
    sessionBitiriliyor,
    sessionVarMi,
    sessionRunningMi,
    sessionTurLabel,

    butonKilitli,

    sessionBaslat,
    sessionBitir,
    bakiyeYukle,
    profilKaydet,
    cikisYap,
  };
}
