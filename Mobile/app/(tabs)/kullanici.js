/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import Svg, { Path, Circle } from "react-native-svg";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Easing,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useKullaniciIslemleri } from "../../src/kullaniciIslemleri";

const BubbleIconOutlined = ({ size = 24, color = "#ffffff", style }) => {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      style={style}
    >
      <Circle
        cx={139}
        cy={374}
        r={128}
        fill="none"
        stroke={color}
        strokeWidth={21}
      />
      <Path
        d="M224 385 A86 86 0 0 1 139 459"
        fill="none"
        stroke={color}
        strokeWidth={21}
        strokeLinecap="round"
      />
      <Circle
        cx={416}
        cy={267}
        r={85}
        fill="none"
        stroke={color}
        strokeWidth={21}
      />
      <Path
        d="M416 214 A53 53 0 0 1 469 267"
        fill="none"
        stroke={color}
        strokeWidth={21}
        strokeLinecap="round"
      />
      <Circle
        cx={256}
        cy={75}
        r={64}
        fill="none"
        stroke={color}
        strokeWidth={21}
      />
      <Path
        d="M256 43 A32 32 0 0 0 224 75"
        fill="none"
        stroke={color}
        strokeWidth={21}
        strokeLinecap="round"
      />
      <Circle
        cx={85}
        cy={139}
        r={43}
        fill="none"
        stroke={color}
        strokeWidth={21}
      />
    </Svg>
  );
};

const DARK = "#1a1a2e";
const YELLOW = "#f5a623";
const WHITE = "#ffffff";
const GRAY_BG = "#f2f4f7";
const GRAY_BORDER = "#e2e6ea";
const GRAY_TEXT = "#6b7280";
const DARK_TEXT = "#111827";

const FOAM_STOP_MS = 700;
const WATER_STOP_MS = 1000;

function createFoamBubbles() {
  return Array.from({ length: 18 }).map((_, index) => ({
    id: `foam-${index}`,
    left: 5 + ((index * 17) % 88),
    top: 34 + ((index * 23) % 58),
    size: 12 + ((index * 7) % 24),
    delay: (index * 170) % 1500,
    duration: 2600 + ((index * 310) % 1600),
    drift: index % 2 === 0 ? 12 : -10,
    opacity: 1 + (index % 4) * 0.04,
  }));
}

function createWaterDrops() {
  return Array.from({ length: 22 }).map((_, index) => ({
    id: `water-${index}`,
    left: 4 + ((index * 13) % 92),
    height: 18 + ((index * 5) % 24),
    delay: (index * 110) % 1200,
    duration: 850 + ((index * 130) % 850),
    opacity: 0.22 + (index % 5) * 0.035,
  }));
}

const BayBackgroundEffect = ({ type, active, stopping }) => {
  if (!type || (!active && !stopping)) return null;

  return (
    <View pointerEvents="none" style={styles.effectLayer}>
      {type === "foam" ? (
        <FoamEffect stopping={stopping} />
      ) : (
        <WaterEffect stopping={stopping} />
      )}
    </View>
  );
};

const FoamEffect = ({ stopping }) => {
  const bubbles = useMemo(() => createFoamBubbles(), []);
  return (
    <View style={StyleSheet.absoluteFillObject}>
      {bubbles.map((bubble) => (
        <FoamBubble key={bubble.id} bubble={bubble} stopping={stopping} />
      ))}
    </View>
  );
};

