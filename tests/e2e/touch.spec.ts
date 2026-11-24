// iPhone・iPad 実機相当サイズでのタッチ操作テスト
// Chrome DevTools Protocol の Input.dispatchTouchEvent で、実際のマルチタッチ（2本指ピンチ・2本指移動）を発生させる
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import fs from 'node:fs';

type Pt = { x: number; y: number };

class Finger {
  constructor(private cdp: CDPSession) {}
  async send(type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 4, radiusY: 4, force: 1 })) });
  }
  /** 指を pts0 → pts1 へ steps 段階で動かす（1本でも2本でも） */
  async gesture(pts0: Pt[], pts1: Pt[], steps = 10): Promise<void> {
    await this.send('touchStart', pts0);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      await this.send('touchMove', pts0.map((p, i) => ({ x: p.x + (pts1[i].x - p.x) * t, y: p.y + (pts1[i].y - p.y) * t })));
    }
    await this.send('touchEnd', []);
  }
  async tap(p: Pt): Promise<void> {
    await this.send('touchStart', [p]);
    await this.send('touchEnd', []);
  }
}

async function box(page: Page, sel: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`no box ${sel}`);
  return b;
}
const center = (b: { x: number; y: number; width: number; height: number }): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const scale = async (page: Page): Promise<number> => Number(await page.getByTestId('scale-bar').getAttribute('data-px-per-m'));

/** 図面中央に最も近い駐車枠に目印を付ける（画面端のUIに隠れていない枠を使う） */
async function markCentralStall(page: Page): Promise<string> {
  await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
    const cx = cv.left + cv.width / 2;
    const cy = cv.top + cv.height * 0.4;
    let best: Element | null = null;
    let bd = Infinity;
    document.querySelectorAll('[data-hit="stall"]').forEach((el) => {
      el.removeAttribute('data-e2e');
      const b = el.getBoundingClientRect();
      const d = Math.hypot(b.left + b.width / 2 - cx, b.top + b.height / 2 - cy);
      if (d < bd) {
        bd = d;
        best = el;
      }
    });
    (best as Element | null)?.setAttribute('data-e2e', 'target');
  });
  const id = await page.locator('[data-e2e="target"]').getAttribute('data-id');
  return `[data-hit="stall"][data-id="${id}"]`;
}

async function setupWithPlan(page: Page): Promise<Finger> {
  await page.goto('./');
  await page.getByTestId('home-new').tap();
  await expect(page.getByTestId('editor-mobile')).toBeVisible();
  await page.getByTestId('mtab-parking').tap();
  await page.getByTestId('run-optimize').tap();
  await page.getByTestId('apply-A案').tap({ timeout: 90_000 });
  // パネルを閉じて図面を広く
  await page.getByTestId('mtab-parking').tap();
  await expect(page.getByTestId('mobile-sheet')).toBeHidden();
  await page.getByTestId('zoom-fit').tap();
  await page.waitForTimeout(150);
  const cdp = await page.context().newCDPSession(page);
  return new Finger(cdp);
}

test('レイアウト：はみ出しなし・押しやすいボタン・ページがズーム/スクロールしない', async ({ page }, info) => {
  await setupWithPlan(page);
  const vw = page.viewportSize()!;
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const id of ['undo', 'redo', 'zoom-fit', 'maximize', 'mtab-land', 'mtab-output']) {
    const b = await page.getByTestId(id).boundingBox();
    expect(b, id).not.toBeNull();
    expect(b!.height, id).toBeGreaterThanOrEqual(44);
    expect(b!.width, id).toBeGreaterThanOrEqual(44);
    expect(b!.x + b!.width, id).toBeLessThanOrEqual(vw.width + 0.5);
    expect(b!.y + b!.height, id).toBeLessThanOrEqual(vw.height + 0.5);
  }
  // 図面表示エリアが画面の大部分を占める
  const c = await box(page, '[data-testid="canvas"]');
  expect((c.width * c.height) / (vw.width * vw.height)).toBeGreaterThan(0.6);
  const layout = await page.getByTestId('editor-mobile').getAttribute('data-layout');
  expect(layout).toBe(info.project.name === 'iphone-landscape' || info.project.name === 'ipad-mini' ? 'side' : 'bottom');
  fs.mkdirSync('/tmp/shots', { recursive: true });
  await page.screenshot({ path: `/tmp/shots/touch-${info.project.name}.png` });
});

