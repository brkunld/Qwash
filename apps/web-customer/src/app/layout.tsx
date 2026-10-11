import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { AuthBootstrap } from '@/components/auth-bootstrap';
import './globals.css';

export const metadata: Metadata = {
  title: 'QWash',
  description: 'Self-servis oto yıkama',
  applicationName: 'QWash',
  appleWebApp: { capable: true, title: 'QWash', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Alt sekme cubugu iPhone'da ana ekran cubugunun ustunde kalsin (safe-area).
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f5f7' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1114' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh bg-canvas font-sans text-ink antialiased">
        <AuthBootstrap />
        {children}
      </body>
    </html>
  );
}