const FoamBubble = ({ bubble, stopping }) => {
  const loop = useRef(new Animated.Value(0)).current;
  const stop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(bubble.delay),
        Animated.timing(loop, {
          toValue: 1,
          duration: bubble.duration,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(loop, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [bubble.delay, bubble.duration, loop]);

  useEffect(() => {
    Animated.timing(stop, {
      toValue: stopping ? 1 : 0,
      duration: stopping ? FOAM_STOP_MS : 120,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [stopping, stop]);

  const translateY = loop.interpolate({
    inputRange: [0, 1],
    outputRange: [25, -105],
  });
  const translateX = loop.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, bubble.drift, 0],
  });
  const pulseScale = loop.interpolate({
    inputRange: [0, 0.45, 1],
    outputRange: [0.75, 1.15, 0.85],
  });
  const popScale = stop.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.8],
  });
  const loopOpacity = loop.interpolate({
    inputRange: [0, 0.2, 0.8, 1],
    outputRange: [0, bubble.opacity, bubble.opacity, 0],
  });
  const stopOpacity = stop.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
  });

  return (
    <Animated.View
      style={[
        styles.foamBubble,
        {
          left: `${bubble.left}%`,
          top: `${bubble.top}%`,
          width: bubble.size,
          height: bubble.size,
          borderRadius: bubble.size / 2,
          opacity: Animated.multiply(loopOpacity, stopOpacity),
          transform: [
            { translateY },
            { translateX },
            { scale: Animated.multiply(pulseScale, popScale) },
          ],
        },
      ]}
    />
  );
};

