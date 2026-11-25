import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function newProject(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByTestId('home-new').click();
  await expect(page.getByTestId('land-panel')).toBeVisible();
}

async function fill(page: Page, testId: string, value: string): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(value);
  await el.press('Enter');
}


test('土地作図：辺＋対角線で四角形、面積・外周が正しい／不足・矛盾を検出', async ({ page }) => {
  await newProject(page);
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'exact');
  await expect(page.getByTestId('area')).toHaveText('300.00㎡');
  await expect(page.getByTestId('perimeter')).toHaveText('70.00m');
  // 対角線を削除 → 不足
  await page.getByTestId('land-tab-diagonals').click();
  await page.getByTitle('対角線を削除').click();
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'underdetermined');
  await expect(page.getByTestId('solve-status')).toContainText('あと1個');
  // 矛盾する対角線
  await page.getByTestId('add-diagonal').click();
  await fill(page, 'diag-0', '40');
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'inconsistent');
  await fill(page, 'diag-0', '25');
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'exact');
});

test('五角形・角度入力・座標入力（組み合わせ）', async ({ page }) => {
  await newProject(page);
  await page.getByTestId('vertex-count').selectOption('5');
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', /underdetermined|inconsistent/);
  // 座標で五角形
  await page.getByTestId('land-tab-coords').click();
  const pts = [[0, 0], [20, 0], [26, 12], [12, 22], [-3, 14]];
  for (let i = 0; i < 5; i++) {
    await fill(page, `coord-x-${i}`, String(pts[i][0]));
    await fill(page, `coord-y-${i}`, String(pts[i][1]));
  }
  // 既存の辺入力（20,15,20,15）と矛盾するため辺をクリア
  await page.getByTestId('land-tab-sides').click();
  for (let i = 0; i < 5; i++) await fill(page, `side-${i}`, '');
  await page.getByTestId('land-tab-diagonals').click();
  await page.getByTitle('対角線を削除').click();
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'exact');
  await expect(page.getByTestId('area')).toHaveText('451.00㎡');
  // 角度タブ：度分秒入力（整合する値のみ確認用に1点）
  await page.getByTestId('land-tab-angles').click();
  await expect(page.getByTestId('angle-0')).toBeVisible();
});

test('駐車場：自動配置→複数案比較→適用、モード切替、手動編集、Undo/Redo', async ({ page }) => {
  await newProject(page);
  await page.getByTestId('tab-parking').click();
  await page.getByTestId('run-optimize').click();
  await expect(page.getByTestId('plan-card').first()).toBeVisible({ timeout: 60_000 });
  const n = await page.getByTestId('plan-card').count();
  expect(n).toBeGreaterThanOrEqual(2);
  const firstCount = Number((await page.getByTestId('plan-count').first().textContent())!.replace('台', ''));
  expect(firstCount).toBeGreaterThanOrEqual(6);
  await page.getByTestId('apply-A案').click();
  await expect(page.getByTestId('stall-count')).toHaveText(`${firstCount}台`);
  await expect(page.getByTestId('interference')).toHaveText('問題なし');

  // モード切替（同じデータ）
  await page.getByTestId('mode-proposal').click();
  await expect(page.getByTestId('drawing-svg')).toHaveAttribute('data-mode', 'proposal');
  const stallsP = await page.locator('[data-hit="stall"]').count();
  await page.getByTestId('mode-cad').click();
  await expect(page.getByTestId('drawing-svg')).toHaveAttribute('data-mode', 'cad');
  expect(await page.locator('[data-hit="stall"]').count()).toBe(stallsP);
  expect(stallsP).toBe(firstCount);

  // 枠を選択 → 数値で移動・回転・複製
  await page.locator('[data-hit="stall"]').first().click({ force: true });
  await expect(page.getByTestId('stall-editor')).toBeVisible();
  const x0 = Number(await page.getByTestId('sel-x').inputValue());
  await fill(page, 'sel-x', String(x0 + 0.5));
  await expect(page.getByTestId('sel-x')).toHaveValue(String(Math.round((x0 + 0.5) * 1000) / 1000));
  const ang0 = await page.getByTestId('sel-angle').inputValue();
  await page.getByTestId('rotate-90').click();
  await expect(page.getByTestId('sel-angle')).not.toHaveValue(ang0);
  await page.getByTestId('duplicate').click();
  await expect(page.getByTestId('stall-count').or(page.getByTestId('header-count'))).toBeVisible();
  await expect(page.getByTestId('header-count')).toHaveText(String(firstCount + 1));
  // 回転・複製で干渉が発生 → 検出
  await page.getByTestId('tab-parking').click();
  await expect(page.getByTestId('interference')).toHaveText('要確認');
  // Undo ×3 で元に戻る
  await page.getByTestId('undo').click();
  await page.getByTestId('undo').click();
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('header-count')).toHaveText(String(firstCount));
  await expect(page.getByTestId('interference')).toHaveText('問題なし');
  await page.getByTestId('redo').click();
  await page.getByTestId('undo').click();

  // ドラッグで移動（スナップ0.1m）
  const stall = page.locator('[data-hit="stall"]').nth(2);
  const box = (await stall.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.getByTestId('tab-parking').click();
  await expect(page.getByTestId('interference')).toHaveText('要確認');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('interference')).toHaveText('問題なし');
});

