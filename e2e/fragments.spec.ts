import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

/**
 * Browser-level tests for Fragments v2.
 *
 * The vitest suite covers the API. This suite covers the claim the API cannot
 * make on its own: that a person using the app in a browser sees the right
 * thing, and — more importantly — never sees somebody else's.
 *
 * Anything vitest already proves at the API layer is deliberately absent here.
 * A second copy of "an unauthenticated request gets 401" costs a browser launch
 * and proves nothing new. What is here either goes through the UI, or crosses
 * two genuinely separate browser sessions, which is the part vitest cannot do.
 *
 * Every test mints its own username and deletes its own rows afterwards, so the
 * specs pass in any order, in parallel, and on a database that already has data
 * in it from previous runs.
 */

/** Usernames this worker has created data for. Drained by the afterEach below. */
const provisioned: string[] = [];

const newUser = (label: string) => {
  const user = `${label}-${randomUUID().slice(0, 8)}`;
  provisioned.push(user);
  return user;
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Mints a token via the dev endpoint, for the checks that cannot go through the UI. */
async function tokenFor(request: APIRequestContext, user: string): Promise<string> {
  const res = await request.post('/api/auth/dev-token', { data: { user } });
  expect(res.status()).toBe(200);
  return (await res.json()).token as string;
}

/** Signs in through the actual form rather than injecting a token. */
async function signIn(page: Page, user: string) {
  await page.goto('/');
  await page.getByTestId('username-input').fill(user);
  await page.getByTestId('signin-button').click();
  await expect(page.getByTestId('current-user')).toHaveText(user);
}

/**
 * Creates a fragment through the form and returns its id.
 *
 * The id comes from the row's data-fragment-id attribute, which is what lets a
 * test address one specific row instead of every "delete" button on the page.
 */
async function createFragment(page: Page, type: string, body: string): Promise<string> {
  const before = await page.getByTestId('fragment-row').count();

  await page.getByTestId('type-select').selectOption(type);
  await page.getByTestId('body-input').fill(body);
  await page.getByTestId('create-button').click();

  await expect(page.getByTestId('fragment-row')).toHaveCount(before + 1);

  // The list is ordered createdAt desc, so the one just created is first.
  const id = await page.getByTestId('fragment-row').first().getAttribute('data-fragment-id');
  expect(id).toBeTruthy();
  return id as string;
}

/** One specific row, by id. */
const rowFor = (page: Page, id: string) => page.locator(`[data-fragment-id="${id}"]`);

/**
 * Deterministic teardown.
 *
 * Unique usernames alone would keep the specs independent, but they would also
 * leave a row behind on every run forever. This deletes what the test made,
 * through the same API a user would, so a failed assertion never leaves the
 * database dirtier than it found it.
 */
test.afterEach(async ({ request }) => {
  for (const user of provisioned.splice(0)) {
    const token = await tokenFor(request, user);
    const res = await request.get('/api/fragments', { headers: auth(token) });
    if (!res.ok()) continue;
    for (const id of (await res.json()).fragments as string[]) {
      await request.delete(`/api/fragments/${id}`, { headers: auth(token) });
    }
  }
});

test.describe('signing in', () => {
  test('a new user starts with an empty fragment list', async ({ page }) => {
    await signIn(page, newUser('empty'));

    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('fragment-count')).toHaveText('Your fragments (0)');
  });
});