test('ピンチイン・ピンチアウト／2本指で図面移動（ページは拡大・スクロールしない）', async ({ page }) => {
  const f = await setupWithPlan(page);
  const c = center(await box(page, '[data-testid="canvas"]'));
  const s0 = await scale(page);
  // ピンチアウト（指を広げる）
  await f.gesture([{ x: c.x - 40, y: c.y }, { x: c.x + 40, y: c.y }], [{ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y }]);
  const s1 = await scale(page);
  expect(s1 / s0).toBeGreaterThan(2.2);
  expect(s1 / s0).toBeLessThan(2.8);
  // ピンチイン
  await f.gesture([{ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y }], [{ x: c.x - 50, y: c.y }, { x: c.x + 50, y: c.y }]);
  expect((await scale(page)) / s1).toBeCloseTo(0.5, 1);
  // 2本指で図面移動（拡大率は変わらず、図面全体が平行移動）
  const s2 = await scale(page);
  const site0 = await box(page, '[data-pid="site"]');
  await f.gesture([{ x: c.x - 30, y: c.y - 20 }, { x: c.x + 30, y: c.y - 20 }], [{ x: c.x - 30 + 50, y: c.y - 20 + 40 }, { x: c.x + 30 + 50, y: c.y - 20 + 40 }]);
  const site1 = await box(page, '[data-pid="site"]');
  expect(await scale(page)).toBeCloseTo(s2, 3);
  expect(site1.x - site0.x).toBeCloseTo(50, -0.5);
  expect(site1.y - site0.y).toBeCloseTo(40, -0.5);
  // ページ自体は拡大もスクロールもしていない
  const vp = await page.evaluate(() => ({ s: window.visualViewport?.scale ?? 1, y: window.scrollY, x: window.scrollX }));
  expect(vp).toEqual({ s: 1, y: 0, x: 0 });
});

test('1本指：選択済みの枠だけ移動（未選択の枠は図面移動）・Undo/Redo・選択解除', async ({ page }) => {
  const f = await setupWithPlan(page);
  const stall = await markCentralStall(page);
  const rel = async (): Promise<Pt> => {
    const s = await box(page, stall);
    const t = await box(page, '[data-pid="site"]');
    return { x: s.x - t.x, y: s.y - t.y };
  };
  // 未選択の枠の上で1本指ドラッグ → 図面移動（枠は敷地に対して動かない）
  const r0 = await rel();
  const p0 = center(await box(page, stall));
  await f.gesture([p0], [{ x: p0.x + 40, y: p0.y + 30 }]);
  expect(await page.getByTestId('selection-bar').count()).toBe(0);
  const r1 = await rel();
  expect(Math.abs(r1.x - r0.x)).toBeLessThan(1);
  expect(Math.abs(r1.y - r0.y)).toBeLessThan(1);
  // タップで選択 → 選択バー
  const p1 = center(await box(page, stall));
  await f.tap(p1);
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  await expect(page.getByTestId('rotate-handle')).toHaveCount(1);
  // 選択済みの枠を1本指でドラッグ → 枠が移動
  await f.gesture([p1], [{ x: p1.x + 60, y: p1.y }]);
  const r2 = await rel();
  expect(r2.x - r1.x).toBeGreaterThan(40);
  // 元に戻す／やり直す
  await page.getByTestId('undo').tap();
  const r3 = await rel();
  expect(Math.abs(r3.x - r1.x)).toBeLessThan(1);
  await page.getByTestId('redo').tap();
  expect((await rel()).x - r1.x).toBeGreaterThan(40);
  await page.getByTestId('undo').tap();
  // 選択解除ボタン
  await page.getByTestId('deselect').tap();
  await expect(page.getByTestId('selection-bar')).toHaveCount(0);
  await expect(page.getByTestId('rotate-handle')).toHaveCount(0);
});

