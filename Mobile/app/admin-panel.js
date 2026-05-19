import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
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
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

// Kullanıcı ekranındaki (kullanici.js) renk ve tema sabitleri
const DARK = "#1a1a2e";
const YELLOW = "#f5a623";
const WHITE = "#ffffff";
const GRAY_BG = "#f2f4f7";
const GRAY_BORDER = "#e2e6ea";
const GRAY_TEXT = "#6b7280";
const DARK_TEXT = "#111827";

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

const bleManager = new BleManager();

export default function AdminPanel() {
  const router = useRouter();
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
      <StatusBar barStyle="light-content" backgroundColor={DARK} />

      {/* Header Tasarımı (kullanici.js ile birebir aynı) */}
      <View style={styles.header}>
        <View style={styles.headerBadge}>
          <Text style={styles.headerBadgeText}> Admin Paneli </Text>
        </View>

        <View style={styles.headerRight}>
          <Pressable onPress={handleCikis} style={styles.headerBtn}>
            <Ionicons name="log-out-outline" size={18} color={WHITE} />
          </Pressable>
        </View>
      </View>

      <FlatList
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 24 }}
        data={cihazlar}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <>
            {/* Şifre Kartı */}
            <View style={styles.card}>
              <Text style={styles.cardLabel}>⚙️ Fabrika Sıfırlama Şifresi</Text>
              <TextInput
                style={styles.input}
                value={sifre}
                onChangeText={setSifre}
                keyboardType="numeric"
                placeholder="Şifre"
                placeholderTextColor={GRAY_TEXT}
              />
              <Text style={styles.cardHint}>
                * Gönderilecek komut otomatik olarak &apos;RESET_{sifre}&apos; halini
                alacaktır.
              </Text>
            </View>

            {/* Tarama Butonu */}
            <Pressable
              style={[styles.yellowBtn, taranıyor && styles.btnDisabled]}
              onPress={cihazlariTara}
              disabled={taranıyor}
            >
              {taranıyor ? (
                <ActivityIndicator color={DARK} />
              ) : (
                <Text style={styles.yellowBtnText}>
                  Yakındaki Peronları Ara
                </Text>
              )}
            </Pressable>

            <Text style={styles.statusText}>{islemDurumu}</Text>
          </>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={styles.bayBadge}>
                  <Ionicons
                    name="bluetooth"
                    size={14}
                    color={DARK}
                    style={{ marginRight: 4 }}
                  />
                  <Text style={styles.bayIdText}>{item.name}</Text>
                </View>
              </View>
            </View>

            <View style={styles.sessionBox}>
              <Text style={styles.macAddressText}>MAC: {item.id}</Text>

              <Pressable
                style={[
                  styles.redBtn,
                  baglanilanCihaz !== null &&
                    baglanilanCihaz !== item.id &&
                    styles.btnDisabled,
                ]}
                onPress={() => cihazaBaglanVeSifirla(item)}
                disabled={baglanilanCihaz !== null}
              >
                {baglanilanCihaz === item.id ? (
                  <ActivityIndicator color={WHITE} size="small" />
                ) : (
                  <Text style={styles.redBtnText}>
                    Sıfırla ve Kuruluma Geçir
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        )}
        ListEmptyComponent={() =>
          !taranıyor && (
            <Text style={styles.emptyText}>
              Çevrede taranmış Qwash donanımı bulunamadı.
            </Text>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: GRAY_BG,
  },
  scroll: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  header: {
    backgroundColor: DARK,
    paddingTop: 48,
    paddingBottom: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerBadge: {
    backgroundColor: YELLOW,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  headerBadgeText: {
    fontSize: 15,
    fontWeight: "900",
    color: DARK_TEXT,
    letterSpacing: 0.5,
  },
  headerRight: {
    flexDirection: "row",
    gap: 6,
  },
  headerBtn: {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  card: {
    backgroundColor: WHITE,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
    overflow: "hidden",
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  cardLabel: {
    fontSize: 12,
    color: GRAY_TEXT,
    fontWeight: "600",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    borderWidth: 1.5,
    borderColor: GRAY_BORDER,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    color: DARK_TEXT,
    backgroundColor: GRAY_BG,
  },
  cardHint: {
    color: GRAY_TEXT,
    fontSize: 12,
    marginTop: 8,
    fontStyle: "italic",
  },
  yellowBtn: {
    marginTop: 6,
    backgroundColor: YELLOW,
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginBottom: 14,
  },
  yellowBtnText: {
    color: DARK,
    fontWeight: "800",
    fontSize: 15,
  },
  btnDisabled: {
    backgroundColor: "#c4c4c4",
  },
  statusText: {
    color: GRAY_TEXT,
    textAlign: "center",
    fontStyle: "italic",
    fontSize: 13,
    marginBottom: 20,
  },
  bayBadge: {
    backgroundColor: YELLOW,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    flexDirection: "row",
    alignItems: "center",
  },
  bayIdText: {
    fontSize: 15,
    fontWeight: "900",
    color: "#000",
  },
  sessionBox: {
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: GRAY_BORDER,
    paddingTop: 10,
  },
  macAddressText: {
    color: GRAY_TEXT,
    fontSize: 12,
    marginBottom: 10,
    fontWeight: "500",
  },
  redBtn: {
    backgroundColor: "#FF3B30",
    padding: 13,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  redBtnText: {
    color: WHITE,
    fontWeight: "700",
    fontSize: 14,
  },
  emptyText: {
    textAlign: "center",
    color: GRAY_TEXT,
    marginTop: 20,
    fontSize: 14,
  },
});
