import { Ionicons } from "@expo/vector-icons"; // İkon kullanmak isterseniz
import { Tabs } from "expo-router";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false, // Üst başlığı gizler
        tabBarShowLabel: false, // ALTAKİ YAZILARI KALDIRAN SATIR
        tabBarStyle: {
          backgroundColor: "#ffffff",
          borderTopWidth: 0,
          elevation: 5, // Android gölge
          height: 60,
        },
      }}
    >
      <Tabs.Screen
        name="kullanici"
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="qr-kamera"
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="qr-code" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
