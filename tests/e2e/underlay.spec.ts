// 測量図（PDF・PNG・JPEG）取込 → 縮尺合わせ → 回転補正 → 頂点配置 → 寸法確認 → 作図 の E2E
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import path from 'node:path';

const FIX = path.resolve('tests/e2e/fixtures');
const IMG = { w: 2000, h: 1500 };
// survey.png の敷地の角（画像ピクセル）：20m × 15m（80px/m）
const RECT = [{ u: 200, v: 1300 }, { u: 1800, v: 1300 }, { u: 1800, v: 100 }, { u: 200, v: 100 }];

const isMobile = (info: TestInfo): boolean => info.project.name !== 'desktop';

async function tapAt(page: Page, info: TestInfo, x: number, y: number): Promise<void> {
  if (isMobile(info)) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}
async function press(page: Page, info: TestInfo, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (isMobile(info)) await el.tap();
  else await el.click();
}

async function openUnderlayTab(page: Page, info: TestInfo): Promise<void> {
  await press(page, info, isMobile(info) ? 'mtab-underlay' : 'tab-underlay');
  await expect(page.getByTestId('underlay-panel')).toBeVisible();
}

/** パネル開閉・全体表示のアニメーションが終わり、下絵の表示位置が安定するまで待つ */
async function settle(page: Page): Promise<void> {
  let prev = '';
  for (let i = 0; i < 40; i++) {
    const b = await page.getByTestId('underlay-image').boundingBox();
    const key = b ? `${b.x.toFixed(1)},${b.y.toFixed(1)},${b.width.toFixed(1)}` : '';
    if (key && key === prev) return;
    prev = key;
    await page.waitForTimeout(120);
  }
}

/** 下絵の画像座標 → 画面座標（回転なしの場合：表示矩形から線形変換） */
async function screenOf(page: Page, p: { u: number; v: number }): Promise<{ x: number; y: number }> {
  const b = (await page.getByTestId('underlay-image').boundingBox())!;
  return { x: b.x + (p.u / IMG.w) * b.width, y: b.y + (p.v / IMG.h) * b.height };
}

async function importFile(page: Page, info: TestInfo, file: string): Promise<void> {
  await page.goto('./');
  await press(page, info, 'home-new');
  await openUnderlayTab(page, info);
  await page.getByTestId('underlay-file').setInputFiles(path.join(FIX, file));
  await expect(page.getByTestId('underlay-image')).toBeVisible({ timeout: 30_000 });
}

/** パネルを開く（モバイルでツール選択時に閉じるため） */
async function ensurePanel(page: Page, info: TestInfo): Promise<void> {
  if (!(await page.getByTestId('underlay-panel').isVisible())) await openUnderlayTab(page, info);
}

async function keypadType(page: Page, info: TestInfo, text: string): Promise<void> {
  await expect(page.getByTestId('keypad')).toBeVisible();
  for (const ch of text) await press(page, info, ch === '.' ? 'kp-dot' : `kp-${ch}`);
  await press(page, info, 'kp-ok');
  await expect(page.getByTestId('keypad')).toHaveCount(0);
}

