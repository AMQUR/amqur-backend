import { test, expect } from '@playwright/test';

/**
 * CRM Workforce smoke against a local API serving /cc with the synthetic demo seed
 * (`npm run seed:crm-workforce-demo`). Credentials come from the environment, never Git:
 *   CC_URL=http://127.0.0.1:3411 CRMWF_DEMO_EMAIL=… CRMWF_DEMO_PASSWORD=… npx playwright test crm-workforce
 */
const email = process.env.CRMWF_DEMO_EMAIL;
const password = process.env.CRMWF_DEMO_PASSWORD;

test.skip(!email || !password, 'CRMWF_DEMO_EMAIL / CRMWF_DEMO_PASSWORD not set');

test('CRM Workforce shows honest states, blocked connectors, and a working kill switch', async ({ page }) => {
  await page.goto('/cc/');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'CRM Workforce' }).click();
  await expect(page.getByRole('heading', { name: 'CRM Workforce' })).toBeVisible();

  // Demo data is labelled, and customer sending is stated as off.
  await expect(page.getByText('DEMO DATA — synthetic records')).toBeVisible();
  await expect(page.getByText('Customer sending: OFF')).toBeVisible();

  // Drafts explain in plain words why the system cannot send them.
  await page.getByRole('tab', { name: 'Draft approvals' }).click();
  await expect(page.getByText('The system cannot send this.').first()).toBeVisible();
  await expect(page.getByText('Communication policy has not been approved by counsel').first()).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/@example\.invalid|\+1312555/);

  // Queues: escalations and consent review are visible.
  await page.getByRole('tab', { name: 'Conversations and queues' }).click();
  await page.getByRole('button', { name: 'Human handoffs' }).click();
  await expect(page.getByRole('table')).toContainText(/escalated/);
  await page.getByRole('button', { name: 'Consent review' }).click();
  await expect(page.getByRole('table')).toContainText(/consent review required/);

  // Tekion connectors are shown as blocked and offer no Connect button.
  await page.getByRole('tab', { name: 'CRM connections and workers' }).click();
  for (const name of ['Tekion APC (authorized API)', 'Tekion CRM (authorized browser operations)']) {
    const card = page.locator('section.card', { hasText: name });
    await expect(card).toContainText('blocked');
    await expect(card.getByRole('button', { name: 'Connect' })).toHaveCount(0);
  }

  // Kill switch: stop, see it, resume.
  await page.getByRole('button', { name: 'Stop this rooftop now' }).click();
  await expect(page.getByText('This rooftop is stopped.')).toBeVisible();
  await page.getByRole('tab', { name: 'Modes and kill switches' }).click();
  await expect(page.locator('tr', { hasText: 'Whole rooftop' })).toContainText('stopped');
  await page.getByRole('button', { name: 'Resume this rooftop' }).click();
  await expect(page.getByText('This rooftop is resumed.')).toBeVisible();

  // Compliance and audit record what just happened.
  await page.getByRole('tab', { name: 'Compliance' }).click();
  await expect(page.getByText('Only the customer can undo this')).toBeVisible();
  await page.getByRole('tab', { name: 'Audit ledger' }).click();
  await expect(page.getByRole('table')).toContainText('control changed');
});
