import { test } from '@playwright/test';
import fs from 'node:fs';
test('shots', async ({ page }, info) => {
  await page.goto('./');
  await page.screenshot({ path: `/tmp/shots/${info.project.name}-home0.png` });
  await page.getByTestId('home-new').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/shots/${info.project.name}-land.png` });
  const tab = info.project.name === 'iphone' ? 'mtab-parking' : 'tab-parking';
  await page.getByTestId(tab).click();
  await page.getByTestId('run-optimize').click();
  await page.getByTestId('apply-A案').click({ timeout: 60000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/shots/${info.project.name}-parking-cad.png` });
  await page.getByTestId('mode-proposal').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/tmp/shots/${info.project.name}-proposal.png` });
  if (info.project.name === 'desktop') {
    await page.getByTestId('tab-output').click();
    const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-pdf').click()]);
    fs.copyFileSync((await pdf.path())!, '/tmp/shots/out.pdf');
    await page.getByTestId('back-home').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `/tmp/shots/desktop-home.png` });
  }
});
