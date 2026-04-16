import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
// 1. Database modülünü içe aktarın
import { getDatabase } from "firebase/database";

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
export const auth = getAuth(app);
export const db = getFirestore(app);
// 2. rtdb örneğini oluşturun ve export edin
export const rtdb = getDatabase(app);
