/* eslint-disable react-hooks/exhaustive-deps */
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import * as WebBrowser from "expo-web-browser"; // <-- EN ÜSTE İMPORT EDİN

import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  doc,
  serverTimestamp as firestoreServerTimestamp,
  onSnapshot,
  setDoc,
} from "firebase/firestore";

import { onValue, ref, update } from "firebase/database";

import { auth, db, rtdb } from "../firebase";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

const getApiUrl = (path) => {
  if (!API_BASE_URL) {
    throw new Error("API_BASE_URL_MISSING");
  }

  return `${API_BASE_URL.replace(/\/$/, "")}${path}`;
};

export function useKullaniciIslemleri() {
  const params = useLocalSearchParams();
  const router = useRouter();

  const [currentUser, setCurrentUser] = useState(null);
  const [authYukleniyor, setAuthYukleniyor] = useState(true);
  const uid = currentUser?.uid ?? null;

  // --- ÇOKLU PERON DESTEĞİ İÇİN STATELER ---
  const [aktifBayIdListesi, setAktifBayIdListesi] = useState([]);
  const [baylarData, setBaylarData] = useState({});
  const [sessionsData, setSessionsData] = useState({});
  const [islemdekiBaylar, setIslemdekiBaylar] = useState({});

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

  const kasitliCikisRef = useRef({}); // Kullanıcı kendi çıkarsa uyarı vermemek için

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

  useEffect(() => {
    const pBayId = params?.bayId;
    if (pBayId && !aktifBayIdListesi.includes(pBayId)) {
      setAktifBayIdListesi((prev) => [...prev, pBayId]);
    }
  }, [params?.bayId]);

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
          if (data?.isBlocked === true) {
            Alert.alert(
              "Erişim Engellendi",
              "Hesabınız sistem yöneticisi tarafından askıya alınmıştır.",
            );
            cikisYap();
            return;
          }
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

  // BAY (PERON) DİNLEME VE OTOMATİK KOPARMA MANTIĞI
  // BAY (PERON) DİNLEME VE OTOMATİK KOPARMA MANTIĞI
  // ========================================================
  useEffect(() => {
    const unsubs = aktifBayIdListesi.map((bayId) => {
      const bayRef = ref(rtdb, `bays/${bayId}`);

      return onValue(bayRef, (snapshot) => {
        if (snapshot.exists()) {
          const bayData = snapshot.val();
          setBaylarData((prev) => ({ ...prev, [bayId]: bayData }));

          // Peronun kopmasını gerektiren durumları kontrol ediyoruz
          const kopmaGerekliMi =
            bayData.status === "available" ||
            bayData.status === "maintenance" ||
            bayData.status === "offline" ||
            bayData.isActive === false;

          // Otomatik Bağlantı Kesme Uyarısı
          if (kopmaGerekliMi) {
            // 1. Önce sadece kendi listemizden (State) peronu siliyoruz
            setAktifBayIdListesi((prev) => {
              if (prev.includes(bayId)) {
                return prev.filter((id) => id !== bayId);
              }
              return prev;
            });

            // 2. Uyarıyı state updater'ın DIŞINDA veriyoruz
            if (!kasitliCikisRef.current[bayId]) {
              let mesaj = `${bayId} peronunda süreniz doldu veya işlem yapmadığınız için bağlantınız kesildi.`;

              if (bayData.status === "maintenance") {
                mesaj = `${bayId} peronu bakıma alındığı için bağlantınız kesildi.`;
              } else if (
                bayData.status === "offline" ||
                bayData.isActive === false
              ) {
                mesaj = `${bayId} peronu sistem tarafından kapatıldığı için bağlantınız kesildi.`;
              }

              Alert.alert("Bağlantı Kesildi", mesaj);
            }
            delete kasitliCikisRef.current[bayId];

            // 3. React render çakışmasını engellemek için Router işlemini 10ms erteliyoruz
            setTimeout(() => {
              router.setParams({ bayId: "" });
            }, 10);
          }
        } else {
          setBaylarData((prev) => {
            const n = { ...prev };
            delete n[bayId];
            return n;
          });
        }
      });
    });

    return () => unsubs.forEach((u) => u());
  }, [aktifBayIdListesi]);

  // ÇOKLU SESSION DİNLEME VE ZOMBİ TEMİZLİĞİ MANTIĞI
  useEffect(() => {
    const unsubs = [];
    Object.entries(baylarData).forEach(([bayId, data]) => {
      const sId = data?.currentSessionId;
      const lokalSession = sessionsData[bayId];

      // ZOMBİ SESSION TEMİZLİĞİ
      if (!sId && lokalSession?.status === "running") {
        const sRef = doc(db, "sessions", lokalSession.id);
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

      if (sId) {
        const sRef = doc(db, "sessions", sId);
        const u = onSnapshot(sRef, (snap) => {
          if (snap.exists()) {
            setSessionsData((prev) => ({
              ...prev,
              [bayId]: { id: snap.id, ...snap.data() },
            }));
          } else {
            setSessionsData((prev) => {
              const n = { ...prev };
              delete n[bayId];
              return n;
            });
          }
        });
        unsubs.push(u);
      } else {
        setSessionsData((prev) => {
          if (prev[bayId]) {
            const n = { ...prev };
            delete n[bayId];
            return n;
          }
          return prev;
        });
      }
    });

    return () => unsubs.forEach((u) => u());
  }, [baylarData]);

  // ESP32 FİZİKSEL DOKUNMATİK EKRAN SİNYALİ DİNLEME
  useEffect(() => {
    Object.entries(baylarData).forEach(([id, data]) => {
      if (data?.hardwareSelection) {
        const secilenPaket = data.hardwareSelection;
        const rtdbBayRef = ref(rtdb, `bays/${id}`);
        update(rtdbBayRef, { hardwareSelection: null })
          .then(() => {
            sessionBaslat(id, secilenPaket);
          })
          .catch((err) =>
            console.error("Donanım seçimini temizleme hatası:", err),
          );
      }
    });
  }, [baylarData]);

  const sessionBaslat = async (islemBayId, packageId) => {
  if (!uid) return router.replace("/login");

  const bay = baylarData[islemBayId];

  if (
    (bay?.status !== "available" && bay?.status !== "waiting") ||
    bay?.currentSessionId
  ) {
    return Alert.alert("Peron Dolu", "Bu peron şu anda kullanımda.");
  }

  setIslemdekiBaylar((prev) => ({ ...prev, [islemBayId]: true }));

  try {
    const token = await auth.currentUser?.getIdToken();

    if (!token) {
      Alert.alert("Oturum Hatası", "Lütfen tekrar giriş yapın.");
      router.replace("/login");
      return;
    }

    const API_URL = getApiUrl("/api/start-session");

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        uid,
        bayId: islemBayId,
        packageId,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      Alert.alert("Hata", data.error || "İşlem yapılamadı.");
    }
  } catch (error) {
    if (error.message === "API_BASE_URL_MISSING") {
      Alert.alert("Yapılandırma Hatası", "API adresi tanımlı değil.");
      return;
    }

    Alert.alert("Sunucu Hatası", "Sunucuya ulaşılamadı.");
  } finally {
    setIslemdekiBaylar((prev) => ({ ...prev, [islemBayId]: false }));
  }
};

  const sessionBitir = useCallback(
  async (islemBayId, currentSessionId, reason = "user_stop") => {
    if (!uid) return router.replace("/login");
    if (!currentSessionId) return;

    setIslemdekiBaylar((prev) => ({ ...prev, [islemBayId]: true }));

    try {
      const token = await auth.currentUser?.getIdToken();

      if (!token) {
        Alert.alert("Oturum Hatası", "Lütfen tekrar giriş yapın.");
        router.replace("/login");
        return;
      }

      const API_URL = getApiUrl("/api/stop-session");

      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          bayId: islemBayId,
          sessionId: currentSessionId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        Alert.alert("Hata", data.error || "Oturum durdurulamadı.");
      }
    } catch (error) {
      if (error.message === "API_BASE_URL_MISSING") {
        Alert.alert("Yapılandırma Hatası", "API adresi tanımlı değil.");
        return;
      }

      Alert.alert("Sunucu Hatası", "Sunucuya ulaşılamadı.");
    } finally {
      setIslemdekiBaylar((prev) => ({ ...prev, [islemBayId]: false }));
    }
  },
  [uid, router],
);

  const perondanCik = async (islemBayId) => {
  const bay = baylarData[islemBayId];
  const session = sessionsData[islemBayId];

  if (bay?.currentSessionId || session?.status === "running") {
    Alert.alert(
      "Hata",
      "Aktif oturum varken peronu terkedemezsiniz. Önce durdurunuz.",
    );
    return;
  }

  try {
    const token = await auth.currentUser?.getIdToken();

    if (!token) {
      Alert.alert("Oturum Hatası", "Lütfen tekrar giriş yapın.");
      router.replace("/login");
      return;
    }

    kasitliCikisRef.current[islemBayId] = true;

    const API_URL = getApiUrl("/api/cancel-waiting");

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        bayId: islemBayId,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      kasitliCikisRef.current[islemBayId] = false;
      Alert.alert("Hata", data.error || "Çıkış yapılamadı.");
      return;
    }

    Alert.alert("Başarılı", data.message || "Peron serbest bırakıldı.");
  } catch (error) {
    kasitliCikisRef.current[islemBayId] = false;

    if (error.message === "API_BASE_URL_MISSING") {
      Alert.alert("Yapılandırma Hatası", "API adresi tanımlı değil.");
      return;
    }

    console.error("Çıkış hatası:", error);
    Alert.alert("Bağlantı Hatası", "Sunucuya ulaşılamadı.");
  }
};

  const bakiyeYukle = async (tokens, amountTRYParam) => {
  if (!uid) return router.replace("/login");

  if (!jetonFiyat || fiyatYukleniyor) {
    return Alert.alert("Fiyat Alınamadı", "Fiyat bilgisi alınamadı.");
  }

  setYuklemeIslemde(true);

  const amountTRY =
    typeof amountTRYParam === "number" ? amountTRYParam : tokens * jetonFiyat;

  try {
    const token = await auth.currentUser?.getIdToken();

    if (!token) {
      Alert.alert("Oturum Hatası", "Lütfen tekrar giriş yapın.");
      router.replace("/login");
      return;
    }

    const API_URL = getApiUrl("/api/topup");

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        tokens,
        amountTRY,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      return Alert.alert("Hata", data.error || "Ödeme oturumu açılamadı.");
    }

    setYuklemeAcik(false);

    await WebBrowser.openBrowserAsync(data.paymentUrl, {
      dismissButtonStyle: "close",
      readerMode: false,
      enableBarCollapsing: true,
    });

    Alert.alert(
      "Bilgi",
      "Ödeme işleminiz tamamlandıysa bakiyeniz birkaç saniye içinde güncellenecektir.",
    );
  } catch (error) {
    if (error.message === "API_BASE_URL_MISSING") {
      Alert.alert("Yapılandırma Hatası", "API adresi tanımlı değil.");
      return;
    }

    console.error(error);
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

    if (!adTemiz || !soyadTemiz)
      return Alert.alert("Hata", "Ad veya soyad boş olamaz.");
    if (!/^[1-9][0-9]{9}$/.test(telTemiz))
      return Alert.alert(
        "Hata",
        "Telefon 10 haneli olmalı ve 0 ile başlamamalı.",
      );

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

  return {
    authYukleniyor,
    uid,

    aktifBayIdListesi,
    baylarData,
    sessionsData,
    islemdekiBaylar,

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

    sessionBaslat,
    sessionBitir,
    perondanCik,
    bakiyeYukle,
    profilKaydet,
    cikisYap,
  };
}