test('通路幅の検証と駐車枠寸法の変更', async ({ page }) => {
  await newProject(page);
  await page.getByTestId('tab-parking').click();
  await fill(page, 'stall-w-standard', '2.3');
  await page.getByTestId('run-optimize').click();
  await expect(page.getByTestId('plan-card').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('plans')).toContainText('必要幅');
  await expect(page.getByTestId('plan-aisle').first()).toContainText('通路幅');
});

test('PDF・PNG出力', async ({ page }) => {
  await newProject(page);
  await page.getByTestId('tab-output').click();
  await page.getByTestId('export-paper').selectOption('A3');
  await expect(page.getByTestId('export-preview')).toContainText('精密CAD図');
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-pdf').click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  const p = await pdf.path();
  const fs = await import('node:fs');
  const head = fs.readFileSync(p!).subarray(0, 5).toString();
  expect(head).toBe('%PDF-');
  const size = fs.statSync(p!).size;
  expect(size).toBeGreaterThan(5000);
  await page.getByTestId('export-mode').selectOption('proposal');
  const [png] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-png').click()]);
  expect(png.suggestedFilename()).toMatch(/proposal.*\.png$/);
  const ph = fs.readFileSync((await png.path())!).subarray(1, 4).toString();
  expect(ph).toBe('PNG');
});

test('寸法不足・不一致でも仮の形を表示し、確定・修正できる', async ({ page }) => {
  await newProject(page);
  await expect(page.getByTestId('start-guide')).toContainText('反時計回り');
  // 対角線を消す → 寸法不足：角度を自動調整した仮の形
  await page.getByTestId('land-tab-diagonals').click();
  await page.getByTitle('対角線を削除').click();
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'underdetermined');
  await expect(page.getByTestId('preview-banner')).toHaveAttribute('data-kind', 'auto');
  await expect(page.getByTestId('preview-auto')).toContainText('角A 90°00′00.0″');
  await expect(page.getByTestId('area')).toHaveText('300.00㎡');
  // 図面に仮の形（破線の敷地）が描かれている
  await expect(page.locator('[data-testid="drawing-svg"] polygon[stroke="#b45309"]').first()).toBeVisible();
  // 合わない対角線 → どの寸法が合わないかを表示し、ワンタップで直せる
  await page.getByTestId('add-diagonal').click();
  await fill(page, 'diag-0', '40');
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'inconsistent');
  await expect(page.getByTestId('preview-banner')).toHaveAttribute('data-kind', 'mismatch');
  await expect(page.getByTestId('preview-mismatch')).toContainText('AC');
  await expect(page.getByTestId('preview-mismatch')).toContainText('25.000m');
  await page.getByTestId('conflict-replace').click();
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'exact');
  await expect(page.getByTestId('diag-0')).toHaveValue('25');
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);
  // 対角線を消して、自動調整の形で確定 → 角度が入力欄に入り、形が確定する
  await page.getByTitle('対角線を削除').click();
  await page.getByTestId('accept-preview').click();
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'exact');
  await page.getByTestId('land-tab-angles').click();
  await expect(page.getByTestId('angle-0')).toHaveValue(/^90/);
  // 元に戻すで仮の形に戻る
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'underdetermined');
});

test('回る向き（時計回り）を切り替えると形が左右反転し、案内も変わる', async ({ page }) => {
  await newProject(page);
  await page.getByTestId('vertex-order').selectOption('cw');
  await expect(page.getByTestId('start-guide')).toContainText('時計回り（右回り）');
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'exact');
  await expect(page.getByTestId('area')).toHaveText('300.00㎡');
  await page.getByTestId('vertex-order').selectOption('ccw');
  await expect(page.getByTestId('start-guide')).toContainText('反時計回り');
});