test('PNG：基準寸法で縮尺合わせ→頂点配置→寸法を確認・修正→敷地図面を作成→再読込', async ({ page }, info) => {
  await importFile(page, info, 'survey.png');
  await expect(page.getByTestId('underlay-scale')).toHaveAttribute('data-method', 'none');

  // 透明度
  await page.getByTestId('underlay-opacity').fill('30');
  await expect(page.getByTestId('underlay-image')).toHaveAttribute('data-opacity', '0.3');
  await expect(page.getByTestId('underlay-opacity-value')).toHaveText('30%');

  // 基準寸法：A–B（20.00m）を2点指定して実寸を入力
  await press(page, info, 'ul-calibrate');
  await expect(page.getByTestId('underlay-banner')).toBeVisible();
  await press(page, info, 'zoom-fit');
  await settle(page);
  for (const p of [RECT[0], RECT[1]]) {
    const s = await screenOf(page, p);
    await tapAt(page, info, s.x, s.y);
  }
  await keypadType(page, info, '20');
  await ensurePanel(page, info);
  await expect(page.getByTestId('underlay-scale')).toHaveAttribute('data-method', 'reference');
  await expect(page.getByTestId('underlay-scale')).toContainText(/1px = 12\.[3-7]\dmm/);
  await expect(page.getByTestId('cal-label')).toHaveText('基準 20.000m');

  // 頂点配置
  await press(page, info, 'ul-trace');
  await press(page, info, 'zoom-fit');
  await settle(page);
  for (const p of RECT) {
    const s = await screenOf(page, p);
    await tapAt(page, info, s.x, s.y);
  }
  await expect(page.getByTestId('trace-dist-0')).toHaveText(/^(19\.9\d|20\.0\d|20\.1\d)m$/);
  await press(page, info, 'underlay-tool-done');
  await ensurePanel(page, info);
  await expect(page.getByTestId('trace-table')).toContainText('AC');

  // 寸法確認ダイアログ：読取値は未確定、修正・確認するまで作図できない
  await press(page, info, 'ul-confirm-open');
  await expect(page.getByTestId('trace-confirm')).toBeVisible();
  for (const [label, expected] of [['AB', 20], ['BC', 15], ['CD', 20], ['DA', 15], ['AC', 25]] as const) {
    await expect.poll(async () => Math.abs(Number((await page.getByTestId(`tc-value-${label}`).inputValue()) || 'NaN') - expected), { message: label }).toBeLessThan(0.2);
    await expect(page.getByTestId(`tc-state-${label}`)).toHaveText('読取値（要確認）');
  }
  await expect(page.getByTestId('tc-create')).toBeDisabled();
  // 値を修正すると「修正済み」になり、プレビューが再計算される（ここでは一旦 20.5m にしてから記載寸法へ）
  const setVal = async (label: string, val: string): Promise<void> => {
    const el = page.getByTestId(`tc-value-${label}`);
    if (isMobile(info)) {
      await el.tap();
      await press(page, info, 'kp-clear');
      await keypadType(page, info, val);
    } else {
      await el.fill(val);
      await el.press('Enter');
    }
  };
  await setVal('AB', '20.5');
  await expect(page.getByTestId('tc-state-AB')).toHaveText('修正済み');
  await expect(page.getByTestId('tc-preview')).not.toContainText('300.00㎡');
  // 測量図の記載寸法へ修正
  for (const [label, val] of [['AB', '20'], ['BC', '15'], ['CD', '20'], ['DA', '15'], ['AC', '25']] as const) await setVal(label, val);
  await expect(page.getByTestId('tc-preview')).toContainText('300.00㎡');
  await page.getByTestId('tc-checked').check();
  await press(page, info, 'tc-create');
  await expect(page.getByTestId('trace-confirm')).toHaveCount(0);

  // 作図結果：厳密解・300㎡、下絵は位置合わせ済み
  await ensurePanel(page, info);
  await expect(page.getByTestId('fit-error')).toContainText('最大');
  await press(page, info, isMobile(info) ? 'mtab-land' : 'tab-land');
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'exact');
  await expect(page.getByTestId('area')).toHaveText('300.00㎡');

  // 元画像と図面データが別々に保存されている
  await page.waitForTimeout(2200); // 自動保存（1.5秒後）を待つ
  const sep = await page.evaluate(async () => {
    const docKey = Object.keys(localStorage).find((k) => k.startsWith('ldc:p:'))!;
    const docJson = localStorage.getItem(docKey)!;
    const doc = JSON.parse(docJson) as { underlay: { originalAssetId: string } };
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('ldc-assets', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rec = await new Promise<{ size: number; mime: string } | undefined>((res) => {
      const g = db.transaction('assets').objectStore('assets').get(doc.underlay.originalAssetId);
      g.onsuccess = () => res(g.result);
    });
    return { docBytes: docJson.length, hasBase64Image: /iVBORw0KGgo|data:image/.test(docJson), assetSize: rec?.size, assetMime: rec?.mime };
  });
  expect(sep.hasBase64Image).toBe(false);
  expect(sep.docBytes).toBeLessThan(30_000);
  expect(sep.assetMime).toBe('image/png');
  expect(sep.assetSize).toBe(34707);

  // 再読込しても下絵と図面が復元される
  await page.reload();
  // 編集中だった図面がそのまま再表示される（一覧に戻った場合は図面を開く）
  await page.locator('[data-testid="project-item"], [data-testid="editor-mobile"], [data-testid="tab-underlay"]').first().waitFor();
  if (await page.getByTestId('project-item').count()) await press(page, info, 'project-item');
  await expect(page.getByTestId('underlay-image')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('underlay-image')).toHaveAttribute('data-opacity', '0.3');
});

