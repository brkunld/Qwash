import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";

export default function QrKamera() {
  const [permission, requestPermission] = useCameraPermissions();
  const [kilit, setKilit] = useState(false);

  if (!permission) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>Yükleniyor...</Text>
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

  const okundu = ({ data }) => {
    if (kilit) return;
    setKilit(true);

    const raw = String(data ?? "").trim();

    // JSON veya "bays/..." gibi gelirse ayıkla
    let bayId = raw;

    // JSON: {"id":"bay_42060_01_01"}
    if (raw.startsWith("{")) {
      try {
        const obj = JSON.parse(raw);
        if (obj?.id) bayId = String(obj.id).trim();
      } catch {}
    }

    // "bays/bay_42060_01_01" gelirse:
    bayId = bayId.replace(/^\/?bays\//i, "").trim();

    // tüm boşlukları temizle
    bayId = bayId.replace(/\s+/g, "");

    // ✅ yeni format kontrolü: bay_42060_01_01
    // postaKodu: 5 hane, istasyonNo: 2 hane, bayNo: 2 hane
    const re = /^bay_\d{5}_\d{2}_\d{2}$/i;

    if (!re.test(bayId)) {
      Alert.alert(
        "Geçersiz QR",
        `Okunan: "${raw}"\nBeklenen örnek: bay_42060_01_01`,
      );
      setKilit(false);
      return;
    }

    // ✅ Kullanıcı ekranına dön (senin kullanıcı ekranın tabs/index ise bu daha garanti)
    router.replace({ pathname: "/(tabs)/kullanici", params: { bayId } });
  };

  return (
    <View style={{ flex: 1, backgroundColor: "black" }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={okundu}
      />

      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: 14,
          backgroundColor: "rgba(0,0,0,0.55)",
          gap: 10,
        }}
      >
        <Text style={{ color: "white", textAlign: "center" }}>
          QR kodu kameraya göster
        </Text>

        <Pressable
          onPress={() => router.back()}
          style={{
            padding: 14,
            borderRadius: 12,
            alignItems: "center",
            backgroundColor: "white",
          }}
        >
          <Text style={{ fontWeight: "700" }}>Kapat</Text>
        </Pressable>
      </View>
    </View>
  );
}
