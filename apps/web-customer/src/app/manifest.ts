import type { MetadataRoute } from 'next';

// PWA manifest'i (ADR-0008). Ikonlar Faz 5'te marka calismasiyla eklenecek.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'QWASH Self-Servis Oto Yikama',
    short_name: 'QWASH',
    description: 'QR okut, bakiye yukle, yikamaya basla.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#0284c7',
    lang: 'tr',
  };
}
