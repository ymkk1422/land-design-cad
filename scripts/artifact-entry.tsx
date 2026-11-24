// claude.ai Artifact 用エントリ（Next.js 版と同一のコンポーネントを単一HTMLにバンドル）
import { createRoot } from 'react-dom/client';
import { App } from '@/components/App';

createRoot(document.getElementById('root')!).render(<App />);
