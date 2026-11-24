// 単一 HTML（+ フォント）にバンドルして dist-artifact/ に出力
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist-artifact');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });

const r = await build({
  entryPoints: [path.join(root, 'scripts/artifact-entry.tsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020', 'safari15'],
  jsx: 'automatic',
  write: false,
  alias: { '@': path.join(root, 'src') },
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_PUBLIC_SUPABASE_URL': '""',
    'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': '""',
  },
  external: ['@supabase/supabase-js', 'html2canvas', 'dompurify', 'canvg'],
  logLevel: 'warning',
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
execSync(`npx tailwindcss -i src/app/globals.css -o ${path.join(out, 'app.css')} --minify`, { cwd: root, stdio: 'ignore' });
const css = fs.readFileSync(path.join(out, 'app.css'), 'utf8');
fs.rmSync(path.join(out, 'app.css'));
fs.copyFileSync(path.join(root, 'public/fonts/NotoSansJP-subset.ttf'), path.join(out, 'fonts/NotoSansJP-subset.ttf'));

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b5d63">
<title>LAND DESIGN CAD</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
/* VOICE: 測量図面の精密さ。IDEA: 製図台の上の敷地図。PICTURE: 図面そのもの。COLOUR/TYPE: 白地・墨・深緑・信号赤／Noto Sans JP。LAYOUT: PC=3ペイン、スマホ=全面図面＋下部メニュー */
${css}
</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('index.html', (html.length / 1024).toFixed(0) + 'KB');
