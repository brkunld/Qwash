import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false, // Tüm sayfalarda varsayılan olarak header'ı gizler
      }}
    >
      {/* Expo Router dosyaları otomatik algılar. 
        Ana giriş sayfalarını (index, login, register vb.) tekrar yazmanıza gerek yoktur.
      */}

      {/* Sadece görünümünü özelleştirmek istediğiniz sayfaları belirtin */}
      <Stack.Screen
        name="admin/index"
        options={{
          headerShown: true, // Admin panelinde header görünmesini istiyorsanız true yapın
          title: "Admin Paneli",
        }}
      />

      <Stack.Screen
        name="admin/AdminKullaniciAra"
        options={{
          headerShown: true,
          title: "Kullanıcı Ara",
        }}
      />

      <Stack.Screen
        name="admin/AdminBayDuzenle"
        options={{
          headerShown: true,
          title: "Bayi Düzenle",
        }}
      />
    </Stack>
  );
}
