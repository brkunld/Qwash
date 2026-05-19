import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useFocusEffect } from "expo-router"; // 🔥 useFocusEffect eklendi
import { ref, update , get } from "firebase/database";
import { useCallback, useState } from "react"; // 🔥 useCallback eklendi
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { rtdb } from "../../firebase";

export default function QrKamera() {
  const [permission, requestPermission] = useCameraPermissions();
  const [kilit, setKilit] = useState(false);
  const [yukleniyor, setYukleniyor] = useState(false);

  // 🔥 YENİ EKLENDİ: Kullanıcı bu ekrana her geri döndüğünde kilidi sıfırlar
  useFocusEffect(
    useCallback(() => {
      setKilit(false);
      setYukleniyor(false);
    }, []),
  );

  if (!permission) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color="#111" />
        <Text style={{ marginTop: 10 }}>Başlatılıyor...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={{ flex: 1, padding: 20, justifyContent: "center" }}>
        <Text style={{ fontSize: 18, fontWeight: "700", marginBottom: 10 }}>
          Kamera izni gerekli
        </Text>

        <Pressable
          onPress={requestPermission}
          style={{
            padding: 14,
            borderRadius: 12,
            alignItems: "center",
            backgroundColor: "#111",
          }}
        >
          <Text style={{ color: "white", fontWeight: "600" }}>İzin Ver</Text>
        </Pressable>

        <Pressable
          onPress={() => router.back()}
          style={{ marginTop: 12, alignItems: "center" }}
        >
          <Text style={{ textDecorationLine: "underline" }}>Vazgeç</Text>
        </Pressable>
      </View>
    );
  }

  const okundu = async ({ data }) => {
    if (kilit) return;
    setKilit(true);
    setYukleniyor(true);

    const raw = String(data ?? "").trim();
    let bayId = raw;

    if (raw.startsWith("{")) {
      try {
        const obj = JSON.parse(raw);
        if (obj?.id) bayId = String(obj.id).trim();
      } catch {}
    }

    bayId = bayId.replace(/^\/?bays\//i, "").trim();
    bayId = bayId.replace(/\s+/g, "");

    // YENİ: MAC adresleri 12 haneli harf ve rakamlardan (hexadecimal) oluşur. Örn: bay_246F28ABCDEF
    const re = /^bay_[A-Fa-f0-9]{12}$/i;

    if (!re.test(bayId)) {
      setYukleniyor(false);
      Alert.alert(
        "Geçersiz QR",
        `Okunan: "${raw}"\nLütfen geçerli bir Qwash peron QR kodu okutun.`,
      );
      setTimeout(() => setKilit(false), 2000);
      return;
    }

try {
      const bayRef = ref(rtdb, `bays/${bayId}`);

      // 1. Önce peronun anlık durumunu çekiyoruz (NFC mantığıyla aynı)
      const snapshot = await get(bayRef);
      
      if (!snapshot.exists()) {
        setYukleniyor(false);
        Alert.alert("Hata", "Okutulan peron sistemde bulunamadı.");
        setTimeout(() => setKilit(false), 2500);
        return;
      }

      const currentBayData = snapshot.val();
      
      // 2. Peron "available" (boş) DEĞİLSE işlemi iptal et
      if (currentBayData.status !== "available") {
        setYukleniyor(false);
        Alert.alert(
          "Peron Meşgul",
          "Bu peron şu anda rezerve edilmiş veya kullanımda."
        );
        setTimeout(() => setKilit(false), 2500);
        return;
      }

      // 3. Müsaitse durumu 'waiting' yapıp kullanıcıyı bağla
      await update(bayRef, {
        status: "waiting",
        updatedAt: Date.now(),
      });

      setYukleniyor(false);
      router.navigate({ pathname: "/kullanici", params: { bayId } });

    } catch (error) {
      console.error("RTDB Güncelleme Hatası:", error);
      Alert.alert("Hata", "Peron durumu güncellenemedi.");
      setYukleniyor(false);
      setTimeout(() => setKilit(false), 2000);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: "black" }}>
      {yukleniyor && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="white" />
          <Text style={styles.loadingText}>Peron Rezerve Ediliyor...</Text>
        </View>
      )}

      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={okundu}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.8)",
    zIndex: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "white",
    marginTop: 15,
    fontWeight: "600",
    fontSize: 16,
  },
  bottomContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 14,
    backgroundColor: "rgba(0,0,0,0.55)",
    gap: 10,
    zIndex: 5,
  },
  closeButton: {
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "white",
  },
  closeButtonDisabled: {
    backgroundColor: "#ccc",
  },
});
