# Fragments v2

[![CI](https://github.com/Akshar210606/fragments-next/actions/workflows/ci.yml/badge.svg)](https://github.com/Akshar210606/fragments-next/actions/workflows/ci.yml)

A versioned REST API that stores text and image fragments and converts them between formats
on the fly, persisting only the original bytes.

Rebuilt from [fragments](https://github.com/Akshar210606/fragments) (Node/Express, DynamoDB, S3)
onto **Next.js, TypeScript and PostgreSQL**.

**Stack:** Next.js 15 (App Router) · TypeScript · PostgreSQL 16 · Prisma · React 19 · Tailwind · Vitest · Playwright · Docker Compose · GitHub Actions

---

## Quick start

```bash
npm install
cp .env.example .env
docker compose up -d db
npx prisma migrate dev --name init
npm run dev
```

Open http://localhost:3000. Sign in with any username to get a development token, then create
and convert fragments from the browser.

Run the tests:

```bash
npm test          # 21 API integration tests (needs the dev server running)
npm run test:e2e  # 11 browser tests (starts its own dev server)
```

---

## API

All `/api/fragments` routes require `Authorization: Bearer <token>`.

| Method | Route | Behaviour |
|---|---|---|
| `POST` | `/api/fragments` | Create from the raw request body. `Content-Type` sets the fragment type. `201` + `Location`. |
| `GET` | `/api/fragments` | List the caller's fragment IDs. `?expand=1` returns full metadata. |
| `GET` | `/api/fragments/:id` | Original bytes, original `Content-Type`. |
| `GET` | `/api/fragments/:id.:ext` | Converted bytes. `415` if the conversion isn't supported. |
| `PUT` | `/api/fragments/:id` | Replace data. `Content-Type` must match the existing type. |
| `DELETE` | `/api/fragments/:id` | Delete. `404` if it doesn't exist or isn't yours. |
| `GET` | `/api/health` | Service status, including a real database round-trip. |
| `POST` | `/api/auth/dev-token` | Development only. Disabled when `NODE_ENV=production`. |

**Supported types:** `text/plain`, `text/markdown`, `text/html`, `application/json`,
`image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/avif`

**Conversions:** Markdown → HTML or plain text; JSON and HTML → plain text; any image → any
other image. Every type converts to itself. HTML → Markdown is deliberately *not* supported —
it would silently drop markup that Markdown cannot express, and a conversion that quietly loses
content is worse than an honest `415`.

---

## Design decisions

These are the parts worth being able to explain.

### Ownership is enforced in the query, not after the fetch

```ts
// what this codebase does
await prisma.fragment.findFirst({ where: { id, ownerId: user.id } });

// what it deliberately avoids
const f = await prisma.fragment.findUnique({ where: { id } });
if (f.ownerId !== user.id) return notFound();
```

Both behave identically today. The second is a latent data leak: the day someone adds an early
return above the check, reorders the branches, or copies the fetch into a new handler without
bringing the guard along, the check is gone. Nothing throws and nothing fails a build — the
endpoint just returns `200` with another user's data.

Pushing the constraint into the `where` clause means no code path can read a row the caller
isn't entitled to. `PUT` and `DELETE` use `updateMany`/`deleteMany` for the same reason: the
single-record variants only accept a unique field, which would force the ownership check back
out into application code.

Another user's fragment returns `404`, not `403`. `403` confirms the ID exists, which is all an
enumerator needs.

### Only the original is ever stored

Conversion happens on read, never on write. Converting on write would discard the original, and
conversions are lossy — a user who uploads a PNG and later wants that PNG back would get whatever
it was re-encoded into.

The identity conversion (`.png` on a PNG) short-circuits and returns the stored bytes untouched.
Without that early return, the image would still be round-tripped through `sharp`, silently
recompressing it. The response would look completely correct — right status, right `Content-Type`,
a valid image — while being quietly worse than what was uploaded.

### One table instead of two stores

v1 split metadata into DynamoDB and blobs into S3. This version puts both in one Postgres row,
which buys transactional consistency: in v1 a write could succeed in DynamoDB and fail in S3,
leaving metadata pointing at a blob that doesn't exist.

The honest tradeoff is that Postgres isn't object storage — large blobs in rows hurt scans and
backups. At real scale the right answer is metadata in Postgres and blobs in S3, with the write
ordered so a failure leaves an orphaned blob (harmless) rather than orphaned metadata (broken).

### Auth wraps the handler

`withAuth` takes `user` as a required argument to the wrapped handler, so TypeScript won't allow
a handler that ignores authentication. A guard you have to remember to call is a guard someone
eventually forgets to call.

Failed verification returns a single generic `401` regardless of cause. Distinguishing expired
from malformed from wrong-signature mostly helps someone probing the token format.

### 415 vs 400

`400` means the request was malformed. `415` means the request was fine but the media type isn't
handled. Returning `400` for an unsupported type sends the caller looking for a syntax error that
isn't there.

---

## Tests

Two suites that fail for different reasons.

`tests/fragments.test.ts` — **21 API integration tests** covering authentication, CRUD,
conversion and per-user isolation, called directly against the running server.

`e2e/fragments.spec.ts` — **11 Playwright browser tests** driving the real UI in Chromium.
The API suite proves the endpoints behave. This one proves those guarantees survive the trip
through a browser, which is a different failure: an endpoint can be correct while the page
renders someone else's data, or renders nothing at all.

Nothing the API suite already covers is repeated here. A second copy of "an unauthenticated
request gets `401`" costs a browser launch and proves nothing new, so the browser suite only
contains tests that go through the UI or that cross two genuinely separate browser sessions.

Every spec mints its own username and deletes its own rows in an `afterEach`, so the suite passes
in any order, runs `fullyParallel`, and leaves the database exactly as it found it.

### Four worth reading

**Cross-user isolation, at the API layer.** Alice creates a fragment, Bob requests it, Bob must
get `404`. There are three of these — read, overwrite, delete — because each verb needs its own
proof.

**PNG → WebP checks the bytes, not the header.** It asserts `RIFF` at offset 0 and `WEBP` at
offset 8. A `Content-Type` header is a claim the server makes about itself; asserting on it only
proves the server is internally consistent, including when it is consistently wrong.

**Identity conversion, and the fixture that made the test a no-op.** Requesting a stored PNG as
`.png` must return the stored bytes rather than round-tripping through sharp, which re-encodes and
silently degrades. The browser test writes the response to a file and compares it against the
original byte for byte.

That test was worthless for a subtler reason than the isolation one below. The fixture was built
with `sharp().png()` at default settings, and re-encoding it through sharp *at those same defaults*
reproduces all 95 bytes exactly — so the comparison passed whether or not the short-circuit
existed. Found by deleting the short-circuit and watching the test stay green. The fixture is now
written with `compressionLevel: 0`, which stores 289 bytes that a default round trip collapses to
95, and the assertion has something to catch.

The API suite had the same fixture bug in its own identity-conversion test, found the same way and
fixed the same way. Both suites now build the fixture with an encoder setting their own encoder
will not reproduce, so both fail when the short-circuit is removed.

**Cross-user isolation, in the browser — and the version of it that was worthless.** The obvious
way to write this test is to sign in as Bob and assert the page reads `Nothing yet.` That test
passes against a build with the ownership constraint deliberately removed, which is how I found
out it was worthless. The page renders its empty state *before* the list request comes back, so
Playwright's auto-retrying assertion matches that first frame and returns green whether or not
the fetch later fills the list with Alice's data.

The test now has Bob create his own fragment first, then asserts he has exactly one list item and
that Alice's fragment id appears zero times on his page. Both assertions fail if isolation breaks.

**Two isolated sessions, going after each other's data by URL.** This is the spec the suite exists
for, and it is described in full in the next section.

The general lesson, and the reason this is in the README: a test suite nobody has watched fail is
a suite nobody should trust. Every guard-testing spec here was verified by removing the constraint
it guards and confirming it went red — the ownership filter on the list query, the ownership filter
on `GET /api/fragments/[id]`, the owner in `deleteMany`, and the identity short-circuit in
`convert()`. Two of the four only started failing after the test itself was fixed.

---

## What the isolation spec proves

`a second browser session cannot read another user's fragment by URL` is the one to read.

Alice signs in through the form in one `browser.newContext()` and creates a fragment. Bob signs in
through the form in a second, entirely separate context — its own cookies, its own storage, a
genuinely different visitor rather than the same session renamed. Bob then goes after Alice's
fragment by its URL.

The spec asserts three things, and it needs all three:

1. **A drive-by navigation is refused outright — `401`, and none of Alice's content on the page.**
   Identity here is a bearer token held in React state; there is no cookie and no session. So
   pointing a browser at `/api/fragments/<id>` sends no credentials at all. This leg documents
   that, and it is also why the obvious version of this test is a trap: asserting `404` on a raw
   navigation asserts on a request that was never *Bob's*, and would pass just as happily against
   a build with no ownership filter whatsoever.

2. **Bob's own credentials get `404` — never `403`.** `403` would confirm the id exists, which is
   all an enumerator needs. Asserted explicitly, so that "fixing" it to `403` later fails loudly.

3. **Alice still gets `200` and her exact bytes.** Without this leg, leg 2 proves nothing: deleting
   the fragment outright would also produce a `404`. This is what makes the denial in leg 2 a real
   denial rather than the trivial `404` any unknown id returns.

The companion spec does the same across the delete verb: Bob's `DELETE` against Alice's fragment
returns `404` and the row survives, then Alice's own delete removes it from her list and the id
`404`s afterwards. Both fail if the owner is dropped from the `where` clause.

---

## Running the test suites

```bash
docker compose up -d db
npx prisma migrate dev

npm run dev          # terminal 1
npm test             # terminal 2 - 21 API tests against the running server
```

Playwright manages its own server, so it needs nothing running first:

```bash
npm run test:e2e     # 11 browser tests
npm run test:e2e:ui  # same, in Playwright's UI mode
```

**Why the browser suite runs against `next dev` and not a production build.** Signing in goes
through `/api/auth/dev-token`, which returns `404` when `NODE_ENV=production` — deliberately,
because an endpoint that mints a token for any username you name is a complete authentication
bypass and must not exist in a deployed environment. Pointing the browser suite at `npm start`
fails every authenticated test with a `404` that has nothing to do with the code under test. The
vitest suite is the one that exercises the production artifact.

`e2e/global-setup.ts` compiles every route once before the suite starts. Without it, `next dev`
charges the first test that touches a route for compiling it, which reads as a timeout on tests 1
and 2 while everything after them passes in seconds.

---

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, as **two parallel
jobs**, each with its own PostgreSQL 16 service container. Nothing merges unless both pass.

| Job | Runs |
|---|---|
| `verify` | `npm ci` → `prisma migrate deploy` → `lint` → `typecheck` → `build` → API suite against the production server |
| `e2e` | `npm ci` → `prisma migrate deploy` → `playwright install chromium` → browser suite against `next dev` |

They used to be one job, and the browser suite had to run *before* the production build, because
it needs the dev server — sign-in goes through `/api/auth/dev-token`, which `404`s in production by
design — and a shared runner meant a shared port 3000. That ordering worked, but it was a
constraint the pipeline was carrying on behalf of a problem it did not need to have.

Separate runners give each suite its own database and its own port 3000, so neither can be broken
by the other's server, and they fail independently: "the browser suite went red" and "the API suite
went red" are different problems and are now different red X's.

On failure the `e2e` job uploads **both** `playwright-report/` and `test-results/`. The report is
the readable summary; `test-results/` is where the traces actually live. The previous version
uploaded only the report, so the traces the config was diligently recording never left the runner —
a trace you cannot download is a trace you do not have. `trace` is set to `retain-on-failure`
rather than `on-first-retry` for the same reason: with `retries: 1` in CI, a trace you can only get
by failing twice is no use when the second attempt passes.

## Project layout

```
src/
  app/
    page.tsx                     React client - login, list, create, convert, delete
    layout.tsx
    api/
      health/route.ts            status + database round-trip
      auth/dev-token/route.ts    dev-only token minting
      fragments/route.ts         POST create, GET list
      fragments/[id]/route.ts    GET (+conversion), PUT, DELETE
  lib/
    db.ts                        Prisma client singleton
    auth.ts                      withAuth wrapper, token signing
    convert.ts                   conversion table, convert(), id/extension parsing
prisma/schema.prisma
tests/fragments.test.ts          21 API integration tests (vitest)
e2e/
  fragments.spec.ts              11 browser tests (Playwright)
  global-setup.ts                warms every route before the suite starts
playwright.config.ts
.github/workflows/ci.yml
```
