import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

// Firebase auth export adın farklıysa burayı kendi firebase dosyana göre değiştir.
// Örn: firebase.js içinde export const auth = getAuth(app); olmalı.
import { auth } from "../../firebase";

// Render backend URL'in.
// Daha temiz yöntem: .env içine EXPO_PUBLIC_API_BASE_URL koymak.
// Örnek: EXPO_PUBLIC_API_BASE_URL=https://qwash-backend.onrender.com
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL || "https://SENIN_RENDER_URL.onrender.com";

export default function QrKamera() {
  const [permission, requestPermission] = useCameraPermissions();
  const [kilit, setKilit] = useState(false);
  const [yukleniyor, setYukleniyor] = useState(false);

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

  const bayIdTemizle = (data) => {
    const raw = String(data ?? "").trim();
    let bayId = raw;

    if (raw.startsWith("{")) {
      try {
        const obj = JSON.parse(raw);
        if (obj?.id) bayId = String(obj.id).trim();
        if (obj?.bayId) bayId = String(obj.bayId).trim();
      } catch {
        // JSON değilse raw değer kullanılmaya devam eder.
      }
    }

    bayId = bayId.replace(/^\/?bays\//i, "").trim();
    bayId = bayId.replace(/\s+/g, "");

    return { raw, bayId };
  };

  const prepareBay = async (bayId) => {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error("Oturum bulunamadı. Lütfen tekrar giriş yapın.");
  }

  const idToken = await currentUser.getIdToken(true);

  const url = `${API_BASE_URL}/api/prepare-bay`;

  console.log("Prepare Bay URL:", url);
  console.log("Prepare Bay bayId:", bayId);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      bayId,
    }),
  });

  const text = await response.text();

  console.log("Prepare Bay Status:", response.status);
  console.log("Prepare Bay Raw Response:", text);

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Sunucudan JSON olmayan cevap geldi: ${text}`, error);
  }

  if (!response.ok) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  }

  return data;
};

  const okundu = async ({ data }) => {
    if (kilit) return;

    setKilit(true);
    setYukleniyor(true);

    const { raw, bayId } = bayIdTemizle(data);

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
      const result = await prepareBay(bayId);

      setYukleniyor(false);

      if (!result?.success) {
        Alert.alert("Hata", "Peron seçim ekranına alınamadı.");
        setTimeout(() => setKilit(false), 2000);
        return;
      }

      router.navigate({
        pathname: "/kullanici",
        params: { bayId },
      });
    } catch (error) {
      console.error("Prepare Bay Hatası:", error);

      setYukleniyor(false);

      Alert.alert(
        "Hata",
        error.message || "Peron hazırlanırken bir hata oluştu.",
      );

      setTimeout(() => setKilit(false), 2500);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: "black" }}>
      {yukleniyor && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="white" />
          <Text style={styles.loadingText}>Peron Hazırlanıyor...</Text>
        </View>
      )}

      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={okundu}
      />

      <View style={styles.bottomContainer}>
        <Pressable
          onPress={() => router.back()}
          disabled={yukleniyor}
          style={[
            styles.closeButton,
            yukleniyor && styles.closeButtonDisabled,
          ]}
        >
          <Text style={{ fontWeight: "700" }}>Kapat</Text>
        </Pressable>
      </View>
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