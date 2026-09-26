import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';
import { resolve } from 'node:path';

// Monorepo: ortam degiskenleri tek kok .env dosyasindadir (NEXT_PUBLIC_* burada okunur).
loadEnvConfig(resolve(import.meta.dirname, '../..'));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
