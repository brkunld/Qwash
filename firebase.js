import { initializeApp } from "firebase/app";
// 1. getAuth yerine initializeAuth ve getReactNativePersistence içe aktarılır
import { getReactNativePersistence, initializeAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getFirestore } from "firebase/firestore";
// 2. AsyncStorage içe aktarılır
import AsyncStorage from "@react-native-async-storage/async-storage";

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyDXXgyY_NW6_D1Ecr0ZQljYUvQSTypgJaU",
  authDomain: "ut-project-1c283.firebaseapp.com",
  projectId: "ut-project-1c283",
  storageBucket: "ut-project-1c283.appspot.com",
  messagingSenderId: "269291398032",
  appId: "1:269291398032:web:b37697ae1350efe9938915",
  databaseURL:
    "https://ut-project-1c283-default-rtdb.europe-west1.firebasedatabase.app/",
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
