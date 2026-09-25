import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QWASH Admin',
  description: 'Istasyon operasyon paneli',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body className="min-h-dvh bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
