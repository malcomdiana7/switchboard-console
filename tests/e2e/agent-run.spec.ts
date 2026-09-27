import { expect, test } from '@playwright/test';

test('管理员登录后能在群详情看到 Agent Run 步骤', async ({ page, request }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('admin');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/accounts/);

  for (const accountId of ['account-01', 'account-02']) {
    const row = page.getByRole('row').filter({ hasText: accountId });
    await expect(row).toBeVisible();
    const connect = row.getByRole('button', { name: '连接' });
    if (await connect.isVisible()) await connect.click();
    await expect(row.getByText('online')).toBeVisible();
  }

  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' && response.url().endsWith('/api/groups'),
    ),
    page.getByRole('link', { name: '群组' }).click(),
  ]);
  const existingGroupHrefs = new Set(
    await page.locator('a[href^="/groups/"]').evaluateAll((links) =>
      links.map((link) => link.getAttribute('href')).filter((href): href is string => href !== null),
    ),
  );
  await page.getByLabel('群主账号').fill('account-01');
  await page.getByLabel('成员账号（逗号分隔）').fill('account-02');
  await page.getByRole('button', { name: '创建群组' }).click();
  let newGroupHref: string | undefined;
  await expect
    .poll(async () => {
      const hrefs = await page.locator('a[href^="/groups/"]').evaluateAll((links) =>
        links.map((link) => link.getAttribute('href')).filter((href): href is string => href !== null),
      );
      newGroupHref = hrefs.find((href) => !existingGroupHrefs.has(href));
      return newGroupHref;
    }, { timeout: 20_000 })
    .toBeTruthy();
  await page.locator(`a[href="${newGroupHref}"]`).click();

  const groupHeading = page.getByRole('heading', { level: 4, name: /^grp-/ });
  await expect(groupHeading).toBeVisible();
  const gatewayGroupId = (await groupHeading.textContent())!;
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
