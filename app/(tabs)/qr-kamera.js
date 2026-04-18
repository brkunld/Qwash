import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { get, ref, serverTimestamp, update } from "firebase/database";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { rtdb } from "../../firebase"; // Firebase ayarlarınızın olduğu yolu projenize göre kontrol edin

export default function QrKamera() {
  const [permission, requestPermission] = useCameraPermissions();
  const [kilit, setKilit] = useState(false);
  const [yukleniyor, setYukleniyor] = useState(false);

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
    setYukleniyor(true); // Yükleme ekranını başlat

    const raw = String(data ?? "").trim();
    let bayId = raw;

    // JSON formatında gelirse id'yi ayıkla
    if (raw.startsWith("{")) {
      try {
        const obj = JSON.parse(raw);
        if (obj?.id) bayId = String(obj.id).trim();
      } catch {}
    }

    // Gereksiz önekleri ve boşlukları temizle
    bayId = bayId.replace(/^\/?bays\//i, "").trim();
    bayId = bayId.replace(/\s+/g, "");

    // Format kontrolü
    const re = /^bay_\d{5}_\d{2}_\d{2}$/i;
    if (!re.test(bayId)) {
      setYukleniyor(false);
      Alert.alert(
        "Geçersiz QR",
        `Okunan: "${raw}"\nBeklenen örnek: bay_42060_01_01`,
      );
      setKilit(false);
      return;
    }

    try {
      // 1. Veritabanında peron referansını oluştur
      const bayRef = ref(rtdb, `bays/${bayId}`);

      // 2. Peronun mevcut durumunu kontrol et
      const snapshot = await get(bayRef);

      if (snapshot.exists()) {
        const mevcutDurum = snapshot.val().status;

        // Eğer peron "available" (müsait) değilse işlemi durdur
        if (mevcutDurum !== "available") {
          setYukleniyor(false);
          Alert.alert(
            "Peron Meşgul",
            "Bu peron şu anda başka bir işlem için rezerve edilmiş veya kullanımda.",
          );
          setKilit(false);
          return;
        }
      } else {
        // Peron veritabanında hiç yoksa
        setYukleniyor(false);
        Alert.alert("Hata", "Okutulan peron sistemde bulunamadı.");
        setKilit(false);
        return;
      }

      // 3. Modül durumunu "waiting" olarak güncelle
      await update(bayRef, {
        status: "waiting",
        updatedAt: serverTimestamp(),
      });

      // ---------------------------------------------------------
      // BURASI EKLENDİ: Yönlendirmeden önce yükleme ekranını kapat
      // ---------------------------------------------------------
      setYukleniyor(false);
      setKilit(false);

      // 4. Başarılı olursa kullanıcıyı yönlendir
      // (replace yerine navigate kullanıyoruz ve path'i basitleştiriyoruz)
      router.navigate({ pathname: "/kullanici", params: { bayId } });
    } catch (error) {
      console.error("RTDB Güncelleme Hatası:", error);
      Alert.alert(
        "Hata",
        "Peron durumu güncellenemedi. Lütfen tekrar deneyin.",
      );
      setYukleniyor(false);
      setKilit(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: "black" }}>
      {/* Yükleme Ekranı Katmanı */}
      {yukleniyor && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="white" />
          <Text style={styles.loadingText}>Peron Rezerve Ediliyor...</Text>
        </View>
      )}

      {/* Kamera Görünümü */}
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