test.describe('creating and reading fragments', () => {
  test('creates a markdown fragment and shows it in the list', async ({ page }) => {
    await signIn(page, newUser('create'));
    const body = '# Hello from Playwright';

    const id = await createFragment(page, 'text/markdown', body);

    await expect(rowFor(page, id)).toContainText('text/markdown');
    // Byte length, not character count — the UI reports what the server stored.
    await expect(rowFor(page, id)).toContainText(`${Buffer.byteLength(body)} bytes`);
    await expect(page.getByTestId('fragment-count')).toHaveText('Your fragments (1)');
  });

  test('shows the original text when raw is clicked', async ({ page }) => {
    await signIn(page, newUser('raw'));
    const body = '# Raw preview check';

    const id = await createFragment(page, 'text/markdown', body);
    await rowFor(page, id).getByTestId('view-raw').click();

    const preview = page.getByTestId('preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(body);
    // Raw means raw: the markdown must not have been rendered on the way out.
    await expect(preview).not.toContainText('<h1>');
  });

  test('converts markdown to HTML on request', async ({ page }) => {
    await signIn(page, newUser('convert'));

    const id = await createFragment(page, 'text/markdown', '# Converted heading');
    await rowFor(page, id).getByTestId('view-html').click();

    const preview = page.getByTestId('preview');
    await expect(preview).toContainText('<h1>');
    await expect(preview).toContainText('Converted heading');
  });

  test('offers the as-html button only for markdown', async ({ page }) => {
    await signIn(page, newUser('plain'));

    const id = await createFragment(page, 'text/plain', 'just plain text');

    await expect(rowFor(page, id).getByTestId('view-raw')).toBeVisible();
    // text/plain cannot become HTML, so the affordance should not be offered.
    await expect(rowFor(page, id).getByTestId('view-html')).toHaveCount(0);
  });

  /**
   * Identity conversion, asserted on the file that came back.
   *
   * This one does not go through the form, and that is a property of the app
   * rather than a shortcut: the type picker offers four text types, and the
   * preview reads responses with res.text(), which would mangle binary. There
   * is no UI path that puts a PNG in or gets one out. So the fragment is
   * created and fetched through the browser context's own request API — the
   * browser's network stack, not Node's.
   *
   * What it proves that the header cannot: the bytes on disk are the bytes that
   * went in. A Content-Type of image/png is a claim the server makes about
   * itself, and it stays true even when sharp has quietly re-encoded the image
   * on the way out. Writing the response to a file and comparing it against the
   * original is the only assertion that fails when the identity short-circuit
   * in convert() is removed.
   *
   * On the fixture, which is the whole test:
   *
   * compressionLevel: 0 is not decoration. Built with sharp's defaults, this
   * image is 95 bytes, and re-encoding it through sharp at those same defaults
   * reproduces all 95 byte for byte — so the comparison below passes whether or
   * not the short-circuit exists, and the test proves nothing. Verified by
   * deleting the short-circuit and watching it stay green.
   *
   * Stored uncompressed the fixture is 289 bytes, and a default-settings round
   * trip collapses it to 95. Now the assertion has something to catch.
   */
  test('serves a stored PNG as .png with the original bytes', async ({ browser }, testInfo) => {
    const context = await browser.newContext();
    const token = await tokenFor(context.request, newUser('png'));

    const original = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const created = await context.request.post('/api/fragments', {
      headers: { ...auth(token), 'Content-Type': 'image/png' },
      data: original,
    });
    expect(created.status()).toBe(201);
    const id = (await created.json()).fragment.id as string;

    const res = await context.request.get(`/api/fragments/${id}.png`, { headers: auth(token) });
    expect(res.status()).toBe(200);

    const file = testInfo.outputPath('roundtrip.png');
    await writeFile(file, await res.body());
    const downloaded = await readFile(file);

    // The PNG signature, then every remaining byte.
    expect(downloaded.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(downloaded.equals(original)).toBe(true);

    await context.close();
  });
});

test.describe('deleting', () => {
  test('removes a fragment from the list', async ({ page }) => {
    await signIn(page, newUser('delete'));

    const id = await createFragment(page, 'text/markdown', '# Doomed');
    await expect(page.getByTestId('fragment-count')).toHaveText('Your fragments (1)');

    await rowFor(page, id).getByTestId('delete-fragment').click();

    await expect(rowFor(page, id)).toHaveCount(0);
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('fragment-count')).toHaveText('Your fragments (0)');
  });
});

test.describe('error handling', () => {
  test('surfaces a server-side rejection in the page rather than failing silently', async ({
    page,
  }) => {
    await signIn(page, newUser('empty-body'));

    await page.getByTestId('type-select').selectOption('text/markdown');
    await page.getByTestId('body-input').fill('');
    await page.getByTestId('create-button').click();

    // The server answers 400 "Empty body". The point of this test is that the
    // user is told, instead of the click appearing to do nothing.
    await expect(page.getByTestId('error')).toContainText(/Empty body/i);
    await expect(page.getByTestId('empty-state')).toBeVisible();
  });
});

test.describe('per-user isolation', () => {
  test("one user never sees another user's fragments in the browser", async ({ page, browser }) => {
    await signIn(page, newUser('alice-list'));
    const aliceId = await createFragment(page, 'text/markdown', '# Alice private note');
    await expect(page.getByTestId('fragment-count')).toHaveText('Your fragments (1)');

    // A separate browser context: its own cookies and storage, so this is a
    // genuinely different visitor rather than the same session renamed.
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await signIn(bobPage, newUser('bob-list'));

    /**
     * Bob creates his own fragment before we assert anything.
     *
     * The obvious version of this test — sign in as Bob and assert "Nothing
     * yet." — is worthless, and it took a deliberately broken build to notice.
     * The page renders the empty state before the list request comes back, so
     * the assertion matches that first frame and passes whether or not the
     * fetch later fills the list with Alice's data.
     *
     * Waiting for Bob to have exactly one fragment removes the race: the list
     * has demonstrably loaded, and the count is a number that a leak would
     * change. Under a broken ownership filter this settles at two.
     */
    await createFragment(bobPage, 'text/plain', 'bob only');

    await expect(bobPage.getByTestId('fragment-count')).toHaveText('Your fragments (1)');
    await expect(bobPage.getByTestId('fragment-row')).toHaveCount(1);
    await expect(bobPage.getByTestId('fragment-row')).toContainText('text/plain');
    await expect(rowFor(bobPage, aliceId)).toHaveCount(0);

    await bobContext.close();
  });

  /**
   * ==========================================================================
   * THE ONE THAT MATTERS.
   *
   * Two isolated browser sessions. Alice creates a fragment; Bob goes after it
   * by URL and must be told it does not exist.
   *
   * A note on what "navigate directly to its URL" can actually mean here.
   * Identity in this app is a bearer token held in React state — there is no
   * cookie and no session. So a raw address-bar navigation carries no
   * credentials at all and is answered 401, by anyone, for any id. Asserting
   * 404 on that navigation would be asserting on a request that was never
   * Bob's; it would pass just as happily against a build with no ownership
   * filter whatsoever. That is the same trap as the "Nothing yet." assertion
   * above, and it is why this test checks all three legs:
   *
   *   1. the drive-by navigation is refused outright (401, no content),
   *   2. Bob's own credentials get 404 — never 403, which would confirm the
   *      id exists and hand an enumerator a working oracle,
   *   3. Alice still gets 200 and her bytes, so leg 2's 404 is a real denial
   *      rather than the trivial 404 any unknown id would produce.
   *
   * Leg 3 is what makes the test worth having. Without it, deleting the
   * fragment outright would also make this test pass.
   * ==========================================================================
   */
  test("a second browser session cannot read another user's fragment by URL", async ({
    browser,
  }) => {
    const secret = '# Alice private note, not for Bob';
    const alice = newUser('alice-read');
    const bob = newUser('bob-read');

    const aliceContext = await browser.newContext();
    const alicePage = await aliceContext.newPage();
    await signIn(alicePage, alice);
    const id = await createFragment(alicePage, 'text/markdown', secret);

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await signIn(bobPage, bob);

    // 1. Straight at the URL, no credentials.
    const driveBy = await bobPage.goto(`/api/fragments/${id}`);
    expect(driveBy?.status()).toBe(401);
    await expect(bobPage.getByText(secret)).toHaveCount(0);

    // 2. Bob's own credentials. Same username he signed in with; the dev
    //    endpoint signs by username, so this is Bob asking as Bob.
    const bobToken = await tokenFor(bobContext.request, bob);
    const asBob = await bobContext.request.get(`/api/fragments/${id}`, {
      headers: auth(bobToken),
    });
    expect(asBob.status()).toBe(404);
    expect(asBob.status()).not.toBe(403);
    expect(await asBob.text()).not.toContain(secret);

    // 3. The id is real and the content is intact for its owner.
    const aliceToken = await tokenFor(aliceContext.request, alice);
    const asAlice = await aliceContext.request.get(`/api/fragments/${id}`, {
      headers: auth(aliceToken),
    });
    expect(asAlice.status()).toBe(200);
    expect(await asAlice.text()).toBe(secret);

    await bobContext.close();
    await aliceContext.close();
  });

  test("a second browser session cannot delete another user's fragment", async ({ browser }) => {
    const alice = newUser('alice-del');
    const bob = newUser('bob-del');

    const aliceContext = await browser.newContext();
    const alicePage = await aliceContext.newPage();
    await signIn(alicePage, alice);
    const id = await createFragment(alicePage, 'text/markdown', '# Alice keeps this');

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await signIn(bobPage, bob);

    // DELETE goes through deleteMany with the owner in the where clause, so it
    // matches nothing and reports 404 rather than deleting somebody's data.
    const bobToken = await tokenFor(bobContext.request, bob);
    const bobDelete = await bobContext.request.delete(`/api/fragments/${id}`, {
      headers: auth(bobToken),
    });
    expect(bobDelete.status()).toBe(404);

    // The row is still there, and still Alice's. Checked against the server
    // rather than by reloading her page — the token lives in React state, so a
    // reload would sign her out and prove nothing about the fragment.
    const aliceToken = await tokenFor(aliceContext.request, alice);
    const stillThere = await aliceContext.request.get(`/api/fragments/${id}`, {
      headers: auth(aliceToken),
    });
    expect(stillThere.status()).toBe(200);
    await expect(rowFor(alicePage, id)).toBeVisible();

    // And the owner's own delete does apply, all the way to the list.
    await rowFor(alicePage, id).getByTestId('delete-fragment').click();
    await expect(rowFor(alicePage, id)).toHaveCount(0);
    await expect(alicePage.getByTestId('fragment-count')).toHaveText('Your fragments (0)');

    const gone = await aliceContext.request.get(`/api/fragments/${id}`, {
      headers: auth(aliceToken),
    });
    expect(gone.status()).toBe(404);

    await bobContext.close();
    await aliceContext.close();
  });
});
