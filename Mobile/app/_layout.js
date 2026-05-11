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

      {/* Admin klasörünü sildiğimiz için buradaki admin Stack.Screen tanımlarını da kaldırdık. 
        Eğer gelecekte başka sayfaların header'ını özelleştirmek isterseniz buraya ekleyebilirsiniz.
      */}
    </Stack>
  );
}
