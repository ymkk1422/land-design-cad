// pdf.js（PDF下絵の描画）を public/ にコピー（npm install 後に実行）
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
// 一部のホスティングで .mjs の MIME が不正になるため .js 名で配置
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/legacy/build', f), path.join(root, 'public', f.replace(/\.mjs$/, '.js')));
