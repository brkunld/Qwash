import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
  StyleSheet,
  StatusBar,
} from "react-native";
import { BleManager } from "react-native-ble-plx";
import base64 from "react-native-base64";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { router } from "expo-router";

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

const bleManager = new BleManager();

export default function AdminPanel() {
  const [sifre, setSifre] = useState("1453");
  const [taranıyor, setTaraniyor] = useState(false);
  const [cihazlar, setCihazlar] = useState([]);
  const [baglanilanCihaz, setBaglanilanCihaz] = useState(null);
  const [islemDurumu, setIslemDurumu] = useState("Sistem kuruluma hazır.");

  useEffect(() => {
    return () => {
      bleManager.stopDeviceScan();
    };
  }, []);

  const cihazlariTara = () => {
    setIslemDurumu("Yakındaki peronlar aranıyor...");
    setTaraniyor(true);
    setCihazlar([]);

    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.log("BLE Tarama Hatası:", error);
        setTaraniyor(false);
        setIslemDurumu("Bluetooth taraması başlatılamadı.");
        Alert.alert(
          "Bağlantı Hatası",
          "Lütfen konum ve Bluetooth izinlerinin açık olduğunu kontrol edin.",
        );
        return;
      }

      if (device.name && device.name.startsWith("Qwash_BLE")) {
        setCihazlar((prev) => {
          if (!prev.find((d) => d.id === device.id)) {
            return [...prev, device];
          }
          return prev;
        });
      }
    });

    setTimeout(() => {
      bleManager.stopDeviceScan();
      setTaraniyor(false);
      setIslemDurumu("Tarama tamamlandı.");
    }, 6000);
  };

  const cihazaBaglanVeSifirla = async (device) => {
    if (!sifre || sifre.length < 4) {
      Alert.alert("Hata", "Lütfen geçerli bir kurulum şifresi girin.");
      return;
    }

    try {
      bleManager.stopDeviceScan();
      setIslemDurumu(`${device.name} peronuna bağlanılıyor...`);
      setBaglanilanCihaz(device.id);

      const connectedDevice = await device.connect();
      setIslemDurumu("Donanım servisleri okunuyor...");
      await connectedDevice.discoverAllServicesAndCharacteristics();

      const komut = `RESET_${sifre}`;
      const base64Komut = base64.encode(komut);

      setIslemDurumu("Sıfırlama komutu gönderiliyor...");
      await connectedDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        base64Komut,
      );

      setIslemDurumu("Komut başarıyla iletildi!");
      Alert.alert(
        "Başarılı",
        `${device.name} sıfırlandı ve kurulum moduna geçirildi.`,
      );
    } catch (error) {
      console.log("BLE İletişim Hatası:", error);
      setIslemDurumu("Bağlantı başarısız oldu.");
      Alert.alert(
        "Hata",
        "Cihaza bağlanırken bir sorun oluştu. Lütfen perona yakınlaşın.",
      );
    } finally {
      setBaglanilanCihaz(null);
    }
  };

  const handleCikis = () => {
    Alert.alert(
      "Çıkış Yap",
      "Admin oturumunu kapatmak istediğinize emin misiniz?",
      [
        { text: "Vazgeç", style: "cancel" },
        {
          text: "Çıkış Yap",
          style: "destructive",
          onPress: async () => {
            try {
              await signOut(auth);
              router.replace("/login");
            } catch (e) {
              Alert.alert("Hata", "Oturum kapatılamadı.", e);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Üst Bar Tasarımı */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerSubtitle}>Qwash Yönetim</Text>
          <Text style={styles.headerTitle}>Admin Paneli</Text>
        </View>
        <TouchableOpacity style={styles.logoutButton} onPress={handleCikis}>
          <Text style={styles.logoutButtonText}>Çıkış</Text>
        </TouchableOpacity>
      </View>

      {/* Şifre Girdi Kartı */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Fabrika Sıfırlama Şifresi</Text>
        <TextInput
          style={styles.input}
          value={sifre}
          onChangeText={setSifre}
          keyboardType="numeric"
          placeholder="Şifre"
          placeholderTextColor="#666"
        />
        <Text style={styles.cardHint}>
          * Gönderilecek komut otomatik olarak &apos;RESET_{sifre}&apos; halini alacaktır.
        </Text>
      </View>

      {/* Tarama Tetikleyici */}
      <TouchableOpacity
        style={[styles.primaryButton, taranıyor && styles.buttonDisabled]}
        onPress={cihazlariTara}
        disabled={taranıyor}
      >
        {taranıyor ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Yakındaki Peronları Ara</Text>
        )}
      </TouchableOpacity>

      <Text style={styles.statusText}>{islemDurumu}</Text>

      {/* Bulunan Donanımların Listesi */}
      <FlatList
        data={cihazlar}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.deviceCard}>
            <View style={styles.deviceInfo}>
              <Text style={styles.deviceName}>{item.name}</Text>
              <Text style={styles.deviceId}>MAC: {item.id}</Text>
            </View>
            <TouchableOpacity
              style={styles.deviceActionButton}
              onPress={() => cihazaBaglanVeSifirla(item)}
              disabled={baglanilanCihaz !== null}
            >
              {baglanilanCihaz === item.id ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.deviceActionButtonText}>Sıfırla</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={() =>
          !taranıyor && (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>
                Çevrede taranmış Qwash donanımı bulunamadı.
              </Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b0b0c",
    paddingHorizontal: 20,
    paddingTop: 60,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 25,
  },
  headerSubtitle: {
    color: "#8e8e93",
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  headerTitle: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "700",
    marginTop: 2,
  },
  logoutButton: {
    backgroundColor: "#222224",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  logoutButtonText: { color: "#ff453a", fontSize: 14, fontWeight: "600" },
  card: {
    backgroundColor: "#1c1c1e",
    padding: 18,
    borderRadius: 16,
    marginBottom: 20,
  },
  cardLabel: {
    color: "#aeaeaf",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 8,
  },
  input: {
    backgroundColor: "#2c2c2e",
    color: "#ffffff",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 1.5,
  },
  cardHint: {
    color: "#636366",
    fontSize: 12,
    marginTop: 10,
    fontStyle: "italic",
  },
  primaryButton: {
    backgroundColor: "#ffffff",
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  buttonDisabled: { backgroundColor: "#3a3a3c" },
  buttonText: { color: "#000000", fontSize: 16, fontWeight: "700" },
  statusText: {
    color: "#8e8e93",
    textAlign: "center",
    fontStyle: "italic",
    fontSize: 13,
    marginBottom: 20,
  },
  deviceCard: {
    backgroundColor: "#1c1c1e",
    padding: 16,
    borderRadius: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  deviceInfo: { flex: 1 },
  deviceName: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
  deviceId: { color: "#8e8e93", fontSize: 12, marginTop: 4 },
  deviceActionButton: {
    backgroundColor: "#ff453a",
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  deviceActionButtonText: { color: "#ffffff", fontWeight: "700", fontSize: 14 },
  emptyContainer: { paddingVertical: 40, alignItems: "center" },
  emptyText: { color: "#48484a", fontSize: 14, textAlign: "center" },
});