const WaterEffect = ({ stopping }) => {
  const drops = useMemo(() => createWaterDrops(), []);
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(fade, {
      toValue: stopping ? 0 : 1,
      duration: stopping ? WATER_STOP_MS : 120,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [stopping, fade]);

  return (
    <Animated.View style={[StyleSheet.absoluteFillObject, { opacity: fade }]}>
      {drops.map((drop) => (
        <WaterDrop key={drop.id} drop={drop} />
      ))}
    </Animated.View>
  );
};

const WaterDrop = ({ drop }) => {
  const fall = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(drop.delay),
        Animated.timing(fall, {
          toValue: 1,
          duration: drop.duration,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(fall, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [drop.delay, drop.duration, fall]);

  const translateY = fall.interpolate({
    inputRange: [0, 1],
    outputRange: [-55, 220],
  });
  const opacity = fall.interpolate({
    inputRange: [0, 0.15, 0.85, 1],
    outputRange: [0, drop.opacity, drop.opacity, 0],
  });

  return (
    <Animated.View
      style={[
        styles.waterDrop,
        {
          left: `${drop.left}%`,
          height: drop.height,
          opacity,
          transform: [{ translateY }],
        },
      ]}
    />
  );
};

const PeronSayaci = ({ session, bayId, sessionBitir, onTimeoutStart }) => {
  const [kalan, setKalan] = useState(null);
  const bitirildiRef = useRef(false);

  useEffect(() => {
    if (!session || session.status !== "running") {
      setKalan(null);
      bitirildiRef.current = false;
      return;
    }

    const startedMs = session.startedAt?.toMillis
      ? session.startedAt.toMillis()
      : session.startedAt?.seconds
        ? session.startedAt.seconds * 1000
        : Date.now();

    const durSec = Number(session.durationSec ?? 0);
    if (durSec <= 0) return;

    const tick = () => {
      const now = Date.now();
      const biterMs = startedMs + durSec * 1000;
      const k = Math.ceil((biterMs - now) / 1000);

      if (k <= 0) {
        setKalan(0);

        if (!bitirildiRef.current) {
          bitirildiRef.current = true;
          onTimeoutStart?.(bayId, session.type);
          sessionBitir(bayId, session.id, "timeout").catch(() => {});
        }
      } else {
        setKalan(k);
      }
    };

    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [session, bayId, sessionBitir, onTimeoutStart]);

  if (kalan === null) return null;

  const dk = Math.floor(kalan / 60);
  const sn = String(kalan % 60).padStart(2, "0");

  return (
    <Text style={styles.sayac}>
      {dk}:{sn}
    </Text>
  );
};

export default function KullaniciEkrani() {
  const router = useRouter();

  const [stoppingEffects, setStoppingEffects] = useState({});
  const [lastEffectTypeByBay, setLastEffectTypeByBay] = useState({});
  const effectTimersRef = useRef({});
  // ----------------------------------------

  const {
    authYukleniyor,
    uid,
    aktifBayIdListesi,
    baylarData,
    sessionsData,
    islemdekiBaylar,
    bakiye,
    bakiyeYukleniyor,
    bakiyeYukle,
    jetonAdet,
    setJetonAdet,
    jetonFiyat,
    fiyatYukleniyor,
    yuklemeIslemde,
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
    sessionBaslat,
    sessionBitir,
    perondanCik,
    profilKaydet,
    cikisYap,
  } = useKullaniciIslemleri();

  useEffect(() => {
    if (!authYukleniyor && !uid) {
      router.replace("/login");
    }
  }, [authYukleniyor, uid]);

  useEffect(() => {
    return () => {
      Object.values(effectTimersRef.current).forEach(clearTimeout);
    };
  }, []);

  const effectTypeFromSession = (session) => {
    if (session?.type === "wash") return "wash";
    if (session?.type === "foam") return "foam";
    return null;
  };

  const saveLastEffectType = (bayId, type) => {
    if (!type) return;
    setLastEffectTypeByBay((prev) => ({
      ...prev,
      [bayId]: type,
    }));
  };

  const startStoppingEffect = (bayId, type) => {
    const effectType = type || lastEffectTypeByBay[bayId];
    if (!effectType) return;

    if (effectTimersRef.current[bayId]) {
      clearTimeout(effectTimersRef.current[bayId]);
    }

    setLastEffectTypeByBay((prev) => ({
      ...prev,
      [bayId]: effectType,
    }));

    setStoppingEffects((prev) => ({
      ...prev,
      [bayId]: true,
    }));

    const clearAfter = effectType === "foam" ? FOAM_STOP_MS : WATER_STOP_MS;

    effectTimersRef.current[bayId] = setTimeout(() => {
      setStoppingEffects((prev) => {
        const next = { ...prev };
        delete next[bayId];
        return next;
      });

      setLastEffectTypeByBay((prev) => {
        const next = { ...prev };
        delete next[bayId];
        return next;
      });

      delete effectTimersRef.current[bayId];
    }, clearAfter);
  };

  const handleStartSession = (bayId, type) => {
    saveLastEffectType(bayId, type);
    sessionBaslat(bayId, type);
  };

  const handleStopSession = (bayId, session) => {
    const effectType =
      effectTypeFromSession(session) || lastEffectTypeByBay[bayId];
    startStoppingEffect(bayId, effectType);
    sessionBitir(bayId, session?.id, "user_stop");
  };

  const handleTimeoutStart = (bayId, sessionType) => {
    const effectType =
      sessionType === "wash" || sessionType === "foam" ? sessionType : null;
    startStoppingEffect(bayId, effectType);
  };

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
            <Ionicons name="person-outline" size={16} color={WHITE} />
          </Pressable>

          <Pressable onPress={cikisYap} style={styles.headerBtn}>
            <Ionicons name="log-out-outline" size={16} color={WHITE} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
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

        {/* Bay Listesi */}
        {aktifBayIdListesi.length === 0 ? (
          <Text
            style={{ textAlign: "center", color: GRAY_TEXT, marginTop: 20 }}
          >
            Henüz bağlanmış bir peron yok. Cihazınızı NFC etiketine okutunuz.
          </Text>
        ) : (
          aktifBayIdListesi.map((bayId) => {
            const bay = baylarData[bayId];
            const session = sessionsData[bayId];
            const islemde = islemdekiBaylar[bayId];

            const sessionVarMi =
              !!bay?.currentSessionId || session?.status === "running";

            const activeEffectType = sessionVarMi
              ? effectTypeFromSession(session)
              : null;

            const stopping = !!stoppingEffects[bayId];
            const effectType = activeEffectType || lastEffectTypeByBay[bayId];
            const renderEffect =
              !!effectType && (!!activeEffectType || stopping);

            return (
              <View key={bayId} style={styles.card}>
                {renderEffect && (
                  <BayBackgroundEffect
                    type={effectType}
                    active={!!activeEffectType}
                    stopping={stopping}
                  />
                )}

                <View style={styles.cardContent}>
                  <View style={styles.cardHeaderRow}>
                    <View
                      style={{ flexDirection: "row", alignItems: "center" }}
                    >
                      <View style={styles.bayBadge}>
                        <Text style={styles.bayIdText}>
                          {bayId.split("_").pop()}
                        </Text>
                      </View>

                      {/* Aktif modun ikonu */}
                      {sessionVarMi && session?.type === "wash" && (
                        <Ionicons
                          name="water-outline"
                          size={16}
                          color="#378ADD"
                          style={{ marginLeft: 8 }}
                        />
                      )}

                      {sessionVarMi && session?.type === "foam" && (
                        <BubbleIconOutlined
                          size={16}
                          color="#10b981"
                          style={{ marginLeft: 8 }}
                        />
                      )}
                    </View>

                    {/* Ayrıl */}
                    <Pressable
                      onPress={() => perondanCik(bayId)}
                      disabled={sessionVarMi}
                      style={[
                        styles.leaveBtn,
                        {
                          backgroundColor: sessionVarMi ? "#a3a3a3" : "#FF3B30",
                        },
                      ]}
                    >
                      <Ionicons name="exit-outline" size={18} color={WHITE} />
                    </Pressable>
                  </View>

                  {sessionVarMi ? (
                    <View style={styles.sessionBox}>
                      {islemde ? (
                        <ActivityIndicator color={YELLOW} />
                      ) : (
                        <>
                          <PeronSayaci
                            session={session}
                            bayId={bayId}
                            sessionBitir={sessionBitir}
                            onTimeoutStart={handleTimeoutStart}
                          />

                          {session?.durationSec > 0 && (
                            <ProgressBar session={session} />
                          )}

                          <Pressable
                            onPress={() => handleStopSession(bayId, session)}
                            disabled={islemde}
                            style={[
                              styles.durdurBtn,
                              islemde && styles.btnDisabled,
                            ]}
                          >
                            <Ionicons
                              name="stop-circle-outline"
                              size={20}
                              color={WHITE}
                            />
                          </Pressable>
                        </>
                      )}
                    </View>
                  ) : (
                    <View style={styles.startSection}>
                      <View style={styles.row}>
                        {/* Su */}
                        <Pressable
                          onPress={() => handleStartSession(bayId, "wash")}
                          disabled={islemde || bakiyeYukleniyor}
                          style={[
                            styles.startBtn,
                            (islemde || bakiyeYukleniyor) && styles.btnDisabled,
                          ]}
                        >
                          <Ionicons
                            name="water-outline"
                            size={28}
                            color={WHITE}
                          />
                          <Text style={styles.startBtnText}>Su</Text>
                        </Pressable>

                        {/* Köpük */}
                        <Pressable
                          onPress={() => handleStartSession(bayId, "foam")}
                          disabled={islemde || bakiyeYukleniyor}
                          style={[
                            styles.startBtn,
                            (islemde || bakiyeYukleniyor) && styles.btnDisabled,
                          ]}
                        >
                          <BubbleIconOutlined size={28} color={WHITE} />
                          <Text style={styles.startBtnText}>Köpük</Text>
                        </Pressable>
                      </View>
                    </View>
                  )}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

{/* Bakiye Yükle Modal */}
      <Modal visible={yuklemeAcik} transparent animationType="slide">
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <View style={[styles.modalBox, { maxHeight: "50%" }]}>
            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>💳 Güvenli Bakiye Yükle</Text>
              </View>

              <Text style={styles.inputLabel}>Kaç Jeton Satın Alacaksınız? (1–100)</Text>
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
                      Birim Jeton Fiyatı: {jetonFiyat} ₺
                    </Text>
                    <Text style={styles.fiyatTotal}>
                      Ödenecek Toplam: {toplamText} ₺
                    </Text>
                  </>
                ) : (
                  <Text style={styles.fiyatErr}>Fiyat bilgisi alınamadı.</Text>
                )}
              </View>

              <Pressable
                onPress={() => bakiyeYukle(adetNum, toplamTRY)}
                disabled={yuklemeIslemde || fiyatYukleniyor || !jetonFiyat || !adetNum}
                style={[
                  styles.yellowBtn,
                  (yuklemeIslemde || fiyatYukleniyor || !jetonFiyat || !adetNum) &&
                    styles.btnDisabled,
                ]}
              >
                {yuklemeIslemde ? (
                  <ActivityIndicator color={DARK} />
                ) : (
                  <Text style={styles.yellowBtnText}>Güvenli Ödeme Ekranına Git</Text>
                )}
              </Pressable>

              <Pressable
                onPress={() => setYuklemeAcik(false)}
                style={styles.vazgecBtn}
              >
                <Text style={styles.vazgecText}>Vazgeç</Text>
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Profil Modal */}
      <Modal visible={profilAcik} transparent animationType="slide">
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <Pressable
            style={{ flex: 1, justifyContent: "flex-end" }}
            onPress={() => setProfilAcik(false)}
          >
            <Pressable
              style={[styles.modalBox, { maxHeight: "85%" }]}
              onPress={(e) => e.stopPropagation()}
            >
              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
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
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function ProgressBar({ session }) {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    const startedMs = session.startedAt?.toMillis
      ? session.startedAt.toMillis()
      : session.startedAt?.seconds
        ? session.startedAt.seconds * 1000
        : Date.now();

    const durMs = Number(session.durationSec ?? 0) * 1000;

    if (durMs <= 0) {
      setPct(0);
      return;
    }

    const tick = () => {
      const elapsed = Date.now() - startedMs;
      setPct(Math.min((elapsed / durMs) * 100, 100));
    };

    tick();

    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [session]);

  return (
    <View style={styles.progressBg}>
      <View style={[styles.progressFill, { width: `${pct}%` }]} />
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
    paddingVertical: 8,
  },
  bayBadge: {
    backgroundColor: YELLOW,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 6,
  },
  bayIdText: { fontSize: 15, fontWeight: "900", color: "#000000" },
  leaveBtn: {
    borderRadius: 10,
    padding: 9,
    alignItems: "center",
    justifyContent: "center",
  },
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
    overflow: "hidden",
  },
  cardContent: { position: "relative", zIndex: 2 },
  effectLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
    overflow: "hidden",
  },
  foamBubble: {
    position: "absolute",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.9)",
    backgroundColor: "rgba(167,243,208,0.35)",
  },
  waterDrop: {
    position: "absolute",
    top: -55,
    width: 2.5,
    borderRadius: 99,
    backgroundColor: "rgba(96,165,250,0.7)",
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
  sessionBox: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: GRAY_BORDER,
    paddingTop: 10,
  },
  sayac: {
    fontSize: 30,
    fontWeight: "900",
    color: DARK_TEXT,
    marginTop: 3,
    fontVariant: ["tabular-nums"],
    letterSpacing: 1,
  },
  progressBg: {
    height: 4,
    backgroundColor: GRAY_BORDER,
    borderRadius: 2,
    overflow: "hidden",
    marginTop: 8,
    marginBottom: 10,
  },
  progressFill: { height: "100%", backgroundColor: YELLOW, borderRadius: 2 },
  durdurBtn: {
    backgroundColor: DARK,
    padding: 13,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  bakiyeNum: {
    fontSize: 34,
    fontWeight: "900",
    color: DARK_TEXT,
    marginTop: 4,
  },
  bakiyeUnit: { fontSize: 20, fontWeight: "600", color: GRAY_TEXT },
  yellowBtn: {
    marginTop: 12,
    backgroundColor: YELLOW,
    padding: 13,
    borderRadius: 12,
    alignItems: "center",
  },
  yellowBtnText: { color: DARK, fontWeight: "800", fontSize: 14 },
  btnDisabled: { backgroundColor: "#c4c4c4" },
  startSection: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: GRAY_BORDER,
    paddingTop: 10,
  },
  row: { flexDirection: "row", gap: 10, marginBottom: 10 },
  startBtn: {
    flex: 1,
    backgroundColor: DARK,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    gap: 6,
  },
  startBtnText: { color: WHITE, fontWeight: "700", fontSize: 14 },
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
