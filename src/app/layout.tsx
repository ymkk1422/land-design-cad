import type { JSX } from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { PwaRegister } from './pwa';

export const metadata: Metadata = {
  title: 'LAND DESIGN CAD',
  description: '土地の寸法入力から敷地図面を作成し、駐車場を自動配置する土地設計CAD',
  manifest: './manifest.webmanifest',
  appleWebApp: { capable: true, title: 'LAND CAD', statusBarStyle: 'default' },
  icons: { icon: './icons/icon-192.png', apple: './icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0b5d63',
};

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="ja">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
      </head>
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
