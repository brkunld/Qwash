import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import NfcManager, { Ndef, NfcEvents } from "react-native-nfc-manager";

import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  doc,
  serverTimestamp as firestoreServerTimestamp,
  getDoc,
  onSnapshot,
  runTransaction as runFirestoreTransaction,
  setDoc,
} from "firebase/firestore";

// DİKKAT: RTDB fonksiyonları eklendi
import {
  get as getRtdb,
  onValue,
  ref,
  serverTimestamp as rtdbServerTimestamp,
  set as setRtdb,
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

  // --- NFC SESSİZ DİNLEME (ARKAPLAN) ---
  useEffect(() => {
    let isMounted = true;

    const initNfc = async () => {
      try {
        await NfcManager.start();

        NfcManager.setEventListener(NfcEvents.DiscoverTag, (tag) => {
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

              router.setParams({ bayId: okunantBayId });
            }
          } catch (err) {
            console.log("NFC Parse Hatası:", err);
          } finally {
            NfcManager.unregisterTagEvent().catch(() => {});
            setTimeout(() => {
              NfcManager.registerTagEvent().catch(() => {});
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
  useEffect(() => {
    const bayBagli = !!seciliBay?.id;
    // Artık 'waiting' durumundayken de zamanlayıcı çalışacak
    const bayMusaitMi =
      (seciliBay?.status === "available" || seciliBay?.status === "waiting") &&
      !seciliBay?.currentSessionId;

    if (!bayBagli || !bayMusaitMi) return;

    const inaktifZamanlayici = setTimeout(async () => {
      Alert.alert(
        "Zaman Aşımı",
        "1 dakika boyunca seçim yapmadığınız için peron bağlantısı kesildi.",
      );

      // ZOMBİ ÖNLEMİ: Kullanıcı atılırken peronu RTDB'de boşa (available) al
      if (seciliBay?.id) {
        try {
          const rtdbBayRef = ref(rtdb, `bays/${seciliBay.id}`);
          await update(rtdbBayRef, {
            status: "available",
            updatedAt: rtdbServerTimestamp(), // veya Date.now() kullanıyorsan ona göre
          });
        } catch (e) {
          console.error("Zaman aşımı reset hatası:", e);
        }
      }

      router.setParams({ bayId: "" });
    }, 60000);

    return () => clearTimeout(inaktifZamanlayici);
  }, [seciliBay?.id, seciliBay?.status, seciliBay?.currentSessionId, router]);
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

  // ========================================================
  // SESSION BİTİRME MANTIĞI HİBRİT OLARAK GÜNCELLENDİ
  // ========================================================
  const sessionBitir = useCallback(
    async (reason = "user_stop") => {
      if (!uid) return router.replace("/login");
      if (!seciliBay?.id || !seciliBay?.currentSessionId) return;
      if (sessionBitiriliyorRef.current) return;

      const sRef = doc(db, "sessions", seciliBay.currentSessionId);
      const rtdbBayRef = ref(rtdb, `bays/${seciliBay.id}`);

      sessionBitiriliyorRef.current = true;
      setSessionBitiriliyor(true);

      try {
        // 1. Önce Firestore'daki session belgesini "ended" yapıyoruz
        await runFirestoreTransaction(db, async (t) => {
          const sSnap = await t.get(sRef);

          if (sSnap.exists()) {
            const s = sSnap.data();
            if (s?.status === "running") {
              t.set(
                sRef,
                {
                  status: "ended",
                  endedAt: firestoreServerTimestamp(),
                  endedReason: reason,
                },
                { merge: true },
              );
            }
          }
        });

        // 2. İşlem bitince hızlıca ESP32'nin görmesi için RTDB'yi güncelliyoruz
        await setRtdb(rtdbBayRef, {
          ...seciliBay,
          status: "available",
          currentSessionId: "",
          updatedAt: rtdbServerTimestamp(),
        });
      } catch (err) {
        console.error("Session kapatma hatası:", err);
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

  // ========================================================
  // SESSION BAŞLATMA MANTIĞI HİBRİT OLARAK GÜNCELLENDİ
  // ========================================================
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

      // RTDB Bay Referansı (Anlık hız için)
      const rtdbBayRef = ref(rtdb, `bays/${seciliBay.id}`);
      // Anlık kontrol yapalım ki birisi saniyeler önce almadıysa emin olalım
      const rtdbSnap = await getRtdb(rtdbBayRef);
      if (rtdbSnap.exists() && rtdbSnap.val().status !== "available") {
        throw new Error("bay_busy");
      }

      const userRef = doc(db, "users", uid);
      const paketRef = doc(db, "packages", packageId);
      const sessionRef = doc(collection(db, "sessions"));
      const txRef = doc(collection(db, "transactions"));

      // 1. Önce Firestore'da para çekme ve loglama işlemlerini yapıyoruz
      await runFirestoreTransaction(db, async (t) => {
        const pSnap = await t.get(paketRef);
        const userSnap = await t.get(userRef);

        if (!pSnap.exists()) throw new Error("package_not_found");

        const p = pSnap.data();
        const pTokens = Number(p?.tokensCost ?? 0);
        const pDuration = Number(p?.durationSec ?? 0);
        const mevcut = userSnap.exists()
          ? Number(userSnap.data()?.walletTokens ?? 0)
          : 0;

        if (mevcut < pTokens) throw new Error("insufficient_tokens");

        t.set(
          userRef,
          {
            walletTokens: mevcut - pTokens,
            updatedAt: firestoreServerTimestamp(),
          },
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
          startedAt: firestoreServerTimestamp(),
          endedAt: null,
          endedReason: null,
          createdAt: firestoreServerTimestamp(),
        });

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
          createdAt: firestoreServerTimestamp(),
        });
      });

      // 2. Veritabanı ve cüzdan işlemleri başarılı olduysa ESP32'yi tetiklemek için RTDB'yi güncelliyoruz
      await setRtdb(rtdbBayRef, {
        ...seciliBay,
        status: "busy",
        currentSessionId: sessionRef.id,
        lastUserId: uid,
        updatedAt: rtdbServerTimestamp(),
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

      await runFirestoreTransaction(db, async (t) => {
        const userSnap = await t.get(userRef);
        const mevcut = userSnap.exists()
          ? Number(userSnap.data()?.walletTokens ?? 0)
          : 0;

        t.set(
          userRef,
          {
            walletTokens: mevcut + tokens,
            updatedAt: firestoreServerTimestamp(),
          },
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
          createdAt: firestoreServerTimestamp(),
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
    qrKameraAc,
    cikisYap,
  };
}
