import { initializeApp } from "firebase/app";
// 1. getAuth yerine initializeAuth ve getReactNativePersistence içe aktarılır
import { getReactNativePersistence, initializeAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getFirestore } from "firebase/firestore";
// 2. AsyncStorage içe aktarılır
import AsyncStorage from "@react-native-async-storage/async-storage";

// Firebase config
// Firebase config (Artık şifreler .env dosyasından geliyor)
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL,
};

// Firebase başlat
const app = initializeApp(firebaseConfig);

// Servisleri export et
// 3. auth objesi AsyncStorage kullanılarak kalıcı (persist) olacak şekilde başlatılır
export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

export const db = getFirestore(app);
export const rtdb = getDatabase(app);
