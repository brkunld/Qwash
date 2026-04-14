import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false, // Genellikle giriş ekranlarında header istenmez
      }}
    >
      {/* Ana Giriş Sayfaları */}
      <Stack.Screen name="index" />
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
      <Stack.Screen name="forgot-password" />
      <Stack.Screen name="profil-tamamla" />

      {/* Alt Sekmeler (Tabs) Grubu */}
      {/* name="(tabs)" olması için (tabs) klasörü içinde _layout.js olmalı */}
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />

      {/* Admin Paneli Grubu */}
      <Stack.Screen name="admin/index" options={{ title: "Admin Paneli" }} />
      <Stack.Screen
        name="admin/AdminKullaniciAra"
        options={{ title: "Kullanıcı Ara" }}
      />
      <Stack.Screen
        name="admin/AdminBayDuzenle"
        options={{ title: "Bayi Düzenle" }}
      />
    </Stack>
  );
}
