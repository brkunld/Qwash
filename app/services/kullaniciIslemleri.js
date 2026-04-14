import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import NfcManager, { Ndef, NfcEvents } from "react-native-nfc-manager";

import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";

import { auth, db } from "../../firebase";

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

  // --- NFC SESSİZ DİNLEME (ARKAPLAN) ---
  useEffect(() => {
    let isMounted = true;

    const initNfc = async () => {
      try {
        // NFC'yi başlat
        await NfcManager.start();

        // NFC okunduğunda tetiklenecek olay
        NfcManager.setEventListener(NfcEvents.DiscoverTag, (tag) => {
          if (!isMounted) return;

          try {
            // NDEF verisini çöz
            if (tag.ndefMessage && tag.ndefMessage.length > 0) {
              const ndefRecord = tag.ndefMessage[0];
              // Payload'ı metne çevir (NFC etiketindeki yazıyı alır)
              const raw = Ndef.text.decodePayload(ndefRecord.payload);
              let okunantBayId = raw.trim();

              // QR kameradaki aynı ayrıştırma (parse) kuralları
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

              // Başarılıysa, sayfayı yeni bayId ile günceller
              // (Mevcut sayfada parametreyi değiştirmek, var olan bayId useEffect'ini tetikler)
              router.setParams({ bayId: okunantBayId });
            }
          } catch (err) {
            console.log("NFC Parse Hatası:", err);
          } finally {
            // Yeni okumalara hazır olmak için kaydı iptal edip tekrar başlatıyoruz
            NfcManager.unregisterTagEvent().catch(() => {});
            setTimeout(() => {
              NfcManager.registerTagEvent().catch(() => {});
            }, 1000);
          }
        });

        // Android'de ekrandayken sessizce etiketi beklemeyi başlat
        await NfcManager.registerTagEvent();
      } catch (ex) {
        console.log("NFC başlatılamadı veya desteklenmiyor", ex);
      }
    };

    initNfc();

    // Bileşen kapatıldığında/sayfadan çıkıldığında dinlemeyi durdur
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

    const bayRef = doc(db, "bays", id);
    setBayYukleniyor(true);

    const unsub = onSnapshot(
      bayRef,
      (snap) => {
        if (!snap.exists()) {
          setSeciliBay(null);
          setBayYukleniyor(false);
          return;
        }

        const data = snap.data();

        if (data?.isActive === false || data?.status === "maintenance") {
          setSeciliBay(null);
          setBayYukleniyor(false);
          return;
        }

        setSeciliBay({ id: snap.id, ...data });
        setBayYukleniyor(false);
      },
      () => {
        setSeciliBay(null);
        setBayYukleniyor(false);
        Alert.alert("Hata", "Bay bilgisi alınamadı.");
      },
    );

    return () => unsub();
  }, [bayId]);

  useEffect(() => {
    const sessionId = seciliBay?.currentSessionId ?? null;

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
  }, [seciliBay?.currentSessionId]);

  const sessionBitir = useCallback(
    async (reason = "user_stop") => {
      if (!uid) return router.replace("/login");
      if (!seciliBay?.id || !seciliBay?.currentSessionId) return;
      if (sessionBitiriliyorRef.current) return;

      const bayRef = doc(db, "bays", seciliBay.id);
      const sRef = doc(db, "sessions", seciliBay.currentSessionId);

      sessionBitiriliyorRef.current = true;
      setSessionBitiriliyor(true);

      try {
        await runTransaction(db, async (t) => {
          const sSnap = await t.get(sRef);
          const baySnap = await t.get(bayRef);

          if (sSnap.exists()) {
            const s = sSnap.data();
            if (s?.status === "running") {
              t.set(
                sRef,
                {
                  status: "ended",
                  endedAt: serverTimestamp(),
                  endedReason: reason,
                },
                { merge: true },
              );
            }
          }

          if (baySnap.exists()) {
            const b = baySnap.data();
            if (b?.currentSessionId === seciliBay.currentSessionId) {
              t.set(
                bayRef,
                {
                  status: "available",
                  currentSessionId: null,
                  updatedAt: serverTimestamp(),
                },
                { merge: true },
              );
            }
          }
        });
      } catch {
        Alert.alert("Hata", "Session kapatılamadı.");
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

  const sessionBaslat = async (packageId) => {
    if (!uid) return router.replace("/login");
    if (!seciliBay?.id) return Alert.alert("Bay yok", "Önce QR ile bay bağla.");

    if (seciliBay?.status !== "available" || seciliBay?.currentSessionId) {
      return Alert.alert("Bay dolu", "Bu bay şu anda kullanımda.");
    }

    setSessionYukleniyor(true);

    try {
      const paket = await paketGetir(packageId);
      if (!paket) {
        Alert.alert("Paket yok", `packages/${packageId} bulunamadı.`);
        return;
      }

      const userRef = doc(db, "users", uid);
      const bayRef = doc(db, "bays", seciliBay.id);
      const paketRef = doc(db, "packages", packageId);
      const sessionRef = doc(collection(db, "sessions"));
      const txRef = doc(collection(db, "transactions"));

      await runTransaction(db, async (t) => {
        const baySnap = await t.get(bayRef);
        const pSnap = await t.get(paketRef);
        const userSnap = await t.get(userRef);

        if (!baySnap.exists()) throw new Error("bay_not_found");
        if (!pSnap.exists()) throw new Error("package_not_found");

        const bayData = baySnap.data();
        if (bayData?.isActive === false) throw new Error("bay_inactive");
        if (bayData?.status !== "available") throw new Error("bay_busy");
        if (bayData?.currentSessionId) throw new Error("bay_has_session");

        const p = pSnap.data();
        const pTokens = Number(p?.tokensCost ?? 0);
        const pDuration = Number(p?.durationSec ?? 0);
        const mevcut = userSnap.exists()
          ? Number(userSnap.data()?.walletTokens ?? 0)
          : 0;

        if (mevcut < pTokens) throw new Error("insufficient_tokens");

        t.set(
          userRef,
          { walletTokens: mevcut - pTokens, updatedAt: serverTimestamp() },
          { merge: true },
        );

        t.set(sessionRef, {
          bayId: seciliBay.id,
          userId: uid,
          type: packageId,
          packageId,
          tokensCost: pTokens,
          durationSec: pDuration,
          status: "running",
          startedAt: serverTimestamp(),
          endedAt: null,
          endedReason: null,
          createdAt: serverTimestamp(),
        });

        t.set(
          bayRef,
          {
            status: "busy",
            currentSessionId: sessionRef.id,
            lastUserId: uid,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );

        t.set(txRef, {
          type: packageId,
          status: "success",
          tokens: pTokens,
          amountTRY: 0,
          unitPriceTRY: null,
          userId: uid,
          adminId: null,
          bayId: seciliBay.id,
          packageId,
          sessionId: sessionRef.id,
          createdAt: serverTimestamp(),
        });
      });
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("insufficient_tokens")) {
        Alert.alert("Yetersiz Bakiye", "Jeton bakiyeniz yeterli değil.");
      } else if (msg.includes("bay_busy") || msg.includes("bay_has_session")) {
        Alert.alert("Bay Dolu", "Bu bay şu anda kullanımda.");
      } else {
        Alert.alert("Hata", "Session başlatılamadı.");
      }
    } finally {
      setSessionYukleniyor(false);
    }
  };

  const bakiyeYukle = async (tokens, amountTRYParam) => {
    if (!uid) return router.replace("/login");

    if (!jetonFiyat || fiyatYukleniyor) {
      Alert.alert("Fiyat Alınamadı", "Fiyat bilgisi alınamadı.");
      return;
    }

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

    try {
      const userRef = doc(db, "users", uid);
      const txRef = doc(collection(db, "transactions"));
      const unitPriceTRY = jetonFiyat;
      const amountTRY =
        typeof amountTRYParam === "number"
          ? amountTRYParam
          : tokens * unitPriceTRY;

      await runTransaction(db, async (t) => {
        const userSnap = await t.get(userRef);
        const mevcut = userSnap.exists()
          ? Number(userSnap.data()?.walletTokens ?? 0)
          : 0;

        t.set(
          userRef,
          { walletTokens: mevcut + tokens, updatedAt: serverTimestamp() },
          { merge: true },
        );

        t.set(txRef, {
          type: "topup",
          status: "success",
          tokens,
          unitPriceTRY,
          amountTRY,
          userId: uid,
          adminId: null,
          bayId: null,
          packageId: null,
          sessionId: null,
          createdAt: serverTimestamp(),
        });
      });

      setYuklemeAcik(false);
      setKartNo("");
      setSonKullanma("");
      setCvv("");
    } catch {
      Alert.alert("Hata", "Bakiye yükleme başarısız.");
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
          updatedAt: serverTimestamp(),
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

  const qrKameraAc = () => router.push("/qr-kamera");

  const cikisYap = async () => {
    try {
      await signOut(auth);
      router.replace("/login");
    } catch {
      Alert.alert("Hata", "Çıkış yapılamadı.");
    }
  };

  const bayDurum = seciliBay?.status ?? "available";
  const bayBagliMi = !!seciliBay?.id;
  const bayMusaitMi = bayDurum === "available" && !seciliBay?.currentSessionId;

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
    qrKameraAc,
    cikisYap,
  };
}
