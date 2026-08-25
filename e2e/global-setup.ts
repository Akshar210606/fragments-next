/**
 * Warms every route the suite touches before any test runs.
 *
 * `next dev` compiles routes on demand, so the first request to each one pays
 * a compile cost that can run to tens of seconds on a cold cache. Without this,
 * that cost lands inside whichever test happens to touch the route first, and
 * shows up as a timeout on test 1 or 2 while every later test passes in under
 * a second. The tests were never wrong; they were just the ones holding the
 * stopwatch when the compiler ran.
 *
 * Doing the compiling here means a failure is reported as "setup could not
 * reach the app", which is what it actually is, instead of a misleading
 * assertion failure about a missing element.
 *
 * In CI this is nearly free: the server there is a production build, so the
 * routes are already compiled and these are just a handful of fast requests.
 */
const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000';

async function warm(label: string, run: () => Promise<Response>) {
  const started = Date.now();
  const res = await run();
  const ms = Date.now() - started;
  // Anything slower than a second was almost certainly a first compile. Worth
  // seeing in the log so a slow run has a visible explanation.
  if (ms > 1000) console.log(`  warmed ${label} in ${(ms / 1000).toFixed(1)}s`);
  return res;
}

export default async function globalSetup() {
  console.log(`Warming ${BASE} before tests…`);

  await warm('/api/health', () => fetch(`${BASE}/api/health`));
  await warm('/ (page)', () => fetch(BASE));

  const tokenRes = await warm('POST /api/auth/dev-token', () =>
    fetch(`${BASE}/api/auth/dev-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'warmup-only' }),
    })
  );
  if (!tokenRes.ok) {
    throw new Error(
      `Could not reach the app at ${BASE} (dev-token returned ${tokenRes.status}). ` +
        'Is the dev server running and the database up?'
    );
  }
  const { token } = (await tokenRes.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };

  // POST and the dynamic [id] route are separate compilation units from the
  // collection GET, so each needs touching or the cost simply moves.
  const created = await warm('POST /api/fragments', () =>
    fetch(`${BASE}/api/fragments`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: 'warmup',
    })
  );

  await warm('GET /api/fragments', () => fetch(`${BASE}/api/fragments?expand=1`, { headers: auth }));

  if (created.ok) {
    const { fragment } = (await created.json()) as { fragment: { id: string } };
    await warm('GET /api/fragments/[id]', () =>
      fetch(`${BASE}/api/fragments/${fragment.id}`, { headers: auth })
    );
    // Leave nothing behind. The warm-up user is never asserted on, but an
    // orphan row per run would still be litter.
    await fetch(`${BASE}/api/fragments/${fragment.id}`, { method: 'DELETE', headers: auth });
  }

  console.log('Warm-up complete.');
}