test('2本目の指が触れたら枠のドラッグを取り消してピンチに切り替える', async ({ page }) => {
  const f = await setupWithPlan(page);
  const sel = await markCentralStall(page);
  const p = center(await box(page, sel));
  await f.tap(p);
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  const count0 = await page.getByTestId('header-count').textContent();
  const site0 = await box(page, '[data-pid="site"]');
  const st0 = await box(page, sel);
  // 1本指で枠を少し動かした後に2本目の指 → 枠の移動は取り消し
  await f.send('touchStart', [p]);
  for (let k = 1; k <= 5; k++) await f.send('touchMove', [{ x: p.x + k * 8, y: p.y }]);
  await f.send('touchStart', [{ x: p.x + 40, y: p.y }, { x: p.x + 40, y: p.y + 80 }]);
  for (let k = 1; k <= 5; k++) await f.send('touchMove', [{ x: p.x + 40, y: p.y - k * 6 }, { x: p.x + 40, y: p.y + 80 + k * 6 }]);
  await f.send('touchEnd', []);
  const site1 = await box(page, '[data-pid="site"]');
  const st1 = await box(page, sel);
  const k = site1.width / site0.width; // ピンチの倍率
  expect(k).toBeGreaterThan(1.05);
  // 敷地に対する枠の相対位置は倍率分だけ（移動していない）
  expect((st1.x - site1.x) / k).toBeCloseTo(st0.x - site0.x, -0.5);
  await expect(page.getByTestId('header-count')).toHaveText(count0!);
  await expect(page.getByTestId('undo')).toBeEnabled(); // 自動配置の適用分のみ
});

test('選択した枠の回転（ハンドル・ボタン）と数値入力のテンキー', async ({ page }) => {
  const f = await setupWithPlan(page);
  const sel = await markCentralStall(page);
  await f.tap(center(await box(page, sel)));
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  // 回転ハンドルをドラッグ
  const h = center(await box(page, '[data-testid="rotate-handle"]'));
  const b0 = await box(page, sel);
  const s = center(b0);
  await f.send('touchStart', [h]);
  for (let k = 1; k <= 8; k++) {
    const a = (Math.PI / 2) * (k / 8);
    const r = Math.hypot(h.x - s.x, h.y - s.y);
    const a0 = Math.atan2(h.y - s.y, h.x - s.x);
    await f.send('touchMove', [{ x: s.x + r * Math.cos(a0 + a), y: s.y + r * Math.sin(a0 + a) }]);
    if (k === 4) await expect(page.getByTestId('rotate-label')).toBeVisible();
  }
  await f.send('touchEnd', []);
  await expect(page.getByTestId('rotate-label')).toHaveCount(0);
  // 90°ドラッグ → 枠の縦横が入れ替わる（15°の倍数に吸着するので正確に90°）
  const b1 = await box(page, sel);
  expect(Math.abs(b1.width - b0.height)).toBeLessThan(2);
  expect(Math.abs(b1.height - b0.width)).toBeLessThan(2);
  // 数値で確認（テンキーで編集）
  await page.getByTestId('bar-details').tap();
  await expect(page.getByTestId('stall-editor')).toBeVisible();
  const ang = Number(await page.getByTestId('sel-angle').inputValue());
  expect(Math.abs(ang) % 15).toBe(0);
  // ボタンで90°回転
  await page.getByTestId('bar-rot-90').tap();
  await expect(page.getByTestId('sel-angle')).not.toHaveValue(String(ang));

  // テンキー：OSキーボードではなくアプリ内テンキー（readOnly + inputmode=none）
  const x = page.getByTestId('sel-x');
  await expect(x).toHaveAttribute('inputmode', 'none');
  await x.tap();
  await expect(page.getByTestId('keypad')).toBeVisible();
  for (const k of ['1', '2', 'dot', '5']) await page.getByTestId(`kp-${k}`).tap();
  await page.getByTestId('kp-sign').tap();
  await expect(page.getByTestId('kp-display')).toContainText('-12.5');
  await page.getByTestId('kp-ok').tap();
  await expect(page.getByTestId('keypad')).toHaveCount(0);
  await expect(x).toHaveValue('-12.5');
  // 「次へ」で次の入力欄へ
  await x.tap();
  await page.getByTestId('kp-3').tap();
  await page.getByTestId('kp-next').tap();
  await expect(page.getByTestId('keypad')).toBeVisible();
  await expect(page.getByTestId('kp-display')).not.toContainText('3');
  await page.getByTestId('kp-cancel').tap();
  await expect(x).toHaveValue('3');
});

