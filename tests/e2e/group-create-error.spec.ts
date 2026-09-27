import { expect, test } from '@playwright/test';

test('建群账号未在线时显示可操作的错误提示', async ({ page }) => {
  const payload = Buffer.from(JSON.stringify({ role: 'admin' })).toString('base64url');
  await page.addInitScript((token) => {
    sessionStorage.setItem('accessToken', token);
    localStorage.setItem('language', 'zh');
  }, `header.${payload}.signature`);
  await page.route('**/api/groups', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 422,
        json: {
          error: {
            code: 'ACCOUNT_NOT_ONLINE',
            message: 'All accounts must be online',
            requestId: 'test-request',
          },
        },
      });
    }
    return route.fulfill({ json: [] });
  });

  await page.goto('/groups');
  await page.getByRole('button', { name: '创建群组' }).click();

  await expect(page.getByRole('alert')).toContainText('请先在账号页面连接群主及所有成员账号');
});
