import { expect, test } from '@playwright/test';

test('管理员可以创建包含多个步骤的序列', async ({ page }) => {
  const name = `E2E sequence ${Date.now()}`;
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('admin');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('link', { name: '定时序列' }).click();

  await page.getByLabel('序列名称').fill(name);
  await page.getByLabel('步骤 JSON').fill(
    JSON.stringify([
      { index: 1, accountRole: 'admin', text: '{event} starts', delaySeconds: 1 },
      { index: 2, accountRole: 'member', text: '{event} continues', delaySeconds: 1 },
    ]),
  );
  await page.getByRole('button', { name: '创建序列' }).click();

  await expect(page.getByText(name, { exact: true })).toBeVisible();
});
