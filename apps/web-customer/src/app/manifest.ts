import type { MetadataRoute } from 'next';

// PWA manifest'i (ADR-0008). Ikonlar assets/ altindaki marka dosyalarindan uretilir.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'QWash Self-Servis Oto Yıkama',
    short_name: 'QWash',
    description: 'QR okut, bakiye yükle, yıkamaya başla.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#fa9a09',
    lang: 'tr',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
