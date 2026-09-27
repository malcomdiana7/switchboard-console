import { expect, test } from '@playwright/test';

test('阿拉伯语布局中导航在右侧且内容不重叠或溢出', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 529 });
  const payload = Buffer.from(JSON.stringify({ role: 'admin' })).toString('base64url');
  await page.addInitScript((token) => {
    sessionStorage.setItem('accessToken', token);
    localStorage.setItem('language', 'ar');
    localStorage.setItem('theme', 'dark');
  }, `header.${payload}.signature`);
  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      json: ['01', '02', '03', '04'].map((suffix) => ({
        id: `account-${suffix}`,
        status: 'idle',
        platformUserId: null,
        rateLimitedUntil: null,
      })),
    }),
  );
  await page.route('**/api/groups', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sequences', (route) => route.fulfill({ json: [] }));

  await page.goto('/accounts');
  await expect(page.getByRole('heading', { name: 'الحسابات' })).toBeVisible();

  const drawer = await page.locator('.MuiDrawer-paper').boundingBox();
  const main = await page.locator('main').boundingBox();
  expect(drawer).not.toBeNull();
  expect(main).not.toBeNull();
  expect(drawer!.x).toBeGreaterThan(650);
  expect(main!.x + main!.width).toBeLessThanOrEqual(drawer!.x + 1);
  expect(await page.getByText('مسؤول', { exact: true }).count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.goto('/groups');
  await expect(page.getByRole('heading', { name: 'المجموعات' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.goto('/sequences');
  await expect(page.getByRole('heading', { name: 'التسلسلات المجدولة' })).toBeVisible();
  await expect(page.getByLabel('متغيرات JSON')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByLabel('خطوات JSON')).toHaveAttribute('dir', 'ltr');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
