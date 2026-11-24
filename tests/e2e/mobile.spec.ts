import { expect, test } from '@playwright/test';

test('27. iPhone：タップ操作で作図・自動配置・出力パネルまで操作できる', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('home-new').tap();
  await expect(page.getByTestId('mobile-sheet')).toBeVisible();
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'exact');
  // 下部メニュー
  await page.getByTestId('mtab-parking').tap();
  await page.getByTestId('run-optimize').tap();
  await page.getByTestId('apply-A案').tap({ timeout: 60_000 });
  const cnt = await page.getByTestId('stall-count').textContent();
  expect(Number(cnt!.replace('台', ''))).toBeGreaterThanOrEqual(6);
  // パネルを閉じて図面を広く
  await page.getByTestId('toggle-sheet').tap();
  await expect(page.getByTestId('mobile-sheet')).toHaveCount(0);
  // 枠をタップで選択 → 選択パネルが開く
  await page.locator('[data-hit="stall"]').first().tap({ force: true });
  await expect(page.getByTestId('stall-editor')).toBeVisible();
  // 数値入力はテンキー（inputmode=decimal）
  await expect(page.getByTestId('sel-w')).toHaveAttribute('inputmode', 'decimal');
  // ボタンは指で押せる大きさ
  const b = await page.getByTestId('mtab-output').boundingBox();
  expect(b!.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId('mtab-output').tap();
  await expect(page.getByTestId('output-panel')).toBeVisible();
  // ズーム操作
  await page.getByTestId('zoom-in').tap();
  await page.getByTestId('zoom-fit').tap();
});
