import type { Metadata } from 'next';
import { AuthBootstrap } from '@/components/auth-bootstrap';
import './globals.css';

export const metadata: Metadata = {
  title: 'QWASH Admin',
  description: 'Istasyon operasyon paneli',
  // Operator paneli: arama motorlarina ve onbellege kapali.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body className="min-h-dvh bg-slate-100 text-slate-900 antialiased">
        <AuthBootstrap />
        {children}
      </body>
    </html>
  );
}
