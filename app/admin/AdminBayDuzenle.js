import { get, ref, serverTimestamp, update } from "firebase/database";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
// DİKKAT: firebase.js dosyasından rtdb'yi (Realtime Database) içe aktarıyoruz
import { rtdb } from "../../firebase";

const STATUS_CYCLE = ["available", "maintenance", "offline"];
const STATUS_COLORS = {
  available: {
    bg: "#d1fae5",
    text: "#065f46",
    dot: "#10b981",
    border: "#6ee7b7",
  },
  busy: {
    bg: "#fef3c7",
    text: "#92400e",
    dot: "#f59e0b",
    border: "#fcd34d",
  },
  maintenance: {
    bg: "#fff7ed",
    text: "#9a3412",
    dot: "#f97316",
    border: "#fdba74",
  },
  offline: {
    bg: "#f1f5f9",
    text: "#475569",
    dot: "#94a3b8",
    border: "#cbd5e1",
  },
};

export default function AdminBayDuzenleme() {
  const [bays, setBays] = useState([]);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [islemde, setIslemde] = useState(new Set());

  const durumEtiketi = useMemo(
    () => ({
      available: "Boş",
      busy: "Dolu",
      maintenance: "Bakım",
      offline: "Kapalı",
      waiting: "Bekliyor",
    }),
    [],
  );

  const durumIkon = useMemo(
    () => ({
      available: "✓",
      busy: "●",
      maintenance: "⚙",
      offline: "✕",
      waiting: "⏳",
    }),
    [],
  );

  // RTDB'den verileri çekme fonksiyonu
  const baylariGetir = useCallback(async () => {
    setYukleniyor(true);
    try {
      const baysRef = ref(rtdb, "bays");
      const snapshot = await get(baysRef);

      if (snapshot.exists()) {
        const data = snapshot.val();
        // Gelen JSON objesini diziye çevirip ID'ye göre alfabetik sıralıyoruz
        const bayListesi = Object.keys(data)
          .map((key) => ({
            id: key,
            ...data[key],
          }))
          .sort((a, b) => a.id.localeCompare(b.id));

        setBays(bayListesi);
      } else {
        setBays([]);
      }
    } catch (error) {
      console.error(error);
      Alert.alert("Hata", "Bay listesi alınamadı.");
    } finally {
      setYukleniyor(false);
    }
  }, []);

  useEffect(() => {
    baylariGetir();
  }, [baylariGetir]);

  const statusDondur = useCallback((s) => {
    const idx = STATUS_CYCLE.indexOf(s);
    return STATUS_CYCLE[idx === -1 ? 0 : (idx + 1) % STATUS_CYCLE.length];
  }, []);

  const islemdeEkle = (id) => setIslemde((p) => new Set([...p, id]));
  const islemdeCikar = (id) =>
    setIslemde((p) => {
      const s = new Set(p);
      s.delete(id);
      return s;
    });

  // RTDB üzerinde güncelleme yapma fonksiyonu
  const bayGuncelle = useCallback(async (bayId, patch) => {
    islemdeEkle(bayId);
    try {
      const bayRef = ref(rtdb, `bays/${bayId}`);

      // Zombi Peron Önlemi: Eğer durum 'available' (Boş) yapılıyorsa
      // veya peron 'offline' (Kapalı) konumuna alınıyorsa seans verilerini temizle.
      const guncellemeVerisi = {
        ...patch,
        updatedAt: serverTimestamp(),
      };

      if (patch.status === "available" || patch.status === "offline") {
        guncellemeVerisi.currentSessionId = "";
        guncellemeVerisi.lastUserId = "";
      }

      await update(bayRef, guncellemeVerisi);

      setBays((prev) =>
        prev.map((b) => (b.id === bayId ? { ...b, ...guncellemeVerisi } : b)),
      );
    } catch (error) {
      console.error(error);
      Alert.alert("Hata", "Güncelleme başarısız.");
    } finally {
      islemdeCikar(bayId);
    }
  }, []);

  const statusDegistir = useCallback(
    (bay) => {
      const mevcutDurum = bay.status ?? "available";
      const sonrakiDurum = statusDondur(mevcutDurum);

      if (mevcutDurum === "busy") {
        Alert.alert(
          "Aktif Oturum Var",
          "Bu peron şu an kullanımda. Zorla durum değiştirmek seansı sonlandıracaktır (ESP32 duracaktır). Devam edilsin mi?",
          [
            { text: "İptal", style: "cancel" },
            {
              text: "Evet, Durdur",
              style: "destructive",
              onPress: () => bayGuncelle(bay.id, { status: sonrakiDurum }),
            },
          ],
        );
        return;
      }
      bayGuncelle(bay.id, { status: sonrakiDurum });
    },
    [bayGuncelle, statusDondur],
  );

  const aktifToggle = useCallback(
    (bay) => {
      const aktif = bay.isActive ?? true;

      if (aktif) {
        // Devre dışı bırakılırken status zorunlu olarak offline yapılır
        // bayGuncelle içindeki kontrol sayesinde currentSessionId de temizlenir.
        bayGuncelle(bay.id, { isActive: false, status: "offline" });
      } else {
        bayGuncelle(bay.id, { isActive: true, status: "available" });
      }
    },
    [bayGuncelle],
  );

  if (yukleniyor) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#111827" size="large" />
        <Text style={styles.loadingText}>Baylar yükleniyor…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.title}>Bay Listesi</Text>
          <Text style={styles.subtitle}>{bays.length} bay bulundu</Text>
        </View>
        <Pressable
          onPress={baylariGetir}
          style={({ pressed }) => [
            styles.refreshBtn,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.refreshBtnText}>↻ Yenile</Text>
        </Pressable>
      </View>

      {/* Hint */}
      <View style={styles.hintBox}>
        <Text style={styles.hintIcon}>ℹ</Text>
        <Text style={styles.hintText}>
          Durum döngüsü: Boş → Bakım → Kapalı.
        </Text>
      </View>

      {/* Bay List */}
      {bays.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyIcon}>🏪</Text>
          <Text style={styles.emptyText}>Bay bulunamadı.</Text>
          <Text style={styles.emptySubtext}>
            RTDBde `bays` düğümünü oluşturun.
          </Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          style={{ maxHeight: 480 }}
        >
          {bays.map((bay, index) => {
            const status = bay.status ?? "available";
            const aktif = bay.isActive ?? true;
            const mesgul = islemde.has(bay.id);
            const renk = STATUS_COLORS[status] ?? STATUS_COLORS.offline;
            const statusKilitli = !aktif || mesgul;

            return (
              <View
                key={bay.id}
                style={[
                  styles.bayCard,
                  !aktif && styles.bayCardPassive,
                  index === bays.length - 1 && { marginBottom: 4 },
                ]}
              >
                {/* Left: info */}
                <View style={styles.bayInfo}>
                  <View style={styles.bayIdRow}>
                    <Text style={styles.bayId}>{bay.id}</Text>
                    {!aktif && (
                      <View style={styles.pasifChip}>
                        <Text style={styles.pasifChipText}>PASİF</Text>
                      </View>
                    )}
                  </View>

                  <View
                    style={[
                      styles.statusChip,
                      { backgroundColor: renk.bg, borderColor: renk.border },
                    ]}
                  >
                    <View
                      style={[styles.statusDot, { backgroundColor: renk.dot }]}
                    />
                    <Text style={[styles.statusLabel, { color: renk.text }]}>
                      {durumIkon[status]} {durumEtiketi[status] ?? status}
                    </Text>
                  </View>
                </View>

                {/* Right: actions */}
                <View style={styles.actions}>
                  <Pressable
                    onPress={() => statusDegistir(bay)}
                    disabled={statusKilitli}
                    style={({ pressed }) => [
                      styles.btnPrimary,
                      pressed && !statusKilitli && { opacity: 0.8 },
                      statusKilitli && styles.btnDisabled,
                    ]}
                  >
                    {mesgul ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={styles.btnPrimaryText}>Durum</Text>
                    )}
                  </Pressable>

                  <Pressable
                    onPress={() => aktifToggle(bay)}
                    disabled={mesgul}
                    style={({ pressed }) => [
                      styles.btnSecondary,
                      aktif && styles.btnDanger,
                      pressed && { opacity: 0.8 },
                      mesgul && styles.btnDisabled,
                    ]}
                  >
                    <Text
                      style={[
                        styles.btnSecondaryText,
                        aktif && styles.btnDangerText,
                      ]}
                    >
                      {aktif ? "Devre Dışı" : "Aktif Et"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },

  loadingContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
    gap: 10,
  },
  loadingText: {
    color: "#6b7280",
    fontSize: 13,
    fontWeight: "600",
  },

  // Header
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    fontSize: 17,
    fontWeight: "900",
    color: "#111827",
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 12,
    color: "#9ca3af",
    fontWeight: "600",
    marginTop: 1,
  },
  refreshBtn: {
    backgroundColor: "#f3f4f6",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  refreshBtnText: {
    fontWeight: "800",
    color: "#374151",
    fontSize: 13,
  },

  // Hint
  hintBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#eff6ff",
    borderRadius: 10,
    padding: 10,
    gap: 6,
    borderWidth: 1,
    borderColor: "#bfdbfe",
  },
  hintIcon: {
    fontSize: 13,
    color: "#3b82f6",
    marginTop: 1,
  },
  hintText: {
    flex: 1,
    fontSize: 12,
    color: "#1d4ed8",
    lineHeight: 17,
    fontWeight: "500",
  },

  // Empty
  emptyBox: {
    alignItems: "center",
    paddingVertical: 36,
    gap: 6,
  },
  emptyIcon: { fontSize: 36 },
  emptyText: { fontSize: 15, fontWeight: "800", color: "#374151" },
  emptySubtext: { fontSize: 12, color: "#9ca3af" },

  // Bay Card
  bayCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  bayCardPassive: {
    backgroundColor: "#fafafa",
    borderColor: "#f3f4f6",
    opacity: 0.8,
  },
  bayInfo: {
    flex: 1,
    gap: 6,
  },
  bayIdRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  bayId: {
    fontSize: 14,
    fontWeight: "900",
    color: "#111827",
    letterSpacing: -0.2,
  },
  pasifChip: {
    backgroundColor: "#fee2e2",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  pasifChipText: {
    fontSize: 9,
    fontWeight: "900",
    color: "#dc2626",
    letterSpacing: 0.5,
  },

  // Status chip
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 3,
    gap: 5,
    borderWidth: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: "700",
  },

  // Actions
  actions: {
    flexDirection: "row",
    gap: 6,
  },
  btnPrimary: {
    backgroundColor: "#111827",
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 64,
    minHeight: 36,
  },
  btnPrimaryText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 12,
  },
  btnSecondary: {
    backgroundColor: "#f3f4f6",
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    minWidth: 72,
    minHeight: 36,
  },
  btnSecondaryText: {
    color: "#374151",
    fontWeight: "800",
    fontSize: 12,
  },
  btnDanger: {
    backgroundColor: "#fff5f5",
    borderColor: "#fca5a5",
  },
  btnDangerText: {
    color: "#dc2626",
  },
  btnDisabled: {
    opacity: 0.35,
  },
});