test('PDFの実寸：用紙寸法と縮尺バーの長さをPDFから実測する（A3・1/200）', async ({ page }) => {
  const cspErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) cspErrors.push(m.text());
  });
  await newProject(page);
  await page.getByTestId('tab-output').click();
  await page.getByTestId('export-paper').selectOption('A3');
  await page.getByTestId('export-scale').selectOption('200');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-pdf').click()]);
  const fs = await import('node:fs');
  const data = new Uint8Array(fs.readFileSync((await dl.path())!));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
  expect(pdf.numPages).toBe(1);
  const pg = await pdf.getPage(1);
  const [x0, y0, x1, y1] = pg.view;
  const PT = 72 / 25.4;
  // A3 横 = 420×297mm
  expect(Math.abs(x1 - x0 - 420 * PT)).toBeLessThan(0.5);
  expect(Math.abs(y1 - y0 - 297 * PT)).toBeLessThan(0.5);
  const tc = await pg.getTextContent();
  const items = (tc.items as unknown[]).filter((i): i is { str: string; transform: number[]; width: number } => typeof i === 'object' && i !== null && 'str' in i);
  const all = items.map((i) => i.str).join('');
  expect(all).toContain('1/200');
  expect(all).toContain('実際のサイズ');
  // 縮尺バー：1/200 では 10m = 50mm。「0」の左端から「10m」の中心までが 50mm であること
  const lab = items.find((i) => i.str === '10m');
  expect(lab).toBeTruthy();
  const zero = items.filter((i) => i.str === '0' && Math.abs(i.transform[5] - lab!.transform[5]) < 0.5 && i.transform[4] < lab!.transform[4]).sort((a, b) => b.transform[4] - a.transform[4])[0];
  expect(zero).toBeTruthy();
  const barPt = lab!.transform[4] + lab!.width / 2 - zero.transform[4];
  expect(Math.abs(barPt / PT - 50)).toBeLessThan(0.3);
  await pdf.destroy();
  // セキュリティポリシー（CSP）が出力処理（フォント取得・PDF生成）を妨げていない
  expect(cspErrors).toEqual([]);
});

test('保存・再編集（リロード後も一覧から再開できる）', async ({ page }) => {
  await newProject(page);
  await page.getByTestId('project-name').fill('保存確認テスト');
  await page.getByTestId('tab-parking').click();
  await page.getByTestId('run-optimize').click();
  await page.getByTestId('apply-A案').click({ timeout: 60_000 });
  const cnt = await page.getByTestId('header-count').textContent();
  await expect(page.getByTestId('save-state')).toHaveText('保存済み', { timeout: 10_000 });
  await page.getByTestId('back-home').click();
  await page.reload();
  const item = page.getByTestId('project-item').filter({ hasText: '保存確認テスト' });
  await expect(item).toContainText(`${cnt}台`);
  await expect(item).toContainText('300.00㎡');
  await item.click();
  await expect(page.getByTestId('header-count')).toHaveText(cnt!);
  await expect(page.getByTestId('project-name')).toHaveValue('保存確認テスト');
});

test('変形地（三角形）：角度比較・上限と最良案の区別・案ごとの問題点', async ({ page }) => {
  await newProject(page);
  await page.getByTestId('vertex-count').selectOption('3');
  await page.getByTestId('land-tab-diagonals').click();
  await page.getByTitle('対角線を削除').click();
  await page.getByTestId('land-tab-sides').click();
  for (let i = 0; i < 3; i++) await fill(page, `side-${i}`, '');
  await page.getByTestId('land-tab-coords').click();
  const pts = [[0, 0], [45, 0], [15, 32]];
  for (let i = 0; i < 3; i++) {
    await fill(page, `coord-x-${i}`, String(pts[i][0]));
    await fill(page, `coord-y-${i}`, String(pts[i][1]));
  }
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'exact');
  await expect(page.getByTestId('area')).toHaveText('720.00㎡');
  await page.getByTestId('tab-parking').click();
  await page.getByTestId('run-optimize').click();
  await expect(page.getByTestId('bounds')).toBeVisible({ timeout: 90_000 });
  const rows = page.getByTestId('angle-table').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('90°');
  await expect(rows.nth(1)).toContainText('60°');
  await expect(rows.nth(2)).toContainText('45°');
  const best = Number((await page.getByTestId('best-count').textContent())!.replace('台', ''));
  const bound = Number((await page.getByTestId('access-bound').textContent())!.replace('台', ''));
  expect(best).toBeGreaterThanOrEqual(15);
  expect(best).toBeLessThanOrEqual(bound);
  await expect(page.getByTestId('plan-optimality').first()).toHaveText(best === bound ? /証明済み/ : '探索による最良案');
  await page.getByTestId('plan-issues-summary').first().click();
  await expect(page.getByTestId('plan-issues').first()).toContainText('通路幅');
  await page.getByTestId('apply-A案').click();
  await expect(page.getByTestId('interference')).toHaveText('問題なし');
});
