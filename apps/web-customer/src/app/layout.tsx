import type { Metadata, Viewport } from 'next';
import { AuthBootstrap } from '@/components/auth-bootstrap';
import './globals.css';

export const metadata: Metadata = {
  title: 'QWASH',
  description: 'Self-servis oto yıkama',
  applicationName: 'QWASH',
  appleWebApp: { capable: true, title: 'QWASH', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0284c7',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body className="min-h-dvh bg-slate-50 text-slate-900 antialiased">
        <AuthBootstrap />
        {children}
      </body>
    </html>
  );
}
