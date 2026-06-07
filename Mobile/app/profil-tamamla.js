import { router } from "expo-router";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  Text,
  TextInput,
  View,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  StyleSheet,
} from "react-native";
import { auth, db } from "../firebase";

export default function ProfilTamamla() {
  const [ad, setAd] = useState("");
  const [soyad, setSoyad] = useState("");
  const [telefon, setTelefon] = useState("");
  const [yukleniyor, setYukleniyor] = useState(false);

  const kaydet = async () => {
    const temizAd = ad.trim();
    const temizSoyad = soyad.trim();
    const temizTelefon = telefon.trim();

    if (!temizAd || !temizSoyad || !temizTelefon) {
      Alert.alert("Hata", "Ad, soyad ve telefon zorunlu.");
      return;
    }

    const telefonRegex = /^[1-9][0-9]{9}$/;
    if (!telefonRegex.test(temizTelefon)) {
      Alert.alert(
        "Hata",
        "Telefon numarası 0 ile başlamamalı ve 10 haneli olmalıdır.\nÖrnek: 5XXXXXXXXX",
      );
      return;
    }

    const currentUser = auth.currentUser;
    if (!currentUser) {
      Alert.alert("Hata", "Oturum bulunamadı. Tekrar giriş yap.");
      router.replace("/login");
      return;
    }

    const gercekUid = currentUser.uid;

    setYukleniyor(true);
    try {
      await setDoc(doc(db, "users", gercekUid), {
        ad: temizAd,
        soyad: temizSoyad,
        telefon: temizTelefon,
        email: currentUser.email ?? "",
        walletTokens: 0,
        olusturulmaTarihi: serverTimestamp(),
      });

      router.replace("/(tabs)/kullanici");
    } catch (_) {
      Alert.alert("Hata", "Kaydedilemedi. Tekrar dene.");
    } finally {
      setYukleniyor(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {}
        <View style={styles.topDecor}>
          <View style={styles.decorCircleLarge} />
          <View style={styles.decorCircleSmall} />
        </View>

        {}
        <View style={styles.brandArea}>
          <Text style={styles.brandTitle}>Profili Tamamla</Text>
          <Text style={styles.brandSubtitle}>
            Kullanmaya başlamak için bilgilerinizi girin
          </Text>
        </View>

        {}
        <View style={styles.formCard}>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Ad</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.inputIcon}>👤</Text>
              <TextInput
                value={ad}
                onChangeText={setAd}
                placeholder="Adınız"
                placeholderTextColor="#9ca3af"
                editable={!yukleniyor}
                style={styles.input}
                returnKeyType="next"
              />
            </View>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Soyad</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.inputIcon}>👥</Text>
              <TextInput
                value={soyad}
                onChangeText={setSoyad}
                placeholder="Soyadınız"
                placeholderTextColor="#9ca3af"
                editable={!yukleniyor}
                style={styles.input}
                returnKeyType="next"
              />
            </View>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Telefon</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.inputIcon}>📞</Text>
              <TextInput
                keyboardType="number-pad"
                maxLength={10}
                value={telefon}
                onChangeText={(t) => setTelefon(t.replace(/[^0-9]/g, ""))}
                placeholder="5XXXXXXXXX"
                placeholderTextColor="#9ca3af"
                editable={!yukleniyor}
                style={styles.input}
                returnKeyType="done"
                onSubmitEditing={kaydet}
              />
            </View>
          </View>

          <Pressable
            onPress={kaydet}
            disabled={yukleniyor}
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && { opacity: 0.88 },
              yukleniyor && { opacity: 0.8 },
            ]}
          >
            {yukleniyor ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.actionBtnText}>Kaydet ve Devam Et →</Text>
            )}
          </Pressable>
        </View>

        {}
        <Pressable
          onPress={() => router.replace("/login")}
          disabled={yukleniyor}
          style={({ pressed }) => [
            styles.backBtn,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.backBtnIcon}>←</Text>
          <Text style={styles.backBtnText}>Giriş Ekranına Dön</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: "#f8f9fb",
    paddingHorizontal: 24,
    justifyContent: "center", 
    paddingBottom: 20,
  },
  topDecor: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 200,
    height: 200,
    overflow: "hidden",
  },
  decorCircleLarge: {
    position: "absolute",
    top: -60,
    right: -60,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "#111827",
    opacity: 0.06,
  },
  decorCircleSmall: {
    position: "absolute",
    top: -20,
    right: 20,
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#111827",
    opacity: 0.04,
  },
  brandArea: {
    alignItems: "center",
    marginBottom: 32,
    gap: 8,
  },
  brandTitle: {
    fontSize: 26,
    fontWeight: "900",
    color: "#111827",
    letterSpacing: -0.5,
  },
  brandSubtitle: {
    fontSize: 14,
    color: "#9ca3af",
    fontWeight: "500",
    textAlign: "center",
  },
  formCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
    gap: 16,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  fieldGroup: { gap: 6 },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#374151",
    marginLeft: 2,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 12,
    backgroundColor: "#fafafa",
    paddingHorizontal: 12,
    gap: 8,
  },
  inputIcon: { fontSize: 15 },
  input: {
    flex: 1,
    paddingVertical: 13,
    fontSize: 15,
    color: "#111827",
    fontWeight: "500",
  },
  actionBtn: {
    backgroundColor: "#111827",
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
    minHeight: 52,
    shadowColor: "#111827",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  actionBtnText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 16,
    letterSpacing: 0.2,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginTop: 24,
    paddingVertical: 12,
    paddingHorizontal: 20,
    backgroundColor: "#e5e7eb",
    borderRadius: 100,
    gap: 6,
  },
  backBtnIcon: {
    fontSize: 16,
    color: "#374151",
    fontWeight: "800",
  },
  backBtnText: {
    fontSize: 14,
    color: "#374151",
    fontWeight: "800",
  },
});