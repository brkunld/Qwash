import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Alert,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  StyleSheet,
  Image,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
} from "firebase/auth";
import { auth } from "../firebase";

export default function Register() {
  const [email, setEmail] = useState("");
  const [sifre, setSifre] = useState("");
  const [sifre2, setSifre2] = useState("");
  const [yukleniyor, setYukleniyor] = useState(false);
  
  // Şifre göster/gizle state'leri
  const [sifreGoster, setSifreGoster] = useState(false);
  const [sifre2Goster, setSifre2Goster] = useState(false);

  const hataMesaji = (code) => {
    switch (code) {
      case "auth/invalid-email":
        return "Geçersiz email adresi.";
      case "auth/email-already-in-use":
        return "Bu email zaten kayıtlı.";
      case "auth/weak-password":
        return "Şifre en az 6 karakter olmalı.";
      case "auth/network-request-failed":
        return "İnternet bağlantısı yok.";
      default:
        return "Kayıt başarısız. Tekrar dene.";
    }
  };

  const kayitOl = async () => {
    const e = email.trim();

    if (!e || !sifre || !sifre2) {
      Alert.alert("Hata", "Tüm alanlar zorunlu.");
      return;
    }

    if (sifre !== sifre2) {
      Alert.alert("Hata", "Şifreler eşleşmiyor.");
      return;
    }

    try {
      setYukleniyor(true);

      const userCred = await createUserWithEmailAndPassword(auth, e, sifre);

      // Doğrulama maili gönder
      await sendEmailVerification(userCred.user);

      Alert.alert(
        "Başarılı",
        "Kayıt tamamlandı.\nLütfen email adresini doğrula.",
        [
          {
            text: "Tamam",
            onPress: () => router.replace("/login"),
          },
        ]
      );
    } catch (err) {
      Alert.alert("Hata", hataMesaji(err?.code));
    } finally {
      setYukleniyor(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        {/* Tepe Dekorasyonu */}
        <View style={styles.topDecor}>
          <View style={styles.decorCircleLarge} />
          <View style={styles.decorCircleSmall} />
        </View>

        {/* Logo ve Başlık Alanı */}
        <View style={styles.brandArea}>
          <View style={styles.logoBox}>
            <Image
              source={require("../assets/images/buyuklogo.png")}
              style={styles.logoImage}
              resizeMode="contain"
            />
          </View>
          <Text style={styles.brandTitle}>Kayıt Ol</Text>
          <Text style={styles.brandSubtitle}>Yeni bir hesap oluşturun</Text>
        </View>

        {/* Kayıt Formu Kartı */}
        <View style={styles.formCard}>
          
          {/* E-posta Alanı */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>E-posta</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.inputIcon}>✉️</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="ornek@mail.com"
                placeholderTextColor="#9ca3af"
                autoCapitalize="none"
                keyboardType="email-address"
                editable={!yukleniyor}
                style={styles.input}
                returnKeyType="next"
              />
            </View>
          </View>

          {/* Şifre Alanı */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Şifre</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.inputIcon}>🔒</Text>
              <TextInput
                value={sifre}
                onChangeText={setSifre}
                placeholder="En az 6 karakter"
                placeholderTextColor="#9ca3af"
                secureTextEntry={!sifreGoster}
                editable={!yukleniyor}
                style={[styles.input, { flex: 1 }]}
                returnKeyType="next"
              />
              <Pressable
                onPress={() => setSifreGoster((p) => !p)}
                style={styles.eyeBtn}
              >
                <Text style={styles.eyeIcon}>{sifreGoster ? "🙈" : "👁️"}</Text>
              </Pressable>
            </View>
          </View>

          {/* Şifre Tekrar Alanı */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Şifre Tekrar</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.inputIcon}>🔒</Text>
              <TextInput
                value={sifre2}
                onChangeText={setSifre2}
                placeholder="Şifrenizi tekrar girin"
                placeholderTextColor="#9ca3af"
                secureTextEntry={!sifre2Goster}
                editable={!yukleniyor}
                style={[styles.input, { flex: 1 }]}
                returnKeyType="done"
                onSubmitEditing={kayitOl}
              />
              <Pressable
                onPress={() => setSifre2Goster((p) => !p)}
                style={styles.eyeBtn}
              >
                <Text style={styles.eyeIcon}>{sifre2Goster ? "🙈" : "👁️"}</Text>
              </Pressable>
            </View>
          </View>

          {/* Kayıt Ol Butonu */}
          <Pressable
            onPress={kayitOl}
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
              <Text style={styles.actionBtnText}>Kayıt Ol</Text>
            )}
          </Pressable>
        </View>

        {/* Alt Yönlendirme Alanı */}
        <View style={styles.bottomRow}>
          <Text style={styles.bottomHint}>Zaten hesabın var mı?</Text>
          <Pressable
            onPress={() => router.replace("/login")}
            disabled={yukleniyor}
          >
            <Text style={styles.bottomLink}>Giriş Yap</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: "#f8f9fb",
    paddingHorizontal: 24,
    paddingBottom: 40,
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
    paddingTop: 80,
    paddingBottom: 32,
    gap: 8,
  },
  logoBox: {
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20, // Login ekranındaki boşluk ayarı login ile uyumlu tutuldu
    marginTop: 20,
    elevation: 8,
  },
  logoImage: {
    width: 150,
    height: 50,
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
  },
  formCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
    gap: 16, // Inputlar arası boşluk
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
  eyeBtn: { padding: 4 },
  eyeIcon: { fontSize: 16 },
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
  bottomRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    marginTop: 24,
  },
  bottomHint: {
    fontSize: 14,
    color: "#9ca3af",
    fontWeight: "500",
  },
  bottomLink: {
    fontSize: 14,
    color: "#111827",
    fontWeight: "900",
    textDecorationLine: "underline",
  },
});