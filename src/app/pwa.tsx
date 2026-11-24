'use client';
import { useEffect } from 'react';

/** Service Worker 登録（オフライン起動・ホーム画面追加用） */
export function PwaRegister(): null {
  useEffect(() => {
    try {
      if ('serviceWorker' in navigator && location.protocol === 'https:' && window.top === window) {
        navigator.serviceWorker.register('./sw.js').catch(() => undefined);
      }
    } catch {
      /* 埋め込み環境では登録しない */
    }
  }, []);
  return null;
}
