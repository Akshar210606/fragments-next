import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * Browser-level tests for Fragments v2.
 *
 * The vitest suite covers the API. This suite covers the claim the API cannot
 * make on its own: that a person using the app in a browser sees the right
 * thing, and — more importantly — never sees somebody else's.
 *
 * Every test mints its own username. The database persists between runs, so
 * sharing a fixed "alice" would mean each run inherits the previous run's
 * fragments and the empty-state assertions would start failing on the second
 * run for reasons that have nothing to do with the code.
 */

const newUser = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;

/** Signs in through the actual form rather than injecting a token. */
async function signIn(page: Page, user: string) {
  await page.goto('/');
  await page.getByPlaceholder('username').fill(user);
  await page.getByRole('button', { name: 'Get token' }).click();
  await expect(page.getByText(`Signed in as`)).toBeVisible();
  await expect(page.getByText(user, { exact: true })).toBeVisible();
}

/** Creates a fragment through the form and waits for it to reach the list. */
async function createFragment(page: Page, type: string, body: string) {
  await page.locator('select').selectOption(type);
  await page.locator('textarea').fill(body);
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('listitem').filter({ hasText: type })).toBeVisible();
}

/** Mints a token via the dev endpoint, for the API-level checks. */
async function tokenFor(request: APIRequestContext, user: string): Promise<string> {
  const res = await request.post('/api/auth/dev-token', { data: { user } });
  expect(res.status()).toBe(200);
  return (await res.json()).token as string;
}

test.describe('signing in', () => {
  test('a new user starts with an empty fragment list', async ({ page }) => {
    await signIn(page, newUser('empty'));
    await expect(page.getByText('Nothing yet.')).toBeVisible();
    await expect(page.getByText('Your fragments (0)')).toBeVisible();
  });
});

test.describe('creating and reading fragments', () => {
  test('creates a markdown fragment and shows it in the list', async ({ page }) => {
    await signIn(page, newUser('create'));
    const body = '# Hello from Playwright';

    await createFragment(page, 'text/markdown', body);

    const item = page.getByRole('listitem').filter({ hasText: 'text/markdown' });
    await expect(item).toBeVisible();
    // Byte length, not character count - the UI reports what the server stored.
    await expect(item).toContainText(`${Buffer.byteLength(body)} bytes`);
    await expect(page.getByText('Your fragments (1)')).toBeVisible();
  });

  test('shows the original text when raw is clicked', async ({ page }) => {
    await signIn(page, newUser('raw'));
    const body = '# Raw preview check';

    await createFragment(page, 'text/markdown', body);
    await page.getByRole('button', { name: 'raw' }).click();

    const preview = page.locator('pre');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(body);
    // Raw means raw: the markdown must not have been rendered on the way out.
    await expect(preview).not.toContainText('<h1>');
  });

  test('converts markdown to HTML on request', async ({ page }) => {
    await signIn(page, newUser('convert'));

    await createFragment(page, 'text/markdown', '# Converted heading');
    await page.getByRole('button', { name: 'as html' }).click();

    const preview = page.locator('pre');
    await expect(preview).toContainText('<h1>');
    await expect(preview).toContainText('Converted heading');
  });

  test('offers the as-html button only for markdown', async ({ page }) => {
    await signIn(page, newUser('plain'));

    await createFragment(page, 'text/plain', 'just plain text');

    const item = page.getByRole('listitem').filter({ hasText: 'text/plain' });
    await expect(item.getByRole('button', { name: 'raw' })).toBeVisible();
    // text/plain cannot become HTML, so the affordance should not be offered.
    await expect(item.getByRole('button', { name: 'as html' })).toHaveCount(0);
  });
});

test.describe('deleting', () => {
  test('removes a fragment from the list', async ({ page }) => {
    await signIn(page, newUser('delete'));

    await createFragment(page, 'text/markdown', '# Doomed');
    await expect(page.getByText('Your fragments (1)')).toBeVisible();

    await page.getByRole('button', { name: 'delete' }).click();

    await expect(page.getByText('Nothing yet.')).toBeVisible();
    await expect(page.getByText('Your fragments (0)')).toBeVisible();
  });
});

test.describe('error handling', () => {
  test('surfaces a server-side rejection in the page rather than failing silently', async ({
    page,
  }) => {
    await signIn(page, newUser('empty-body'));

    await page.locator('select').selectOption('text/markdown');
    await page.locator('textarea').fill('');
    await page.getByRole('button', { name: /^Create/ }).click();

    // The server answers 400 "Empty body". The point of this test is that the
    // user is told, instead of the click appearing to do nothing.
    await expect(page.getByText(/Empty body/i)).toBeVisible();
    await expect(page.getByText('Nothing yet.')).toBeVisible();
  });
});

test.describe('per-user isolation', () => {
  test('one user never sees another user\'s fragments in the browser', async ({ page, browser }) => {
    const alice = newUser('alice');
    const bob = newUser('bob');

    await signIn(page, alice);
    await createFragment(page, 'text/markdown', '# Alice private note');
    await expect(page.getByText('Your fragments (1)')).toBeVisible();

    // The list renders a truncated id, which is the only part of another
    // user's fragment that could visibly leak into this page.
    const aliceIdPrefix = (await page.getByRole('listitem').locator('code').innerText()).trim();
    expect(aliceIdPrefix).toHaveLength(8);

    // A separate browser context: its own cookies and storage, so this is a
    // genuinely different visitor rather than the same session renamed.
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();

    await signIn(bobPage, bob);

    /**
     * Bob creates his own fragment before we assert anything.
     *
     * The obvious version of this test - sign in as Bob and assert "Nothing
     * yet." - is worthless, and it took a deliberately broken build to notice.
     * The page renders the empty state before the list request comes back, so
     * the assertion matches that first frame and passes whether or not the
     * fetch later fills the list with Alice's data.
     *
     * Waiting for Bob to have exactly one fragment removes the race: the list
     * has demonstrably loaded, and the count is a number that a leak would
     * change. Under a broken ownership filter this settles at two.
     */
    await createFragment(bobPage, 'text/plain', 'bob only');

    await expect(bobPage.getByText('Your fragments (1)')).toBeVisible();
    await expect(bobPage.getByRole('listitem')).toHaveCount(1);
    await expect(bobPage.getByRole('listitem')).toContainText('text/plain');
    await expect(bobPage.locator('code', { hasText: aliceIdPrefix })).toHaveCount(0);

    await bobContext.close();
  });

  test('another user\'s fragment id returns 404, never 403', async ({ request }) => {
    const aliceToken = await tokenFor(request, newUser('alice-api'));
    const bobToken = await tokenFor(request, newUser('bob-api'));

    const created = await request.post('/api/fragments', {
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'text/plain' },
      data: 'alice owns this',
    });
    expect(created.status()).toBe(201);
    const id = (await created.json()).fragment.id as string;

    // Alice can read it back.
    const asAlice = await request.get(`/api/fragments/${id}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(asAlice.status()).toBe(200);

    const asBob = await request.get(`/api/fragments/${id}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });

    // 404 rather than 403 is the deliberate choice: 403 would confirm the id
    // exists, handing an enumerator a working oracle. Asserted explicitly so
    // that "fixing" it to 403 later fails loudly.
    expect(asBob.status()).toBe(404);
    expect(asBob.status()).not.toBe(403);
  });

  test('rejects a request carrying no token at all', async ({ request }) => {
    const res = await request.get('/api/fragments');
    expect(res.status()).toBe(401);
  });
});
