import { expect, test } from '@playwright/test';

test('管理员登录后能在群详情看到 Agent Run 步骤', async ({ page, request }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('admin');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/accounts/);

  for (let index = 0; index < 2; index += 1) {
    const connect = page.getByRole('button', { name: '连接' }).first();
    await expect(connect).toBeVisible();
    await connect.click();
    await expect(page.getByText('online')).toHaveCount(index + 1);
  }

  await page.getByRole('link', { name: '群组' }).click();
  await page.getByLabel('群主账号').fill('account-01');
  await page.getByLabel('成员账号（逗号分隔）').fill('account-02');
  await page.getByRole('button', { name: '创建群组' }).click();
  const groupLink = page.getByText(/^grp-/).first();
  await expect(groupLink).toBeVisible({ timeout: 20_000 });
  await groupLink.click();

  const gatewayGroupId = (await page.locator('h4').textContent())!;
  await page.getByRole('button', { name: 'Agent OFF' }).click();
  await expect(page.getByRole('button', { name: 'Agent ON' })).toBeVisible();

  await request.post('http://localhost:4100/__control/message', {
    data: {
      groupId: gatewayGroupId,
      senderPlatformUserId: 'external-e2e-user',
      text: '请处理这条端到端测试消息',
    },
  });

  const runLink = page.locator('a[href^="/agent-runs/"]').first();
  await expect(runLink).toBeVisible({ timeout: 20_000 });
  await runLink.click();
  await expect(page.getByText(/#1 · tool_use/)).toBeVisible({ timeout: 20_000 });
});
