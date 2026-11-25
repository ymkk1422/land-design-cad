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

// コンテンツセキュリティポリシー（静的配信のため meta で指定）。
// 外部スクリプト・プラグイン・他サイトへのフォーム送信を禁止し、通信先を自サイトと（設定時のみ）Supabase に限定する。
// Next.js の静的出力はインラインの初期化スクリプトを含むため script-src に 'unsafe-inline' が必要（eval は不許可）。
const SUPABASE = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/[^A-Za-z0-9:/._-]/g, '');
const SUPABASE_WS = SUPABASE.replace(/^http/, 'ws');
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  `connect-src 'self' blob: data:${SUPABASE ? ` ${SUPABASE} ${SUPABASE_WS}` : ''}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "manifest-src 'self'",
].join('; ');

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="ja">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={CSP} />
        <meta name="referrer" content="strict-origin-when-cross-origin" />
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
