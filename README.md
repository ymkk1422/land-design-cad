# LAND DESIGN CAD

土地の寸法を入力して敷地図面を作り、駐車場を自動配置して PDF・画像で出力する Web アプリです（Next.js + TypeScript + PWA）。

## 起動方法

```bash
npm install
npm run dev            # http://localhost:3000
npm test               # 単体・結合テスト（Vitest）
npm run build          # 静的書き出し → out/
npx playwright test    # E2E（out/ を配信して PC と iPhone 表示で検証）
node scripts/build-artifact.mjs   # 単一HTML版 → dist-artifact/
```

## 公開方法

- **Vercel / Netlify / Cloudflare Pages**：`npm run build` で作られる `out/` をそのまま配信できます（静的書き出し）。
- **クラウド保存を使う場合**：Supabase プロジェクトを作り、`supabase/schema.sql` を SQL Editor で実行します。次に `.env.local` に `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_ANON_KEY` を設定してビルドします。anon キーは公開前提のキーです。権限は RLS で制御しています。
- **iPhone**：HTTPS で配信したページを Safari で開き、「共有 → ホーム画面に追加」を選びます。

## 構成

```
src/
  app/                 Next.js（layout, page, PWA登録）
  components/          画面（Home, Editor, Settings）
    canvas/            SVG図面キャンバス（パン・ピンチ・回転・選択・ドラッグ・頂点編集）
    property-panel/    土地入力・設備・選択編集
    parking/           駐車条件・自動配置・案比較
    dialogs/           表示設定・出力・バージョン履歴
  engine/              ← 描画から独立した計算エンジン（UIに依存しない）
    geometry/          多角形演算・線形代数
    constraints/       土地形状ソルバー（LM法）・頂点編集
    parking-optimizer/ 自動配置・到達性解析・枠編集操作
    validation/        干渉判定・必要通路幅
    area-calculation/  面積・坪・単位・度分秒
    export/            図面モデル（画面/PDF共通）・用紙と縮尺
  stores/              Zustand（Undo/Redo）
  services/            保存（端末/claude.ai/Supabase）・出力
supabase/schema.sql    テーブル・RLS・サーバー側検証関数
tests/                 geometry / parking / integration / e2e
```

## 計算エンジンの考え方

- **土地形状**：辺・対角線・内角・座標をすべて残差として扱い、レーベンバーグ・マーカート法で解きます。マルチスタート探索で複数の解を集めます。
  - ヤコビ行列のランクで、形状が一意に決まるかを判定します。決まらない場合は**図面を生成せず**、不足している寸法の数を示します。
  - 解の残差で次の 3 つを区別します。**厳密解**（残差≒0）、**近似解**（許容誤差内の最小二乗解）、**矛盾**（許容誤差を超える）。
  - 凸／凹の反転による複数解は候補として表示します。座標で向きが固定されている場合は**鏡像**も判定します。自己交差する解は除外します。
- **駐車場（v1.1）**：方向 × 角度（90/60/45/任意）× 列オフセット × 横断通路の位置 × 列の揃え方 を探索し、到達性の粗い検証で候補を絞り込みます。そのうえで次を組み合わせて精査します。
  - 外周充填（辺沿いの背中合わせ枠）
  - 2方向ゾーン（凹形地）
  - 外周配置＋周回通路
  - 転回広場（行き止まり対策）
- **検証**：枠は敷地内（凹部の入隅を含む）・障害物と重ならない・出入口前を空ける、の3点を確認します。通路は敷地内に収まるよう切り詰めます。出入口からの到達性は、車両の旋回軌跡幅（`sweptPath`）から決めたクリアランスで判定します。
- **数学的上限**（`bounds.ts`）：
  - 面積上限（無条件に成り立つ）
  - 通路考慮上限（各枠に専用の前面通路領域があるという前提）
  - 最良案がどちらかの上限に一致したときだけ「最大と証明済み」と表示し、それ以外は「探索による最良案」と上限との差を表示します。
- `npm run bench` で変形地6形状のベンチマークを実行できます。

## 未実装・制限

- 通路幅の必要値は簡易式 `W = R(1−cosα) + B·cosα + 0.5m` です。到達判定はアッカーマン近似の軌跡幅を使いますが、駐車枠への入庫軌跡のシミュレーションは未実装です。
- 一方通行（斜め駐車）の周回動線の向きの整合性は自動検証しません（警告を表示します）。
- 自動配置で生成されるのは、選んだ 1 種類の枠だけです。車椅子用などは手動で追加します。
- 平面直角座標系・緯度経度は型だけ用意しています（`CoordinateSystem`）。変換処理は未実装です。
- Supabase 連携はコードとスキーマを用意済みです。実際の Supabase プロジェクトでの動作確認はしていません。
