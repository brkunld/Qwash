import React, { useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
import { router } from "expo-router";
import {createUserWithEmailAndPassword,sendEmailVerification,} from "firebase/auth";
import { auth } from "../firebase";

export default function Register() {
  const [email, setEmail] = useState("");
  const [sifre, setSifre] = useState("");
  const [sifre2, setSifre2] = useState("");
  const [yukleniyor, setYukleniyor] = useState(false);

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
    <View style={{ flex: 1, padding: 20, justifyContent: "center" }}>
      <Text style={{ fontSize: 28, fontWeight: "700", marginBottom: 20 }}>
        Kayıt Ol
      </Text>

      <Text>Email</Text>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="ornek@mail.com"
        autoCapitalize="none"
        keyboardType="email-address"
        style={inputStyle}
      />

      <Text>Şifre</Text>
      <TextInput
        value={sifre}
        onChangeText={setSifre}
        secureTextEntry
        style={inputStyle}
      />

      <Text>Şifre Tekrar</Text>
      <TextInput
        value={sifre2}
        onChangeText={setSifre2}
        secureTextEntry
        style={inputStyle}
      />

      <Pressable
        onPress={kayitOl}
        disabled={yukleniyor}
        style={[
          buttonStyle,
          { backgroundColor: yukleniyor ? "#999" : "#111" },
        ]}
      >
        <Text style={{ color: "white", fontSize: 16 }}>
          {yukleniyor ? "Kaydediliyor..." : "Kayıt Ol"}
        </Text>
      </Pressable>

      <Pressable
        onPress={() => router.replace("/login")}
        style={{ marginTop: 14, alignItems: "center" }}
      >
        <Text style={{ textDecorationLine: "underline" }}>
          Zaten hesabın var mı? Giriş Yap
        </Text>
      </Pressable>
    </View>
  );
}

const inputStyle = {
  borderWidth: 1,
  borderColor: "#ddd",
  padding: 12,
  borderRadius: 12,
  marginBottom: 12,
};

const buttonStyle = {
  padding: 14,
  borderRadius: 12,
  alignItems: "center",
  marginTop: 6,
};
