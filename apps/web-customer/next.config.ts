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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: publicEnv,
};

export default nextConfig;
