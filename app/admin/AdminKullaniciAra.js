import {
    collection,
    doc,
    getDoc,
    getDocs,
    limit,
    query,
    runTransaction,
    serverTimestamp,
    where,
} from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";
import { auth, db } from "../../firebase";

export default function AdminKullaniciAra() {
  const [arama, setArama] = useState("");
  const [yukleniyor, setYukleniyor] = useState(false);
  const [kullanici, setKullanici] = useState(null);

  const [modalVisible, setModalVisible] = useState(false);
  const [yuklenecekJeton, setYuklenecekJeton] = useState("");
  const [islemYukleniyor, setIslemYukleniyor] = useState(false);

  const [jetonFiyat, setJetonFiyat] = useState(null);
  const [fiyatYukleniyor, setFiyatYukleniyor] = useState(true);

  const aramaTrim = useMemo(() => arama.trim(), [arama]);

  useEffect(() => {
    let aktif = true;
    const fiyatGetir = async () => {
      try {
        setFiyatYukleniyor(true);
        const snap = await getDoc(doc(db, "packages", "jeton"));
        const fiyat = snap.exists() ? Number(snap.data()?.jetonFiyat ?? 0) : 0;
        if (!fiyat || fiyat <= 0) {
          Alert.alert(
            "Hata",
            "Jeton fiyatı bulunamadı. Firestore: packages/jeton -> jetonFiyat",
          );
          if (aktif) setJetonFiyat(null);
          return;
        }
        if (aktif) setJetonFiyat(fiyat);
      } catch (e) {
        Alert.alert("Hata", String(e?.message ?? e));
        if (aktif) setJetonFiyat(null);
      } finally {
        if (aktif) setFiyatYukleniyor(false);
      }
    };
    fiyatGetir();
    return () => {
      aktif = false;
    };
  }, []);

  const uidGibiMi = (t) =>
    t && !t.includes("@") && !t.includes(" ") && t.length >= 20;
  const emailMi = (t) => /\S+@\S+\.\S+/.test(t);

  const kullaniciBul = async () => {
    if (!aramaTrim) {
      Alert.alert("Hata", "UID / Email / Telefon gir.");
      return;
    }
    setYukleniyor(true);
    setKullanici(null);
    try {
      if (uidGibiMi(aramaTrim)) {
        const snap = await getDoc(doc(db, "users", aramaTrim));
        if (snap.exists()) {
          setKullanici({ id: snap.id, ...snap.data() });
          return;
        }
      }
      if (emailMi(aramaTrim)) {
        const s = await getDocs(
          query(
            collection(db, "users"),
            where("email", "==", aramaTrim.toLowerCase()),
            limit(1),
          ),
        );
        if (!s.empty) {
          const d = s.docs[0];
          setKullanici({ id: d.id, ...d.data() });
          return;
        }
      }
      const s = await getDocs(
        query(
          collection(db, "users"),
          where("telefon", "==", aramaTrim),
          limit(1),
        ),
      );
      if (!s.empty) {
        const d = s.docs[0];
        setKullanici({ id: d.id, ...d.data() });
        return;
      }
      Alert.alert("Bulunamadı", "Eşleşen kullanıcı yok.");
    } catch (_) {
      Alert.alert("Hata", "Arama sırasında hata oluştu.");
    } finally {
      setYukleniyor(false);
    }
  };

  const temizle = () => {
    setArama("");
    setKullanici(null);
  };
  const modalAc = () => {
    setYuklenecekJeton("");
    setModalVisible(true);
  };
  const modalKapat = () => {
    if (islemYukleniyor) return;
    setModalVisible(false);
  };

  const bakiyeYukle = async () => {
    if (!kullanici?.id) {
      Alert.alert("Hata", "Önce kullanıcı bulmalısın.");
      return;
    }
    const adet = parseInt(yuklenecekJeton.trim(), 10);
    if (!Number.isFinite(adet) || adet <= 0) {
      Alert.alert("Hata", "Geçerli bir jeton miktarı gir (örn: 5).");
      return;
    }
    if (!jetonFiyat) {
      Alert.alert("Hata", "Jeton fiyatı hazır değil.");
      return;
    }
    setIslemYukleniyor(true);
    try {
      const userRef = doc(db, "users", kullanici.id);
      const amountTRY = Number(adet) * Number(jetonFiyat);
      const adminUid = auth.currentUser?.uid ?? null;
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists()) throw new Error("Kullanıcı dokümanı bulunamadı.");
        const yeni = Number(snap.data()?.walletTokens ?? 0) + Number(adet);
        tx.update(userRef, { walletTokens: yeni });
        tx.set(doc(collection(db, "transactions")), {
          userId: kullanici.id,
          type: "topup",
          tokens: adet,
          amountTRY,
          unitPriceTRY: jetonFiyat,
          bayId: null,
          packageId: null,
          status: "success",
          adminId: adminUid,
          createdAt: serverTimestamp(),
        });
      });
      setKullanici((prev) =>
        prev
          ? { ...prev, walletTokens: (prev.walletTokens ?? 0) + adet }
          : prev,
      );
      setModalVisible(false);
      Alert.alert("Başarılı", `+${adet} jeton yüklendi. (₺${amountTRY})`);
    } catch (_) {
      Alert.alert("Hata", "Bakiye yükleme başarısız oldu.");
    } finally {
      setIslemYukleniyor(false);
    }
  };

  const toplamTL = useMemo(() => {
    const adet = parseInt((yuklenecekJeton || "").trim(), 10);
    return Number.isFinite(adet) && adet > 0 && jetonFiyat
      ? adet * jetonFiyat
      : 0;
  }, [yuklenecekJeton, jetonFiyat]);

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      {/* Search Section */}
      <View style={styles.searchSection}>
        <View style={styles.searchLabelRow}>
          <Text style={styles.searchIcon}>🔍</Text>
          <Text style={styles.searchLabel}>Kullanıcı Ara</Text>
        </View>
        <Text style={styles.searchHint}>
          E-posta, telefon veya UID ile arayın
        </Text>

        <View style={styles.inputWrapper}>
          <TextInput
            value={arama}
            onChangeText={setArama}
            placeholder="telefon no veya e-posta giriniz"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            onSubmitEditing={kullaniciBul}
            returnKeyType="search"
          />
        </View>

        <View style={styles.buttonRow}>
          <Pressable
            onPress={kullaniciBul}
            disabled={yukleniyor}
            style={({ pressed }) => [
              styles.primaryBtn,
              (pressed || yukleniyor) && { opacity: 0.8 },
            ]}
          >
            {yukleniyor ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.primaryBtnText}>Ara</Text>
            )}
          </Pressable>

          <Pressable
            onPress={temizle}
            disabled={yukleniyor}
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && { opacity: 0.8 },
              yukleniyor && { opacity: 0.5 },
            ]}
          >
            <Text style={styles.secondaryBtnText}>✕ Temizle</Text>
          </Pressable>
        </View>
      </View>

      {/* User Card */}
      {kullanici && (
        <View style={styles.userCard}>
          {/* Card Header */}
          <View style={styles.userCardHeader}>
            <View style={styles.avatarCircle}>
              <Text style={styles.avatarText}>
                {(kullanici.ad ?? "?")[0].toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.userName}>
                {kullanici.ad ?? "-"} {kullanici.soyad ?? ""}
              </Text>
            </View>
          </View>

          <View style={styles.cardDivider} />

          <InfoRow icon="✉️" label="E-posta" value={kullanici.email ?? "-"} />
          <InfoRow icon="📞" label="Telefon" value={kullanici.telefon ?? "-"} />

          <View style={styles.cardDivider} />

          <View style={styles.walletBox}>
            <View>
              <Text style={styles.walletLabel}>Cüzdan Bakiyesi</Text>
              <Text style={styles.walletValue}>
                {kullanici.walletTokens ?? 0}
                <Text style={styles.walletUnit}> jeton</Text>
              </Text>
            </View>
            <View style={styles.walletIcon}>
              <Text style={{ fontSize: 22 }}>💳</Text>
            </View>
          </View>

          {/* Charge Button */}
          <Pressable
            onPress={modalAc}
            disabled={fiyatYukleniyor || !jetonFiyat}
            style={({ pressed }) => [
              styles.chargeBtn,
              pressed && { opacity: 0.85 },
              (fiyatYukleniyor || !jetonFiyat) && { opacity: 0.5 },
            ]}
          >
            <Text style={styles.chargeBtnText}>
              {fiyatYukleniyor
                ? "Fiyat Yükleniyor…"
                : !jetonFiyat
                  ? "Fiyat Bulunamadı"
                  : `⚡ Bakiye Yükle  •  ₺${jetonFiyat}/jeton`}
            </Text>
          </Pressable>
        </View>
      )}

      {/* Modal */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="slide"
        onRequestClose={modalKapat}
      >
        <Pressable style={styles.overlay} onPress={modalKapat}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            {/* Handle */}
            <View style={styles.modalHandle} />

            <Text style={styles.modalTitle}>Bakiye Yükle</Text>
            {jetonFiyat && (
              <View style={styles.modalPriceRow}>
                <Text style={styles.modalPriceLabel}>Birim fiyat</Text>
                <Text style={styles.modalPriceValue}>
                  ₺{jetonFiyat} / jeton
                </Text>
              </View>
            )}

            <Text style={styles.modalInputLabel}>Jeton Miktarı</Text>
            <TextInput
              value={yuklenecekJeton}
              onChangeText={setYuklenecekJeton}
              placeholder="örn: 5"
              placeholderTextColor="#9ca3af"
              keyboardType="numeric"
              style={styles.modalInput}
              editable={!islemYukleniyor}
            />

            {/* Total Preview */}
            {toplamTL > 0 && (
              <View style={styles.totalBox}>
                <Text style={styles.totalLabel}>Toplam Tutar</Text>
                <Text style={styles.totalValue}>₺{toplamTL}</Text>
              </View>
            )}

            <View style={styles.modalBtnRow}>
              <Pressable
                onPress={modalKapat}
                disabled={islemYukleniyor}
                style={({ pressed }) => [
                  styles.modalCancel,
                  pressed && { opacity: 0.8 },
                  islemYukleniyor && { opacity: 0.5 },
                ]}
              >
                <Text style={styles.modalCancelText}>İptal</Text>
              </Pressable>

              <Pressable
                onPress={bakiyeYukle}
                disabled={islemYukleniyor || !jetonFiyat}
                style={({ pressed }) => [
                  styles.modalOk,
                  pressed && { opacity: 0.85 },
                  (islemYukleniyor || !jetonFiyat) && { opacity: 0.5 },
                ]}
              >
                {islemYukleniyor ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.modalOkText}>✓ Yükle</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

function InfoRow({ icon, label, value }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoIcon}>{icon}</Text>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 14,
    flexGrow: 1,
    paddingBottom: 24,
  },

  // Search Section
  searchSection: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  searchLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  searchIcon: { fontSize: 16 },
  searchLabel: {
    fontSize: 16,
    fontWeight: "900",
    color: "#111827",
    letterSpacing: -0.2,
  },
  searchHint: {
    fontSize: 12,
    color: "#9ca3af",
    fontWeight: "500",
    marginTop: -4,
  },
  inputWrapper: {
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 12,
    backgroundColor: "#fafafa",
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: "#111827",
    fontWeight: "500",
  },
  buttonRow: {
    flexDirection: "row",
    gap: 8,
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: "#111827",
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 46,
  },
  primaryBtnText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 15,
    letterSpacing: 0.2,
  },
  secondaryBtn: {
    backgroundColor: "#f3f4f6",
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  secondaryBtnText: {
    color: "#6b7280",
    fontWeight: "700",
    fontSize: 13,
  },

  // User Card
  userCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  userCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatarCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 20,
  },
  userName: {
    fontSize: 16,
    fontWeight: "900",
    color: "#111827",
  },
  userId: {
    fontSize: 11,
    color: "#9ca3af",
    fontWeight: "500",
    marginTop: 1,
  },
  cardDivider: {
    height: 1,
    backgroundColor: "#f3f4f6",
  },

  // Info Rows
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  infoIcon: { fontSize: 14, width: 20, textAlign: "center" },
  infoLabel: {
    color: "#6b7280",
    fontSize: 13,
    fontWeight: "600",
    width: 70,
  },
  infoValue: {
    flex: 1,
    color: "#111827",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "right",
  },

  // Wallet Box
  walletBox: {
    backgroundColor: "#f8f9fb",
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  walletLabel: {
    fontSize: 12,
    color: "#6b7280",
    fontWeight: "600",
    marginBottom: 2,
  },
  walletValue: {
    fontSize: 26,
    fontWeight: "900",
    color: "#111827",
    letterSpacing: -0.5,
  },
  walletUnit: {
    fontSize: 14,
    fontWeight: "600",
    color: "#6b7280",
  },
  walletIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    alignItems: "center",
    justifyContent: "center",
  },

  // Charge Button
  chargeBtn: {
    backgroundColor: "#111827",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  chargeBtnText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 14,
    letterSpacing: 0.1,
  },

  // Modal
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 36,
    gap: 12,
  },
  modalHandle: {
    width: 40,
    height: 4,
    backgroundColor: "#e5e7eb",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 4,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "900",
    color: "#111827",
    letterSpacing: -0.3,
  },
  modalPriceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#f8f9fb",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  modalPriceLabel: {
    fontSize: 13,
    color: "#6b7280",
    fontWeight: "600",
  },
  modalPriceValue: {
    fontSize: 13,
    color: "#111827",
    fontWeight: "800",
  },
  modalInputLabel: {
    fontSize: 12,
    color: "#6b7280",
    fontWeight: "700",
    marginBottom: -4,
  },
  modalInput: {
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 18,
    color: "#111827",
    fontWeight: "700",
    backgroundColor: "#fafafa",
  },

  // Total Box
  totalBox: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#ecfdf5",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#6ee7b7",
  },
  totalLabel: {
    fontSize: 13,
    color: "#065f46",
    fontWeight: "700",
  },
  totalValue: {
    fontSize: 18,
    color: "#065f46",
    fontWeight: "900",
    letterSpacing: -0.3,
  },

  // Modal Buttons
  modalBtnRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  modalCancel: {
    flex: 1,
    backgroundColor: "#f3f4f6",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  modalCancelText: {
    color: "#374151",
    fontWeight: "800",
    fontSize: 15,
  },
  modalOk: {
    flex: 2,
    backgroundColor: "#111827",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 50,
  },
  modalOkText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 15,
  },
});