test('JPEG（傾いたスキャン）：2点で水平に回転補正', async ({ page }, info) => {
  await importFile(page, info, 'survey-rotated.jpg');
  await press(page, info, 'ul-rotate-h');
  await press(page, info, 'zoom-fit');
  // 画像上で A(155.1,1228.2)→B(1749.0,1367.6)：5°傾いている
  for (const p of [{ u: 155.1, v: 1228.2 }, { u: 1749.0, v: 1367.6 }]) {
    const s = await screenOf(page, p);
    await tapAt(page, info, s.x, s.y);
  }
  await ensurePanel(page, info);
  await expect.poll(async () => Math.abs(Number(await page.getByTestId('ul-rotation').inputValue()) - 5)).toBeLessThan(0.4);
  const r = Number(await page.getByTestId('ul-rotation').inputValue());
  // 微調整ボタン
  await press(page, info, 'ul-rot-0.1');
  await expect.poll(async () => Number(await page.getByTestId('ul-rotation').inputValue())).toBeCloseTo(r + 0.1, 2);
});

test('PDF：ページを描画し、図面縮尺（1/100）で縮尺合わせ→頂点間距離を測定', async ({ page }, info) => {
  await importFile(page, info, 'survey.pdf');
  await expect(page.getByTestId('underlay-name')).toHaveText('survey.pdf');
  // PDF の図面縮尺（既定 1/250 をまず適用）
  await press(page, info, 'ul-pdf-scale');
  await expect(page.getByTestId('underlay-scale')).toHaveAttribute('data-method', 'pdf-scale');
  // 1/250 が既定 → 1/100 に変更して再適用
  await expect(page.getByTestId('underlay-scale')).toContainText('画像幅 62.50m'); // 250mm × 250
  const denomInput = page.getByLabel('縮尺 1/').first();
  if (isMobile(info)) {
    await denomInput.tap();
    await press(page, info, 'kp-clear');
    await keypadType(page, info, '100');
  } else {
    await denomInput.fill('100');
    await denomInput.press('Enter');
  }
  await press(page, info, 'ul-pdf-scale');
  await expect(page.getByTestId('underlay-scale')).toContainText('画像幅 25.00m');
  // 距離測定：A–B は 20m
  await press(page, info, 'ul-measure');
  await press(page, info, 'zoom-fit');
  await settle(page);
  for (const p of [RECT[0], RECT[1]]) {
    const s = await screenOf(page, p);
    await tapAt(page, info, s.x, s.y);
  }
  const t = await page.getByTestId('measure-label').textContent();
  expect(Math.abs(Number(t!.replace('m', '')) - 20)).toBeLessThan(0.2);
});

test('画像以外のファイルは中身で判定して拒否', async ({ page }, info) => {
  await page.goto('./');
  await press(page, info, 'home-new');
  await openUnderlayTab(page, info);
  await page.getByTestId('underlay-file').setInputFiles(path.join(FIX, 'not-an-image.png'));
  await expect(page.getByTestId('underlay-error')).toContainText('PDF・PNG・JPEG');
  await expect(page.getByTestId('underlay-image')).toHaveCount(0);
});
