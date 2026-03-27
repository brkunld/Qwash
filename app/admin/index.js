import { router } from "expo-router";
import { signOut } from "firebase/auth";
import { useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { auth } from "../../firebase";

import AdminBayDuzenleme from "./AdminBayDuzenle";
import AdminKullaniciAra from "./AdminKullaniciAra";

export default function AdminPanel() {
  const [sekme, setSekme] = useState("bakiye");

  const cikisYap = async () => {
    try {
      await signOut(auth);
      router.replace("/login");
    } catch (_) {
      Alert.alert("Hata", "Çıkış yapılamadı.");
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <View style={styles.headerBadge}>
          <Text style={styles.headerBadgeText}>⚡ ADMIN PANELİ</Text>
        </View>
        <View style={styles.headerContent}></View>
        <Pressable
          onPress={cikisYap}
          style={({ pressed }) => [
            styles.logoutBtn,
            pressed && styles.logoutBtnPressed,
          ]}
        >
          <Text style={styles.logoutText}>↪ Çıkış</Text>
        </Pressable>
      </View>

      {/* DIVIDER */}
      <View style={styles.divider} />

      {/* TABS */}
      <View style={styles.tabContainer}>
        <View style={styles.tabRow}>
          <Pressable
            onPress={() => setSekme("bakiye")}
            style={[styles.tabBtn, sekme === "bakiye" && styles.tabBtnActive]}
          >
            <Text style={styles.tabIcon}>💳</Text>
            <Text
              style={[
                styles.tabBtnText,
                sekme === "bakiye" && styles.tabBtnTextActive,
              ]}
            >
              Bakiye Yükleme
            </Text>
            {sekme === "bakiye" && <View style={styles.tabIndicator} />}
          </Pressable>

          <Pressable
            onPress={() => setSekme("bay")}
            style={[styles.tabBtn, sekme === "bay" && styles.tabBtnActive]}
          >
            <Text style={styles.tabIcon}>🏪</Text>
            <Text
              style={[
                styles.tabBtnText,
                sekme === "bay" && styles.tabBtnTextActive,
              ]}
            >
              Bay Düzenleme
            </Text>
            {sekme === "bay" && <View style={styles.tabIndicator} />}
          </Pressable>
        </View>
      </View>

      {/* CONTENT */}
      <View style={styles.content}>
        {sekme === "bakiye" ? <AdminKullaniciAra /> : <AdminBayDuzenleme />}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: "#f8f9fb",
  },

  // HEADER
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 52,
    paddingBottom: 20,
    backgroundColor: "#111827",
  },
  headerBadge: {
    backgroundColor: "#f59e0b",
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  headerBadgeText: {
    fontSize: 15,
    fontWeight: "900",
    color: "#111827",
    letterSpacing: 0.5,
  },
  headerContent: {
    flex: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: "900",
    color: "#ffffff",
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 12,
    color: "#9ca3af",
    marginTop: 1,
  },
  logoutBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  logoutBtnPressed: {
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  logoutText: {
    color: "#f3f4f6",
    fontWeight: "700",
    fontSize: 13,
  },

  divider: {
    height: 3,
    backgroundColor: "#f59e0b",
  },

  // TABS
  tabContainer: {
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 0,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  tabRow: {
    flexDirection: "row",
    gap: 4,
  },
  tabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 0,
    borderBottomWidth: 3,
    borderBottomColor: "transparent",
    position: "relative",
  },
  tabBtnActive: {
    borderBottomColor: "#111827",
  },
  tabIcon: {
    fontSize: 15,
  },
  tabBtnText: {
    fontWeight: "700",
    fontSize: 13,
    color: "#9ca3af",
  },
  tabBtnTextActive: {
    color: "#111827",
  },
  tabIndicator: {
    position: "absolute",
    bottom: -1,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: "#111827",
    borderRadius: 3,
  },

  // CONTENT
  content: {
    flex: 1,
    padding: 16,
  },
});
