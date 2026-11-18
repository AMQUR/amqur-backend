import { test, expect, type Page } from '@playwright/test';

/**
 * Workflow Studio journeys against the disposable API test stack (seeded pilot-alpha tenant,
 * users created by test/suites/workflow-lab.e2e-spec.ts or the studio seed script).
 * Authors and reviewers are different users: separation of duties is enforced by the server.
 */
const PW = 'TestPass123!';
const stamp = Date.now().toString(36);

async function signIn(page: Page, email: string) {
  await page.goto('/cc/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Email')).toBeVisible();
}
async function openStudio(page: Page) {
  await page.goto('/cc/#/workflows');
  await expect(page.getByRole('heading', { name: 'Workflow Studio' })).toBeVisible();
}
async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe.configure({ mode: 'serial' });
const wfName = `Warranty answers ${stamp}`;

test('author creates a workflow, sees validation, saves, reloads, and submits for review', async ({ page }) => {
  await signIn(page, 'rev1@pilot-alpha.test');
  await openStudio(page);
  await page.getByLabel('Name').fill(wfName);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This graph passes all checks' })).toBeVisible();

  // Break an edge: validation names the step, save is blocked.
  await page.getByRole('button', { name: /^search —/ }).click();
  await page.getByLabel('Next step').selectOption('');
  const issues = page.getByRole('list', { name: 'Validation issues' });
  await expect(issues).toContainText('Choose where this step goes next');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();

  // Fix it and change the limit; keyboard selection of a diagram node works too.
  await page.getByLabel('Next step').selectOption('check');
  await page.getByLabel('Maximum sources (1–5)').fill('5');
  const node = page.getByRole('button', { name: /^check, Branch/ });
  await node.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('If none were found, go to')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Changes' })).toContainText('search');
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible();

  // Persisted across a full reload.
  await page.reload();
  await openStudio(page);
  await page.getByRole('button', { name: wfName }).click();
  await page.getByRole('button', { name: /^search —/ }).click();
  await expect(page.getByLabel('Maximum sources (1–5)')).toHaveValue('5');

  // Dry run is explicitly non-acting and reports a trace.
  await page.getByRole('button', { name: 'Run dry run' }).click();
  await expect(page.getByRole('region', { name: 'Dry run result' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Trace' })).toContainText('start');

  await page.getByRole('button', { name: 'Request review' }).click();
  await expect(page.getByRole('group', { name: 'Review decision' })).toBeVisible();
  await expect(page.getByLabel('Name')).toBeDisabled();

  // Separation of duties: the requester cannot approve their own draft.
  await page.getByRole('button', { name: 'Approve and publish' }).click();
  await expect(page.getByRole('alert')).toContainText(/independent|Reviewer must/i);
  await signOut(page);
});

test('independent reviewer approves; run suspends; a third party decides it; rollback needs review', async ({ page }) => {
  await signIn(page, 'rev2@pilot-alpha.test');
  await openStudio(page);
  await page.getByRole('button', { name: wfName }).click();
  await page.getByRole('button', { name: 'Approve and publish' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Approved and published' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Versions' })).toContainText('v1');

  // Start a run of the published version. With no published knowledge it must stop for a human.
  await page.getByLabel('Question', { exact: true }).last().fill('warranty on used cars');
  await page.getByRole('button', { name: 'Run published version' }).click();
  const detail = page.getByRole('region', { name: 'Run detail' });
  await expect(detail).toContainText('SUSPENDED');
  await expect(detail).toContainText('You started this run');
  await expect(detail.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await signOut(page);

  await signIn(page, 'rev1@pilot-alpha.test');
  await openStudio(page);
  await page.getByRole('button', { name: wfName }).click();
  await page.getByRole('list', { name: 'Runs' }).getByRole('button').first().click();
  await page.getByRole('region', { name: 'Run detail' }).getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('region', { name: 'Run detail' })).toContainText('COMPLETED');
  await expect(page.getByRole('list', { name: 'Run steps' })).toContainText('human_decision');

  // Publish v2 (rev1 edits, rev2 reviews) and then request a rollback: it opens a review, never publishes.
  await page.getByRole('button', { name: 'Start new draft' }).click();
  await page.getByRole('button', { name: /^search —/ }).click();
  await page.getByLabel('Maximum sources (1–5)').fill('2');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible();
  await page.getByRole('button', { name: 'Request review' }).click();
  await signOut(page);
  await signIn(page, 'rev2@pilot-alpha.test');
  await openStudio(page);
  await page.getByRole('button', { name: wfName }).click();
  await page.getByRole('button', { name: 'Approve and publish' }).click();
  await expect(page.getByRole('list', { name: 'Versions' })).toContainText('v2');
  await page.getByRole('button', { name: 'Request rollback to this version' }).click();
  await expect(page.getByRole('group', { name: 'Review decision' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Versions' })).not.toContainText('v3');
});

test('ordinary staff do not see the Studio and cannot open it directly', async ({ page }) => {
  await signIn(page, 'staff@pilot-alpha.test');
  await expect(page.getByRole('link', { name: 'Workflow Studio' })).toHaveCount(0);
  await page.goto('/cc/#/workflows');
  await expect(page.getByRole('heading', { name: 'Workflow Studio' })).toHaveCount(0);
});
