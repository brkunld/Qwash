import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyDXXgyY_NW6_D1Ecr0ZQljYUvQSTypgJaU",
  authDomain: "ut-project-1c283.firebaseapp.com",
  projectId: "ut-project-1c283",
  storageBucket: "ut-project-1c283.appspot.com",
  messagingSenderId: "269291398032",
  appId: "1:269291398032:web:b37697ae1350efe9938915",
};

// Firebase başlat
const app = initializeApp(firebaseConfig);

// Servisleri export et
export const auth = getAuth(app);
export const db = getFirestore(app);
