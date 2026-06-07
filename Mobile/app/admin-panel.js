import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  FlatList
} from 'react-native';

import { SafeAreaView } from 'react-native-safe-area-context';
import { auth, rtdb } from '../firebase'; 
import { ref, onValue } from 'firebase/database';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

import { getApiUrl } from '../src/config/api';

const THEME = {
  bgMain: '#f8f9fb',
  bgCard: '#ffffff',
  sidebarBg: '#1a1a2e',
  border: '#e5e7eb',
  textMain: '#111827',
  textMuted: '#6b7280',
  accentYellow: '#f5a623',
  accentDark: '#111827',
  success: '#10b981',
  danger: '#ef4444',
  warning: '#f5a623',
  info: '#3b82f6',
};

const STATUS_CYCLE = ["available", "maintenance", "offline"];
const STATUS_LABELS = {
  available: { text: "BOŞ", color: THEME.success },
  busy: { text: "DOLU", color: THEME.warning },
  maintenance: { text: "BAKIM", color: THEME.info },
  offline: { text: "KAPALI", color: THEME.textMuted },
  waiting: { text: "BEKLEMEDE", color: THEME.info },
  starting: { text: "BAŞLIYOR", color: THEME.accentYellow },
};

export default function AdminPanel() {
  const [activeTab, setActiveTab] = useState('monitor');
  const [bays, setBays] = useState([]);
  const [logs, setLogs] = useState([]);
  
  
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [userResult, setUserResult] = useState(null);
  const [tokenAmount, setTokenAmount] = useState('');
  const [isActionLoading, setIsActionLoading] = useState(false);

  useEffect(() => {
    
    if (!auth.currentUser) {
      Alert.alert("Hata", "Oturum bulunamadı. Lütfen giriş yapın.");
      router.replace('/login');
      return;
    }

    const baysRef = ref(rtdb, 'bays');
    const unsubscribe = onValue(baysRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const baysArray = Object.keys(data)
          .map((key) => ({ id: key, ...data[key] }))
          .sort((a, b) => a.id.localeCompare(b.id));
        setBays(baysArray);
      }
    });

    return () => unsubscribe();
  }, []);

  const addLog = (message) => {
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setLogs((prev) => [{ id: Date.now().toString(), time: ts, message }, ...prev].slice(0, 50));
  };

  const adminFetch = async (endpoint, payload) => {
    const token = await auth.currentUser?.getIdToken(true);

    if (!token) {
      throw new Error("Oturum bulunamadı. Lütfen tekrar giriş yapın.");
    }

    
    const url = getApiUrl(`/api/admin${endpoint}`);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      console.log("JSON olmayan cevap:", {
        url,
        status: res.status,
        body: text.slice(0, 300),
      });

      throw new Error(
        `Sunucu JSON olmayan cevap döndürdü. Status: ${res.status}`,
      );
    }

    if (!res.ok) {
      throw new Error(data?.error || "İşlem başarısız.");
    }

    return data;
  };

  
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setUserResult(null);
    try {
      const data = await adminFetch('/search-user', { arama: searchQuery.trim() });
      setUserResult(data.user);
      addLog(`Kullanıcı arandı: ${searchQuery}`);
    } catch (e) {
      Alert.alert("Hata", e.message);
    } finally {
      setIsSearching(false);
    }
  };

  const handleToggleBlock = () => {
    if (!userResult) return;
    const isCurrentlyBlocked = userResult.isBlocked;
    const msg = isCurrentlyBlocked 
      ? "Kullanıcının engelini kaldırmak istediğinize emin misiniz?" 
      : "Kullanıcıyı sistemden engellemek istediğinize emin misiniz?";

    Alert.alert("Onay Bekleniyor", msg, [
      { text: "İptal", style: "cancel" },
      { 
        text: "Onaylıyorum", 
        style: isCurrentlyBlocked ? "default" : "destructive",
        onPress: async () => {
          setIsActionLoading(true);
          try {
            await adminFetch('/update-user', { 
              userId: userResult.id, 
              patch: { isBlocked: !isCurrentlyBlocked } 
            });
            setUserResult({ ...userResult, isBlocked: !isCurrentlyBlocked });
            addLog(`Kullanıcı durumu güncellendi: ${userResult.id}`);
            Alert.alert("Başarılı", "Kullanıcı durumu güncellendi.");
          } catch (e) {
            Alert.alert("Hata", e.message);
          } finally {
            setIsActionLoading(false);
          }
        }
      }
    ]);
  };

  const handleTopup = async () => {
    if (!userResult || !tokenAmount) return;
    const amount = parseInt(tokenAmount, 10);
    if (isNaN(amount) || amount <= 0) {
      Alert.alert("Uyarı", "Lütfen geçerli bir jeton miktarı girin.");
      return;
    }

    Alert.alert("Emin misiniz?", `${amount} adet jeton yüklenecek. Onaylıyor musunuz?`, [
      { text: "İptal", style: "cancel" },
      {
        text: "Yükle",
        onPress: async () => {
          setIsActionLoading(true);
          try {
            const data = await adminFetch('/topup', { userId: userResult.id, tokens: amount });
            setUserResult({ ...userResult, walletTokens: (userResult.walletTokens || 0) + amount });
            setTokenAmount('');
            addLog(`${userResult.id} adlı kullanıcıya ${amount} jeton yüklendi.`);
            Alert.alert("Başarılı", `${data.tokensAdded} jeton (${data.amountTRY} ₺) başarıyla eklendi.`);
          } catch (e) {
            Alert.alert("Hata", e.message);
          } finally {
            setIsActionLoading(false);
          }
        }
      }
    ]);
  };

  
  const handleBayStatusChange = (bay) => {
    const isActive = bay.isActive ?? true;
    if (!isActive) return;

    const idx = STATUS_CYCLE.indexOf(bay.status || 'available');
    const nextStatus = STATUS_CYCLE[idx === -1 ? 0 : (idx + 1) % STATUS_CYCLE.length];

    const doChange = async () => {
      try {
        await adminFetch('/update-bay', { bayId: bay.id, patch: { status: nextStatus } });
        addLog(`Peron güncellendi: ${bay.id} -> ${nextStatus}`);
      } catch(e) { Alert.alert("Hata", e.message); }
    };

    if (bay.status === 'busy' || bay.currentSessionId) {
      Alert.alert("DİKKAT", `${bay.id} peronunda yıkama işlemi var! Yine de durumu değiştirmek istiyor musunuz?`, [
        { text: "İptal", style: "cancel" },
        { text: "Değiştir", style: "destructive", onPress: doChange }
      ]);
    } else {
      doChange();
    }
  };

  const handleBayPowerToggle = (bay) => {
    const isActive = bay.isActive ?? true;
    
    const doToggle = async () => {
      try {
        const patch = isActive ? { isActive: false, status: "offline" } : { isActive: true, status: "available" };
        await adminFetch('/update-bay', { bayId: bay.id, patch });
        addLog(`Peron gücü değişti: ${bay.id} -> ${isActive ? 'KAPALI' : 'AÇIK'}`);
      } catch(e) { Alert.alert("Hata", e.message); }
    };

    if (isActive && (bay.status === 'busy' || bay.currentSessionId)) {
      Alert.alert("DİKKAT", `${bay.id} peronunda yıkama işlemi var! Yine de gücü kapatmak istiyor musunuz?`, [
        { text: "İptal", style: "cancel" },
        { text: "Kapat", style: "destructive", onPress: doToggle }
      ]);
    } else {
      doToggle();
    }
  };

  const handleBulkAction = (action) => {
    const busyCount = bays.filter(b => b.status === 'busy' || b.currentSessionId).length;
    let msg = `Tüm peronlar ${action} yapılacak. Onaylıyor musunuz?`;
    if (busyCount > 0) {
      msg = `DİKKAT: ${busyCount} peronda yıkama var! Tüm peronları ${action} yapmak istediğinize emin misiniz?`;
    }

    Alert.alert("Toplu İşlem Onayı", msg, [
      { text: "İptal", style: "cancel" },
      { 
        text: "Onaylıyorum", 
        style: action === 'KAPAT' ? 'destructive' : 'default',
        onPress: () => executeBulkAction(action)
      }
    ]);
  };

  const executeBulkAction = async (action) => {
    let patch;
    if (action === 'BOŞ') patch = { isActive: true, status: 'available' };
    else if (action === 'BAKIM') patch = { isActive: true, status: 'maintenance' };
    else if (action === 'KAPAT') patch = { isActive: false, status: 'offline' };
    else if (action === 'AKTİF ET') patch = { isActive: true, status: 'available' };
    else return;

    try {
      await Promise.all(bays.map(b => adminFetch('/update-bay', { bayId: b.id, patch })));
      addLog(`Toplu işlem uygulandı: Tüm peronlar -> ${action}`);
      Alert.alert("Başarılı", "Tüm peronlar güncellendi.");
    } catch(_) {
      Alert.alert("Hata", "Bazı peronlar güncellenemedi.");
    }
  };

  const doLogout = () => {
    auth.signOut().then(() => {
      router.replace('/login');
    });
  };

  
  const activeCount = bays.filter(b => b.isActive !== false).length;
  const availableCount = bays.filter(b => (b.status === 'available' || !b.status) && b.isActive !== false).length;
  const busyCount = bays.filter(b => b.status === 'busy' && b.isActive !== false).length;
  const maintCount = bays.filter(b => b.status === 'maintenance').length;
  const offlineCount = bays.filter(b => b.status === 'offline' || b.isActive === false).length;

  return (
    <SafeAreaView style={styles.container}>
      {}
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Ionicons name="shield-checkmark" size={24} color={THEME.accentYellow} />
          <Text style={styles.headerTitle}>QWash Admin</Text>
        </View>
        <TouchableOpacity style={styles.logoutBtn} onPress={doLogout}>
          <Ionicons name="log-out-outline" size={20} color={THEME.danger} />
        </TouchableOpacity>
      </View>

      {}
      <View style={styles.tabContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabScroll}>
          {[
            { id: 'monitor', icon: 'pulse', label: 'Monitör' },
            { id: 'stats', icon: 'bar-chart', label: 'İstatistik' },
            { id: 'users', icon: 'people', label: 'Kullanıcılar' },
            { id: 'bays', icon: 'water', label: 'Peronlar' }
          ].map(tab => (
            <TouchableOpacity 
              key={tab.id} 
              style={[styles.tabBtn, activeTab === tab.id && styles.tabBtnActive]}
              onPress={() => setActiveTab(tab.id)}
            >
              <Ionicons name={tab.icon} size={18} color={activeTab === tab.id ? THEME.bgCard : THEME.textMuted} />
              <Text style={[styles.tabLabel, activeTab === tab.id && styles.tabLabelActive]}>{tab.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {}
      <View style={styles.content}>
        
        {}
        {activeTab === 'monitor' && (
          <View style={styles.tabSection}>
            <Text style={styles.sectionTitle}>Sistem Günlükleri (Son Olaylar)</Text>
            <View style={styles.card}>
               <FlatList
                data={logs}
                keyExtractor={item => item.id}
                ListEmptyComponent={<Text style={{padding: 20, color: THEME.textMuted}}>Henüz log kaydı yok...</Text>}
                renderItem={({item}) => (
                  <View style={styles.logRow}>
                    <Text style={styles.logTime}>{item.time}</Text>
                    <Text style={styles.logMessage}>{item.message}</Text>
                  </View>
                )}
               />
            </View>
          </View>
        )}

        {}
        {activeTab === 'stats' && (
          <ScrollView style={styles.tabSection}>
            <Text style={styles.sectionTitle}>Anlık Durum</Text>
            <View style={styles.statsGrid}>
              <View style={styles.statCard}><Text style={styles.statNum}>{bays.length}</Text><Text style={styles.statDesc}>Toplam Peron</Text></View>
              <View style={styles.statCard}><Text style={[styles.statNum, {color: THEME.success}]}>{activeCount}</Text><Text style={styles.statDesc}>Aktif</Text></View>
              <View style={styles.statCard}><Text style={[styles.statNum, {color: THEME.success}]}>{availableCount}</Text><Text style={styles.statDesc}>Boş</Text></View>
              <View style={styles.statCard}><Text style={[styles.statNum, {color: THEME.warning}]}>{busyCount}</Text><Text style={styles.statDesc}>Çalışan</Text></View>
              <View style={styles.statCard}><Text style={[styles.statNum, {color: THEME.info}]}>{maintCount}</Text><Text style={styles.statDesc}>Bakımda</Text></View>
              <View style={styles.statCard}><Text style={[styles.statNum, {color: THEME.danger}]}>{offlineCount}</Text><Text style={styles.statDesc}>Kapalı</Text></View>
            </View>
          </ScrollView>
        )}

        {}
        {activeTab === 'users' && (
          <ScrollView style={styles.tabSection} keyboardShouldPersistTaps="handled">
            <Text style={styles.sectionTitle}>Kullanıcı Yönetimi</Text>
            <View style={styles.card}>
              <View style={styles.searchRow}>
                <TextInput 
                  style={styles.searchInput}
                  placeholder="E-Posta, Telefon veya UID..."
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoCapitalize="none"
                  returnKeyType="search"
                  onSubmitEditing={handleSearch}
                />
                <TouchableOpacity style={styles.searchBtn} onPress={handleSearch} disabled={isSearching}>
                  {isSearching ? <ActivityIndicator color="#fff" /> : <Ionicons name="search" size={20} color="#fff" />}
                </TouchableOpacity>
              </View>

              {userResult && (
                <View style={styles.userResultCard}>
                  <View style={styles.userResultHeader}>
                    <View style={styles.userAvatar}><Text style={styles.userAvatarText}>{userResult.ad ? userResult.ad[0] : 'U'}</Text></View>
                    <View style={{flex: 1}}>
                      <Text style={styles.userName}>{(userResult.ad || '') + ' ' + (userResult.soyad || '')}</Text>
                      <Text style={styles.userEmail}>{userResult.email}</Text>
                      {userResult.isBlocked && <Text style={styles.blockedBadge}>SİSTEMDEN ENGELLİ</Text>}
                    </View>
                    <View style={{alignItems: 'flex-end'}}>
                      <Text style={styles.tokenNum}>{userResult.walletTokens || 0}</Text>
                      <Text style={styles.tokenLabel}>JETON</Text>
                    </View>
                  </View>

                  <View style={styles.topupRow}>
                    <TextInput 
                      style={[styles.searchInput, {flex: 1, marginBottom: 0}]}
                      placeholder="Miktar (Örn: 5)"
                      keyboardType="number-pad"
                      value={tokenAmount}
                      onChangeText={setTokenAmount}
                    />
                    <TouchableOpacity style={styles.topupBtn} onPress={handleTopup} disabled={isActionLoading}>
                      <Text style={styles.topupBtnText}>Jeton Ekle</Text>
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity 
                    style={[styles.blockBtn, userResult.isBlocked ? {backgroundColor: THEME.success} : {}]} 
                    onPress={handleToggleBlock}
                    disabled={isActionLoading}
                  >
                    <Text style={styles.blockBtnText}>
                      {userResult.isBlocked ? "Engeli Kaldır" : "Kullanıcıyı Engelle"}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </ScrollView>
        )}

        {}
        {activeTab === 'bays' && (
          <View style={styles.tabSection}>
            <View style={styles.bulkRow}>
              <TouchableOpacity style={[styles.bulkBtn, {backgroundColor: THEME.success}]} onPress={() => handleBulkAction('BOŞ')}>
                <Text style={styles.bulkBtnText}>Tümünü Boşalt</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.bulkBtn, {backgroundColor: THEME.info}]} onPress={() => handleBulkAction('BAKIM')}>
                <Text style={styles.bulkBtnText}>Tümünü Bakıma Al</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.bulkBtn, {backgroundColor: THEME.danger}]} onPress={() => handleBulkAction('KAPAT')}>
                <Text style={styles.bulkBtnText}>Tümünü Kapat</Text>
              </TouchableOpacity>
            </View>

            <FlatList
              data={bays}
              keyExtractor={item => item.id}
              contentContainerStyle={{paddingBottom: 20}}
              renderItem={({item}) => {
                const s = STATUS_LABELS[item.status || 'available'] || STATUS_LABELS.offline;
                const isActive = item.isActive ?? true;
                
                return (
                  <View style={[styles.bayCard, !isActive && {opacity: 0.6}]}>
                    <View style={styles.bayHeader}>
                      <Text style={styles.bayName}>{item.id}</Text>
                      <View style={[styles.bayBadge, {backgroundColor: s.color + '20'}]}>
                        <Text style={[styles.bayBadgeText, {color: s.color}]}>{isActive ? s.text : 'KAPALI'}</Text>
                      </View>
                    </View>
                    
                    <Text style={styles.bayMeta}>
                      Sistem: <Text style={{fontWeight: '700', color: THEME.textMain}}>{item.currentSessionId ? "Aktif Yıkama Var" : "Boşta"}</Text>
                    </Text>

                    <View style={styles.bayActions}>
                      <TouchableOpacity 
                        style={[styles.bayActionBtn, {backgroundColor: THEME.bgMain}]} 
                        onPress={() => handleBayStatusChange(item)}
                        disabled={!isActive}
                      >
                        <Text style={styles.bayActionBtnText}>Durum Değiştir</Text>
                      </TouchableOpacity>
                      <TouchableOpacity 
                        style={[styles.bayActionBtn, {backgroundColor: isActive ? THEME.danger + '20' : THEME.success + '20'}]}
                        onPress={() => handleBayPowerToggle(item)}
                      >
                        <Text style={[styles.bayActionBtnText, {color: isActive ? THEME.danger : THEME.success}]}>
                          {isActive ? "Gücü Kapat" : "Gücü Aç"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              }}
            />
          </View>
        )}

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.bgMain,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: THEME.bgCard,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: THEME.border,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: THEME.textMain,
  },
  logoutBtn: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: THEME.danger + '15',
  },
  tabContainer: {
    backgroundColor: THEME.bgCard,
    borderBottomWidth: 1,
    borderColor: THEME.border,
  },
  tabScroll: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  tabBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 99,
    backgroundColor: THEME.bgMain,
  },
  tabBtnActive: {
    backgroundColor: THEME.accentDark,
  },
  tabLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: THEME.textMuted,
  },
  tabLabelActive: {
    color: THEME.bgCard,
  },
  content: {
    flex: 1,
    padding: 16,
  },
  tabSection: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: THEME.textMuted,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  card: {
    backgroundColor: THEME.bgCard,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 16,
    flex: 1,
  },
  logRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: THEME.bgMain,
  },
  logTime: {
    fontSize: 12,
    fontWeight: '600',
    color: THEME.textMuted,
    width: 50,
  },
  logMessage: {
    fontSize: 13,
    fontWeight: '500',
    color: THEME.textMain,
    flex: 1,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    width: '47%',
    backgroundColor: THEME.bgCard,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  statNum: {
    fontSize: 32,
    fontWeight: '900',
    color: THEME.textMain,
  },
  statDesc: {
    fontSize: 12,
    fontWeight: '700',
    color: THEME.textMuted,
    marginTop: 4,
  },
  searchRow: {
    flexDirection: 'row',
    gap: 12,
  },
  searchInput: {
    flex: 1,
    backgroundColor: THEME.bgMain,
    borderWidth: 1.5,
    borderColor: THEME.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    height: 50,
    fontSize: 15,
    fontWeight: '500',
    color: THEME.textMain,
  },
  searchBtn: {
    backgroundColor: THEME.accentDark,
    borderRadius: 12,
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userResultCard: {
    marginTop: 20,
    borderTopWidth: 1,
    borderColor: THEME.border,
    paddingTop: 20,
  },
  userResultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 20,
  },
  userAvatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: THEME.accentYellow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userAvatarText: {
    fontSize: 20,
    fontWeight: '900',
    color: THEME.sidebarBg,
  },
  userName: {
    fontSize: 18,
    fontWeight: '800',
    color: THEME.textMain,
  },
  userEmail: {
    fontSize: 13,
    color: THEME.textMuted,
    fontWeight: '500',
  },
  blockedBadge: {
    fontSize: 10,
    fontWeight: '800',
    color: '#fff',
    backgroundColor: THEME.danger,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  tokenNum: {
    fontSize: 28,
    fontWeight: '900',
    color: THEME.textMain,
  },
  tokenLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: THEME.textMuted,
  },
  topupRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  topupBtn: {
    backgroundColor: THEME.accentYellow,
    borderRadius: 12,
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  topupBtnText: {
    fontWeight: '800',
    color: THEME.accentDark,
    fontSize: 14,
  },
  blockBtn: {
    backgroundColor: THEME.danger,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  blockBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },
  bulkRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  bulkBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  bulkBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
  },
  bayCard: {
    backgroundColor: THEME.bgCard,
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  bayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  bayName: {
    fontSize: 18,
    fontWeight: '800',
    color: THEME.textMain,
  },
  bayBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  bayBadgeText: {
    fontSize: 11,
    fontWeight: '800',
  },
  bayMeta: {
    fontSize: 13,
    color: THEME.textMuted,
    marginBottom: 16,
  },
  bayActions: {
    flexDirection: 'row',
    gap: 8,
  },
  bayActionBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  bayActionBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: THEME.textMain,
  }
});