test('度分秒の角度入力（テンキー）と土地寸法の入力', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('home-new').tap();
  await page.getByTestId('land-tab-angles').tap();
  await page.getByTestId('angle-0').tap();
  for (const k of ['9', '0']) await page.getByTestId(`kp-${k}`).tap();
  await page.getByTestId('kp-deg').tap();
  for (const k of ['3', '0']) await page.getByTestId(`kp-${k}`).tap();
  await page.getByTestId('kp-min').tap();
  await expect(page.getByTestId('kp-display')).toContainText('90°30′');
  await page.getByTestId('kp-ok').tap();
  await expect(page.getByTestId('angle-0')).toHaveValue('90.5'); // 度分秒は10進度に正規化して表示
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'inconsistent');
  // 辺の長さ：テンキーで変更すると面積が再計算される
  await page.getByTestId('angle-0').tap();
  await page.getByTestId('kp-clear').tap();
  await page.getByTestId('kp-ok').tap();
  await page.getByTestId('land-tab-sides').tap();
  await page.getByTestId('side-0').tap();
  await page.getByTestId('kp-2').tap();
  await page.getByTestId('kp-0').tap();
  await page.getByTestId('kp-ok').tap();
  await expect(page.getByTestId('solve-status')).toHaveAttribute('data-status', 'exact');
  await expect(page.getByTestId('area')).toHaveText('300.00㎡');
});

test('全体表示ボタン・図面の最大化・パネルのスクロールが図面に干渉しない', async ({ page }) => {
  const f = await setupWithPlan(page);
  const c = center(await box(page, '[data-testid="canvas"]'));
  // 拡大・移動して敷地を画面外へ
  await f.gesture([{ x: c.x - 30, y: c.y }, { x: c.x + 30, y: c.y }], [{ x: c.x - 150, y: c.y }, { x: c.x + 150, y: c.y }]);
  await f.gesture([{ x: c.x, y: c.y }, { x: c.x + 40, y: c.y }], [{ x: c.x + 200, y: c.y + 200 }, { x: c.x + 240, y: c.y + 200 }]);
  // 全体表示：敷地が図面エリア内に収まる
  await page.getByTestId('zoom-fit').tap();
  const cv = await box(page, '[data-testid="canvas"]');
  const site = await box(page, '[data-pid="site"]');
  expect(site.x).toBeGreaterThanOrEqual(cv.x - 1);
  expect(site.y).toBeGreaterThanOrEqual(cv.y - 1);
  expect(site.x + site.width).toBeLessThanOrEqual(cv.x + cv.width + 1);
  expect(site.y + site.height).toBeLessThanOrEqual(cv.y + cv.height + 1);

  // 最大化：ヘッダー・メニューが消え、図面エリアが広がる
  const before = cv.width * cv.height;
  await page.getByTestId('maximize').tap();
  await expect(page.getByTestId('back-home')).toHaveCount(0);
  await page.waitForTimeout(350);
  const cv2 = await box(page, '[data-testid="canvas"]');
  const vw = page.viewportSize()!;
  expect(cv2.width * cv2.height).toBeGreaterThan(before);
  expect(cv2.width * cv2.height).toBeGreaterThanOrEqual(vw.width * vw.height * 0.99);
  await page.getByTestId('maximize').tap();
  await expect(page.getByTestId('back-home')).toBeVisible();

  // パネルを開いてパネル内をスクロール → 図面は動かない
  await page.getByTestId('mtab-land').tap();
  const sheet = page.getByTestId('sheet-scroll');
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(400); // シートの開閉アニメーション完了を待つ
  const site0 = await box(page, '[data-pid="site"]');
  const s0 = await scale(page);
  const sb = await sheet.boundingBox();
  const sc0 = await sheet.evaluate((el) => el.scrollTop);
  const scrollable = await sheet.evaluate((el) => el.scrollHeight > el.clientHeight + 10);
  await f.gesture([{ x: sb!.x + sb!.width / 2, y: sb!.y + sb!.height * 0.8 }], [{ x: sb!.x + sb!.width / 2, y: sb!.y + sb!.height * 0.2 }], 12);
  await page.waitForTimeout(300);
  const sc1 = await sheet.evaluate((el) => el.scrollTop);
  if (scrollable) expect(sc1).toBeGreaterThan(sc0); // パネルが内容より高い端末（iPad）ではスクロール自体が不要
  const site1 = await box(page, '[data-pid="site"]');
  expect(await scale(page)).toBeCloseTo(s0, 4);
  expect(Math.abs(site1.x - site0.x) + Math.abs(site1.y - site0.y)).toBeLessThan(1);
  const vp = await page.evaluate(() => ({ s: window.visualViewport?.scale ?? 1, y: window.scrollY }));
  expect(vp).toEqual({ s: 1, y: 0 });
});
