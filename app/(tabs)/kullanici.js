import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useKullaniciIslemleri } from "../services/kullaniciIslemleri";

const DARK = "#1a1a2e";
const YELLOW = "#f5a623";
const WHITE = "#ffffff";
const GRAY_BG = "#f2f4f7";
const GRAY_BORDER = "#e2e6ea";
const GRAY_TEXT = "#6b7280";
const DARK_TEXT = "#111827";

export default function KullaniciEkrani() {
  const {
    authYukleniyor,
    uid,
    seciliBay,
    bayYukleniyor,
    bakiye,
    bakiyeYukleniyor,
    jetonAdet,
    setJetonAdet,
    jetonFiyat,
    fiyatYukleniyor,
    toplamTRY,
    toplamText,
    adetNum,
    profilAcik,
    setProfilAcik,
    profilYukleniyor,
    profilKaydediyor,
    ad,
    setAd,
    soyad,
    setSoyad,
    telefon,
    setTelefon,
    yuklemeAcik,
    setYuklemeAcik,
    yuklemeIslemde,
    kartNo,
    setKartNo,
    sonKullanma,
    setSonKullanma,
    cvv,
    setCvv,
    sessionYukleniyor,
    sayacText,
    sessionBitiriliyor,
    sessionVarMi,
    sessionRunningMi,
    sessionTurLabel,
    butonKilitli,
    sessionBaslat,
    sessionBitir,
    bakiyeYukle,
    profilKaydet,
    qrKameraAc,
    cikisYap,
  } = useKullaniciIslemleri();

  if (authYukleniyor || !uid) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={YELLOW} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerBadge}>
          <Text style={styles.headerBadgeText}> Ana Sayfa </Text>
        </View>
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => setProfilAcik(true)}
            style={styles.headerBtn}
          >
            <Text style={styles.headerBtnText}>👤 Profil</Text>
          </Pressable>
          <Pressable onPress={cikisYap} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>⇥ Çıkış</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {/* Bay Kartı */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardLabel}> Seçili Bay ⤵</Text>
              <Text style={styles.bayId}>
                {bayYukleniyor
                  ? "Yükleniyor..."
                  : seciliBay?.id
                    ? seciliBay.id
                    : "Henüz bağlanmadı"}
              </Text>
              {seciliBay ? (
                <Text style={styles.bayMeta}>
                  Durum: {String(seciliBay.status)} • Aktif:{" "}
                  {String(seciliBay.isActive)}
                </Text>
              ) : null}
            </View>
            <View style={{ alignItems: "flex-end", gap: 6 }}>
              {seciliBay?.isActive && (
                <View style={styles.badgeGreen}>
                  <Text style={styles.badgeText}>AKTİF</Text>
                </View>
              )}
              <Pressable onPress={qrKameraAc} style={styles.qrBtn}>
                <Text style={styles.qrBtnText}>📷 QR Okut</Text>
              </Pressable>
            </View>
          </View>

          {sessionVarMi ? (
            <View style={styles.sessionBox}>
              {sessionYukleniyor ? (
                <ActivityIndicator color={YELLOW} />
              ) : (
                <>
                  <Text style={styles.sessionTur}>Tür: {sessionTurLabel}</Text>
                  {sayacText ? (
                    <Text style={styles.sayac}>⏱ {sayacText}</Text>
                  ) : null}
                  <Pressable
                    onPress={() => sessionBitir("user_stop")}
                    disabled={!sessionRunningMi || sessionBitiriliyor}
                    style={[
                      styles.durdurBtn,
                      (!sessionRunningMi || sessionBitiriliyor) &&
                        styles.btnDisabled,
                    ]}
                  >
                    {sessionBitiriliyor ? (
                      <ActivityIndicator color={WHITE} />
                    ) : (
                      <Text style={styles.durdurBtnText}>⏹ Durdur</Text>
                    )}
                  </Pressable>
                </>
              )}
            </View>
          ) : null}
        </View>

        {/* Bakiye Kartı */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>🪙 Jeton Bakiyesi</Text>
          {bakiyeYukleniyor ? (
            <ActivityIndicator color={YELLOW} style={{ marginTop: 6 }} />
          ) : (
            <Text style={styles.bakiyeNum}>
              {bakiye} <Text style={styles.bakiyeUnit}>Jeton</Text>
            </Text>
          )}
          <Pressable
            onPress={() => setYuklemeAcik(true)}
            style={styles.yellowBtn}
          >
            <Text style={styles.yellowBtnText}>+ Bakiye Yükle</Text>
          </Pressable>
        </View>

        {/* Başlat Butonları */}
        <Text style={styles.sectionTitle}>Oturum Başlat</Text>
        <View style={styles.row}>
          <Pressable
            onPress={() => sessionBaslat("wash")}
            disabled={butonKilitli}
            style={[styles.startBtn, butonKilitli && styles.btnDisabled]}
          >
            <Text style={styles.startBtnIcon}>💧</Text>
            <Text style={styles.startBtnText}>Su</Text>
          </Pressable>
          <Pressable
            onPress={() => sessionBaslat("foam")}
            disabled={butonKilitli}
            style={[styles.startBtn, butonKilitli && styles.btnDisabled]}
          >
            <Text style={styles.startBtnIcon}>🫧</Text>
            <Text style={styles.startBtnText}>Köpük</Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* ── Bakiye Yükle Modal ── */}
      <Modal visible={yuklemeAcik} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>💳 Bakiye Yükle</Text>
            </View>

            <Text style={styles.inputLabel}>Kaç Jeton? (1–100)</Text>
            <TextInput
              value={jetonAdet}
              onChangeText={(t) =>
                setJetonAdet(String(t).replace(/[^0-9]/g, ""))
              }
              keyboardType="number-pad"
              style={styles.input}
              placeholderTextColor={GRAY_TEXT}
              placeholder="Örn: 10"
            />

            <View style={styles.fiyatBox}>
              {fiyatYukleniyor ? (
                <ActivityIndicator color={YELLOW} />
              ) : jetonFiyat ? (
                <>
                  <Text style={styles.fiyatMeta}>
                    Birim: {jetonFiyat} ₺ / jeton
                  </Text>
                  <Text style={styles.fiyatTotal}>Toplam: {toplamText} ₺</Text>
                </>
              ) : (
                <Text style={styles.fiyatErr}>Fiyat bilgisi alınamadı.</Text>
              )}
            </View>

            <Text style={styles.inputLabel}>Kart Numarası</Text>
            <TextInput
              value={kartNo}
              onChangeText={setKartNo}
              placeholder="•••• •••• •••• ••••"
              style={styles.input}
              placeholderTextColor={GRAY_TEXT}
            />

            <View style={styles.row}>
              <TextInput
                value={sonKullanma}
                onChangeText={setSonKullanma}
                placeholder="AA/YY"
                style={[styles.input, { flex: 1, marginRight: 8 }]}
                placeholderTextColor={GRAY_TEXT}
              />
              <TextInput
                value={cvv}
                onChangeText={(t) => setCvv(t.replace(/[^0-9]/g, ""))}
                placeholder="CVV"
                secureTextEntry
                style={[styles.input, { flex: 1 }]}
                placeholderTextColor={GRAY_TEXT}
              />
            </View>

            <Pressable
              onPress={() => bakiyeYukle(adetNum, toplamTRY)}
              disabled={yuklemeIslemde || fiyatYukleniyor || !jetonFiyat}
              style={[
                styles.yellowBtn,
                (yuklemeIslemde || fiyatYukleniyor || !jetonFiyat) &&
                  styles.btnDisabled,
              ]}
            >
              {yuklemeIslemde ? (
                <ActivityIndicator color={DARK} />
              ) : (
                <Text style={styles.yellowBtnText}>Öde ve Yükle</Text>
              )}
            </Pressable>

            <Pressable
              onPress={() => setYuklemeAcik(false)}
              style={styles.vazgecBtn}
            >
              <Text style={styles.vazgecText}>Vazgeç</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── Profil Modal ── */}
      <Modal visible={profilAcik} transparent animationType="slide">
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setProfilAcik(false)}
        >
          <Pressable
            style={styles.modalBox}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>👤 Profil</Text>
            </View>

            {profilYukleniyor ? (
              <ActivityIndicator color={YELLOW} />
            ) : (
              <>
                <Text style={styles.inputLabel}>Ad</Text>
                <TextInput
                  value={ad}
                  onChangeText={setAd}
                  placeholder="Ad"
                  style={styles.input}
                  placeholderTextColor={GRAY_TEXT}
                />
                <Text style={styles.inputLabel}>Soyad</Text>
                <TextInput
                  value={soyad}
                  onChangeText={setSoyad}
                  placeholder="Soyad"
                  style={styles.input}
                  placeholderTextColor={GRAY_TEXT}
                />
                <Text style={styles.inputLabel}>Telefon</Text>
                <TextInput
                  value={telefon}
                  onChangeText={setTelefon}
                  placeholder="5XXXXXXXXX"
                  keyboardType="number-pad"
                  style={styles.input}
                  placeholderTextColor={GRAY_TEXT}
                />

                <Pressable
                  onPress={profilKaydet}
                  disabled={profilKaydediyor}
                  style={[
                    styles.yellowBtn,
                    profilKaydediyor && styles.btnDisabled,
                  ]}
                >
                  {profilKaydediyor ? (
                    <ActivityIndicator color={DARK} />
                  ) : (
                    <Text style={styles.yellowBtnText}>Kaydet</Text>
                  )}
                </Pressable>

                <Pressable
                  onPress={() => setProfilAcik(false)}
                  style={styles.vazgecBtn}
                >
                  <Text style={styles.vazgecText}>Kapat</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: GRAY_BG },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: GRAY_BG,
  },
  scroll: { flex: 1, paddingHorizontal: 12, paddingTop: 10 },

  /* Header */
  header: {
    backgroundColor: DARK,
    paddingTop: 48,
    paddingBottom: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
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
  headerRight: { flexDirection: "row", gap: 6 },
  headerBtn: {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  headerBtnText: { color: WHITE, fontWeight: "600", fontSize: 12 },

  /* QR Button */
  qrBtn: {
    backgroundColor: DARK,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  qrBtnText: { color: WHITE, fontWeight: "700", fontSize: 12 },

  /* Cards */
  card: {
    backgroundColor: WHITE,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  cardLabel: {
    fontSize: 12,
    color: GRAY_TEXT,
    fontWeight: "600",
    marginBottom: 3,
  },
  badgeGreen: {
    backgroundColor: "#d1fae5",
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeText: { color: "#065f46", fontSize: 11, fontWeight: "700" },

  bayId: { fontSize: 16, fontWeight: "800", color: DARK_TEXT, marginTop: 2 },
  bayMeta: { fontSize: 12, color: GRAY_TEXT, marginTop: 3 },

  sessionBox: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: GRAY_BORDER,
    paddingTop: 10,
  },
  sessionTur: { fontSize: 13, color: GRAY_TEXT },
  sayac: { fontSize: 26, fontWeight: "900", color: DARK_TEXT, marginTop: 3 },
  durdurBtn: {
    marginTop: 8,
    backgroundColor: DARK,
    padding: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  durdurBtnText: { color: WHITE, fontWeight: "700", fontSize: 14 },

  bakiyeNum: {
    fontSize: 34,
    fontWeight: "900",
    color: DARK_TEXT,
    marginTop: 4,
  },
  bakiyeUnit: { fontSize: 20, fontWeight: "600", color: GRAY_TEXT },

  /* Buttons */
  yellowBtn: {
    marginTop: 12,
    backgroundColor: YELLOW,
    padding: 13,
    borderRadius: 12,
    alignItems: "center",
  },
  yellowBtnText: { color: DARK, fontWeight: "800", fontSize: 14 },
  btnDisabled: { backgroundColor: "#c4c4c4" },

  /* Start Buttons */
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: DARK_TEXT,
    marginBottom: 8,
    marginTop: 2,
  },
  row: { flexDirection: "row", gap: 10, marginBottom: 10 },
  startBtn: {
    flex: 1,
    backgroundColor: DARK,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    gap: 5,
  },
  startBtnIcon: { fontSize: 24 },
  startBtnText: { color: WHITE, fontWeight: "700", fontSize: 15 },

  /* Modal */
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalBox: {
    backgroundColor: WHITE,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 36,
  },
  modalHeader: {
    borderBottomWidth: 1,
    borderBottomColor: GRAY_BORDER,
    paddingBottom: 10,
    marginBottom: 14,
  },
  modalTitle: { fontSize: 17, fontWeight: "800", color: DARK_TEXT },

  inputLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: GRAY_TEXT,
    marginBottom: 5,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    borderWidth: 1.5,
    borderColor: GRAY_BORDER,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    color: DARK_TEXT,
    backgroundColor: GRAY_BG,
    marginBottom: 10,
  },

  fiyatBox: {
    backgroundColor: "#fffbeb",
    borderWidth: 1,
    borderColor: "#fde68a",
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
  },
  fiyatMeta: { color: GRAY_TEXT, fontSize: 13 },
  fiyatTotal: {
    fontSize: 17,
    fontWeight: "800",
    color: DARK_TEXT,
    marginTop: 3,
  },
  fiyatErr: { color: "#b91c1c", fontWeight: "700" },

  vazgecBtn: { marginTop: 10, alignItems: "center" },
  vazgecText: {
    color: GRAY_TEXT,
    textDecorationLine: "underline",
    fontSize: 14,
  },
});
