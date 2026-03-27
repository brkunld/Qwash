import { router } from "expo-router";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { auth, db } from "../firebase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sifre, setSifre] = useState("");
  const [yukleniyor, setYukleniyor] = useState(false);
  const [sifreGoster, setSifreGoster] = useState(false);

  const girisYap = async () => {
    if (!email.trim() || !sifre.trim()) {
      Alert.alert("Hata", "Email ve şifre zorunlu.");
      return;
    }
    setYukleniyor(true);
    try {
      const userCredential = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        sifre,
      );
      const user = userCredential.user;

      if (!user.emailVerified) {
        await signOut(auth);
        Alert.alert("Doğrulama Gerekli", "Lütfen email adresini doğrula.");
        return;
      }

      const tokenResult = await user.getIdTokenResult(true);
      if (tokenResult?.claims?.admin === true) {
        router.replace("/admin");
        return;
      }

      const userSnap = await getDoc(doc(db, "users", user.uid));
      const data = userSnap.exists() ? userSnap.data() : null;
      const profilTamam = !!data?.ad?.trim?.() && !!data?.soyad?.trim?.();

      if (!profilTamam) {
        router.replace(`/profil-tamamla?uid=${user.uid}`);
        return;
      }

      router.replace("/(tabs)/kullanici");
    } catch (error) {
      const kod = error?.code;
      let mesaj = "Giriş yapılamadı. Bilgileri kontrol et.";
      if (kod === "auth/invalid-email") mesaj = "Email formatı hatalı.";
      else if (kod === "auth/user-not-found")
        mesaj = "Bu email ile kullanıcı bulunamadı.";
      else if (kod === "auth/wrong-password") mesaj = "Şifre yanlış.";
      else if (kod === "auth/invalid-credential")
        mesaj = "Email veya şifre hatalı.";
      else if (kod === "auth/too-many-requests")
        mesaj = "Çok fazla deneme. Bir süre sonra tekrar dene.";
      Alert.alert("Hata", mesaj);
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
        bounces={false}
      >
        {/* Top Decoration */}
        <View style={styles.topDecor}>
          <View style={styles.decorCircleLarge} />
          <View style={styles.decorCircleSmall} />
        </View>

        {/* Logo / Brand */}
        <View style={styles.brandArea}>
          <View style={styles.logoBox}>
            <Text style={styles.logoIcon}>⚡</Text>
          </View>
          <Text style={styles.brandTitle}>Hoş Geldiniz</Text>
          <Text style={styles.brandSubtitle}>Devam etmek için giriş yapın</Text>
        </View>

        {/* Form Card */}
        <View style={styles.formCard}>
          {/* Email */}
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

          {/* Password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Şifre</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.inputIcon}>🔒</Text>
              <TextInput
                value={sifre}
                onChangeText={setSifre}
                placeholder="••••••••"
                placeholderTextColor="#9ca3af"
                secureTextEntry={!sifreGoster}
                editable={!yukleniyor}
                style={[styles.input, { flex: 1 }]}
                returnKeyType="done"
                onSubmitEditing={girisYap}
              />
              <Pressable
                onPress={() => setSifreGoster((p) => !p)}
                style={styles.eyeBtn}
              >
                <Text style={styles.eyeIcon}>{sifreGoster ? "🙈" : "👁️"}</Text>
              </Pressable>
            </View>
          </View>

          {/* Forgot Password */}
          <Pressable
            onPress={() => router.push("/forgot-password")}
            style={styles.forgotBtn}
          >
            <Text style={styles.forgotText}>Şifremi Unuttum</Text>
          </Pressable>

          {/* Login Button */}
          <Pressable
            onPress={girisYap}
            disabled={yukleniyor}
            style={({ pressed }) => [
              styles.loginBtn,
              pressed && { opacity: 0.88 },
              yukleniyor && { opacity: 0.8 },
            ]}
          >
            {yukleniyor ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.loginBtnText}>Giriş Yap →</Text>
            )}
          </Pressable>
        </View>

        {/* Register Link */}
        <View style={styles.registerRow}>
          <Text style={styles.registerHint}>Hesabın yok mu?</Text>
          <Pressable
            onPress={() => router.push("/register")}
            disabled={yukleniyor}
          >
            <Text style={styles.registerLink}>Kayıt Ol</Text>
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

  // Top Decoration
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

  // Brand
  brandArea: {
    alignItems: "center",
    paddingTop: 80,
    paddingBottom: 32,
    gap: 8,
  },
  logoBox: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
    shadowColor: "#111827",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 8,
  },
  logoIcon: { fontSize: 28 },
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

  // Form Card
  formCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
    gap: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },

  // Fields
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
  eyeBtn: {
    padding: 4,
  },
  eyeIcon: { fontSize: 16 },

  // Forgot
  forgotBtn: {
    alignSelf: "flex-end",
    marginTop: -4,
  },
  forgotText: {
    fontSize: 12,
    color: "#6b7280",
    fontWeight: "700",
    textDecorationLine: "underline",
  },

  // Login Button
  loginBtn: {
    backgroundColor: "#111827",
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
    minHeight: 52,
    shadowColor: "#111827",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  loginBtnText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 16,
    letterSpacing: 0.2,
  },

  // Register
  registerRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    marginTop: 24,
  },
  registerHint: {
    fontSize: 14,
    color: "#9ca3af",
    fontWeight: "500",
  },
  registerLink: {
    fontSize: 14,
    color: "#111827",
    fontWeight: "900",
    textDecorationLine: "underline",
  },
});
