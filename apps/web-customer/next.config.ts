import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';
import { resolve } from 'node:path';

// Monorepo: ortam degiskenleri tek kok .env dosyasindadir. Next yalniz uygulama dizinindeki
// .env dosyalarini kendiliginden okur; kok dosyayi burada yukleriz.
// forceReload: Next kendi dizinini zaten yukledi; onbellekteki sonucu yok saymak gerekir.
loadEnvConfig(
  resolve(import.meta.dirname, '../..'),
  process.env.NODE_ENV !== 'production',
  console,
  true,
);

// Next, NEXT_PUBLIC_* degerlerini config okunmadan once toplar; kok .env'den geleni
// derlemeye gommek icin `env` ile acikca veririz. Yalniz GIZLI OLMAYAN degerler buraya yazilir.
const publicEnv: Record<string, string> = {};
for (const key of ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_GOOGLE_CLIENT_ID']) {
  const value = process.env[key];
  if (value) publicEnv[key] = value;
}

// Telefondan ayni agdan deneme (Orn: http://192.168.1.7:3000): Next gelistirme sunucusu baska
// adresten gelen istekleri varsayilan olarak engeller. Yalniz gelistirmede; kok .env DEV_LAN_HOSTS.
const devLanHosts = (process.env.DEV_LAN_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: publicEnv,
  ...(devLanHosts.length > 0 ? { allowedDevOrigins: devLanHosts } : {}),
};

export default nextConfig;
