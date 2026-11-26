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

  // Today: the employee's queue opens first, most urgent queue first.
  await expect(page.getByRole('button', { name: /Unanswered customer messages/ })).toBeVisible();
  const customers = page.getByRole('list', { name: 'Customers' });
  await expect(customers).toBeVisible();
  await customers.getByRole('button').first().click();
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(page.getByText('Nothing is sent from here.')).toBeVisible();
  // No phone number or email is ever shown, only the last four digits.
  await expect(page.locator('main')).not.toContainText(/@example\.invalid|\+1312555/);

  // An appointment is a request for staff, and says so.
  const when = new Date(Date.now() + 3 * 86_400_000);
  when.setHours(11, 0, 0, 0);
  const local = new Date(when.getTime() - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.getByLabel('Requested time').fill(local);
  await page.getByRole('button', { name: 'Request appointment' }).click();
  await expect(page.getByText('Appointment request created.')).toBeVisible();
  await page.getByRole('tab', { name: 'Appointments and follow-ups' }).click();
  const item = page.locator('tr', { hasText: 'Appointment request' }).first();
  await expect(item).toContainText('requested');
  await expect(item).not.toContainText(/confirmed|booked/i);
  // "Done in the CRM" needs the CRM's own reference.
  await expect(item.getByRole('button', { name: 'Done in the CRM' })).toBeDisabled();

  // Lead recovery: every row says whether anything forbids contact.
  await page.getByRole('tab', { name: 'Lead recovery' }).click();
  await page.getByRole('button', { name: /90–119 days old/ }).click();
  await expect(page.getByRole('table')).toContainText(/needs consent review|suppressed|eligible/);

  // Imports are gated on a recorded authorisation.
  await page.getByRole('tab', { name: 'Data imports' }).click();
  await expect(page.getByText(/CRM export connection is not switched on/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview' })).toBeDisabled();

  // Roster: eighteen roles, none shown as running while the engine is off.
  await page.getByRole('tab', { name: 'AI workforce' }).click();
  await expect(page.getByText('Group AI Operations Director')).toBeVisible();
  await expect(page.locator('section.card', { hasText: 'Workforce roster' }).locator('tbody tr')).toHaveCount(18);
  await expect(page.locator('section.card', { hasText: 'Workforce roster' })).not.toContainText(/\brunning\b/);

  // Automation queue: escalations and consent review are visible.
  await page.getByRole('tab', { name: 'Automation queue' }).click();
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
