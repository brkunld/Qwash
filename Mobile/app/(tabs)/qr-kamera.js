import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { getApiUrl } from "../../src/config/api";
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

const API_TIMEOUT_MS = 10000;

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

    const idToken = await currentUser.getIdToken();
    const url = getApiUrl("/api/prepare-bay");

    console.log("Prepare Bay URL:", url);
    console.log("Prepare Bay bayId:", bayId);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, API_TIMEOUT_MS);

    let response;
    let text = "";

    try {
      response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          bayId,
        }),
      });

      text = await response.text();
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(
          "Sunucuya ulaşılamadı. Lütfen internet bağlantınızı kontrol edip tekrar deneyin.",
        );
      }

      throw new Error(
        "Sunucuya ulaşılamadı. Lütfen internet bağlantınızı kontrol edip tekrar deneyin.",
      );
    } finally {
      clearTimeout(timeoutId);
    }

    console.log("Prepare Bay Status:", response.status);
    console.log("Prepare Bay Raw Response:", text);

    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Sunucudan JSON olmayan cevap geldi: ${text}`);
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

    if (!bayId || !bayId.toLowerCase().startsWith("bay_")) {
      setYukleniyor(false);

      Alert.alert(
        "Geçersiz QR",
        `Okunan: "${raw}"\nLütfen geçerli bir Qwash peron QR kodu okutun.`,
      );

      setTimeout(() => setKilit(false), 1200);
      return;
    }

    try {
      const result = await prepareBay(bayId);

      setYukleniyor(false);

      if (!result?.success) {
        Alert.alert("Hata", "Peron seçim ekranına alınamadı.");
        setTimeout(() => setKilit(false), 1200);
        return;
      }

      setKilit(false);

      router.navigate({
        pathname: "/kullanici",
        params: { bayId },
      });
    } catch (error) {
      console.error("Prepare Bay Hatası:", error);

      setYukleniyor(false);

      const mesaj =
        error.message === "API_BASE_URL_MISSING"
          ? "API adresi tanımlı değil. Lütfen uygulama yapılandırmasını kontrol edin."
          : error.message || "Peron hazırlanırken bir hata oluştu.";

      Alert.alert("Hata", mesaj);

      setTimeout(() => setKilit(false), 1500);
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
