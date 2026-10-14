import { test, expect, request } from '@playwright/test';

/**
 * Command Center smoke against a local API serving /cc (disposable test stack, seeded
 * pilot-alpha fixture tenant). Creates a fresh widget conversation, then works it as staff.
 */
const API = process.env.CC_URL || 'http://127.0.0.1:3001';

test('staff can sign in, take over a conversation, reply, and return it to AI', async ({ page }) => {
  // A customer asks for a person via the public widget API.
  const ctx = await request.newContext({ baseURL: API, extraHTTPHeaders: { Origin: 'http://127.0.0.1:18084' } });
  const tok = (await (await ctx.post('/api/public/widget-token', { data: { tenantSlug: 'pilot-alpha', locationSlug: 'main' } })).json()).data.token;
  await ctx.post('/api/chat', { headers: { Authorization: `Bearer ${tok}` }, data: { message: 'Can I talk to a person? cc-smoke' } });

  await page.goto('/cc/');
  await page.getByLabel('Email').fill('admin@pilot-alpha.test');
  await page.getByLabel('Password').fill('TestPass123!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByText('Needs attention')).toBeVisible();

  await page.getByRole('link', { name: 'Inbox' }).click();
  const item = page.getByRole('button', { name: /Customer asked for a person/ }).first();
  await expect(item).toBeVisible();
  await item.click();
  await page.getByRole('button', { name: 'Take over' }).click();
  await page.getByRole('textbox', { name: 'Reply' }).fill('Hi — this is the team, how can I help?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Messages' })).toContainText('this is the team');
  await page.getByRole('textbox', { name: 'Internal note' }).fill('cc smoke internal note');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByRole('list', { name: 'Messages' })).toContainText('Internal note');
  await page.getByRole('button', { name: 'Return to AI' }).click();
  await expect(page.getByRole('button', { name: 'Take over' })).toBeVisible();

  await page.getByRole('link', { name: 'Service · Parts · Finance' }).click();
  await expect(page.getByText(/Out-the-door quotes/)).toBeVisible();
  await page.getByRole('link', { name: 'Knowledge' }).click();
  await expect(page.getByRole('heading', { name: 'Knowledge' })).toBeVisible();
  await page.getByRole('link', { name: 'Rooftop settings' }).click();
  await expect(page.getByText(/Hours/).first()).toBeVisible();
  // Credit destination is write-only: the panel never renders a stored URL.
  await expect(page.getByText('Secure credit application')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/token=/);
  await page.getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByText(/awaiting vendor credentials/i)).toBeVisible();
});

test('/cc is served with a strict CSP and is not indexable', async ({ request: r }) => {
  const res = await r.get('/cc/');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(res.headers()['x-frame-options']).toBe('DENY');
  expect(res.headers()['x-robots-tag']).toContain('noindex');
});
