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

    // Telefon: 0 ile başlamasın + tam 10 hane (sadece rakam)
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

      router.replace("/(tabs)");
    } catch (_) {
      Alert.alert("Hata", "Kaydedilemedi. Tekrar dene.");
    } finally {
      setYukleniyor(false);
    }
  };

  return (
    <View style={{ flex: 1, padding: 20, justifyContent: "center" }}>
      <Text style={{ fontSize: 24, fontWeight: "700", marginBottom: 16 }}>
        Profili Tamamla
      </Text>

      <Text style={{ marginBottom: 6 }}>Ad</Text>
      <TextInput
        value={ad}
        onChangeText={setAd}
        placeholder="Adın"
        editable={!yukleniyor}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 12,
          borderRadius: 12,
          marginBottom: 12,
        }}
      />

      <Text style={{ marginBottom: 6 }}>Soyad</Text>
      <TextInput
        value={soyad}
        onChangeText={setSoyad}
        placeholder="Soyadın"
        editable={!yukleniyor}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 12,
          borderRadius: 12,
          marginBottom: 16,
        }}
      />

      <Text style={{ marginBottom: 6 }}>Telefon</Text>
      <TextInput
        keyboardType="number-pad"
        maxLength={10}
        value={telefon}
        onChangeText={(t) => setTelefon(t.replace(/[^0-9]/g, ""))} // sadece rakam
        placeholder="Telefon numaran (5XXXXXXXXX)"
        editable={!yukleniyor}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 12,
          borderRadius: 12,
          marginBottom: 16,
        }}
      />

      <Pressable
        onPress={kaydet}
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
        {yukleniyor ? <ActivityIndicator color="white" /> : null}
        <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>
          {yukleniyor ? "Kaydediliyor..." : "Kaydet"}
        </Text>
      </Pressable>
    </View>
  );
}
