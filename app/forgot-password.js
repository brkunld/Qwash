import { router } from "expo-router";
import { sendPasswordResetEmail } from "firebase/auth";
import { useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Pressable,
    Text,
    TextInput,
    View,
} from "react-native";
import { auth } from "../firebase";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [yukleniyor, setYukleniyor] = useState(false);

  const sifreSifirla = async () => {
    if (!email.trim()) {
      Alert.alert("Hata", "Email adresi zorunlu.");
      return;
    }

    setYukleniyor(true);

    try {
      await sendPasswordResetEmail(auth, email.trim());

      Alert.alert(
        "Başarılı",
        "Şifre sıfırlama linki email adresine gönderildi.",
        [
          {
            text: "Tamam",
            onPress: () => router.replace("/login"),
          },
        ],
      );
    } catch (error) {
      let mesaj = "Bir hata oluştu.";

      if (error.code === "auth/invalid-email") mesaj = "Email formatı hatalı.";
      else if (error.code === "auth/user-not-found")
        mesaj = "Bu email ile kullanıcı bulunamadı.";

      Alert.alert("Hata", mesaj);
    } finally {
      setYukleniyor(false);
    }
  };

  return (
    <View style={{ flex: 1, padding: 20, justifyContent: "center" }}>
      <Text style={{ fontSize: 28, fontWeight: "700", marginBottom: 16 }}>
        Şifremi Unuttum
      </Text>

      <Text style={{ marginBottom: 6 }}>Email</Text>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="ornek@mail.com"
        autoCapitalize="none"
        keyboardType="email-address"
        editable={!yukleniyor}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 12,
          borderRadius: 12,
          marginBottom: 16,
          opacity: yukleniyor ? 0.7 : 1,
        }}
      />

      <Pressable
        onPress={sifreSifirla}
        disabled={yukleniyor}
        style={{
          padding: 14,
          borderRadius: 12,
          alignItems: "center",
          backgroundColor: yukleniyor ? "#444" : "#111",
          flexDirection: "row",
          justifyContent: "center",
          gap: 10,
        }}
      >
        {yukleniyor && <ActivityIndicator color="white" />}
        <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>
          {yukleniyor ? "Gönderiliyor..." : "Sıfırlama Linki Gönder"}
        </Text>
      </Pressable>

      <Pressable
        onPress={() => router.replace("/login")}
        style={{ marginTop: 15, alignItems: "center" }}
      >
        <Text style={{ textDecorationLine: "underline" }}>
          Giriş ekranına dön
        </Text>
      </Pressable>
    </View>
  );
}
