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
npm run test:e2e  # 10 browser tests (starts its own dev server)
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

`e2e/fragments.spec.ts` — **10 Playwright browser tests** driving the real UI in Chromium.
The API suite proves the endpoints behave. This one proves those guarantees survive the trip
through a browser, which is a different failure: an endpoint can be correct while the page
renders someone else's data, or renders nothing at all.

### Three worth reading

**Cross-user isolation, at the API layer.** Alice creates a fragment, Bob requests it, Bob must
get `404`. There are three of these — read, overwrite, delete — because each verb needs its own
proof.

**PNG → WebP checks the bytes, not the header.** It asserts `RIFF` at offset 0 and `WEBP` at
offset 8. A `Content-Type` header is a claim the server makes about itself; asserting on it only
proves the server is internally consistent, including when it is consistently wrong.

**Cross-user isolation, in the browser — and the version of it that was worthless.** The obvious
way to write this test is to sign in as Bob and assert the page reads `Nothing yet.` That test
passes against a build with the ownership constraint deliberately removed, which is how I found
out it was worthless. The page renders its empty state *before* the list request comes back, so
Playwright's auto-retrying assertion matches that first frame and returns green whether or not
the fetch later fills the list with Alice's data.

The test now has Bob create his own fragment first, then asserts he has exactly one list item and
that Alice's ID prefix appears zero times on his page. Both assertions fail if isolation breaks.

The general lesson, and the reason this is in the README: a test suite nobody has watched fail is
a suite nobody should trust. Every isolation test here was verified by removing the constraint it
guards and confirming it went red.

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
npm run test:e2e     # 10 browser tests
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

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, against a real
PostgreSQL 16 service container. Nothing merges unless all of it passes:

`npm ci` → `prisma migrate deploy` → `lint` → `typecheck` → **browser suite** → `build` →
**API suite against the production server**

The browser suite runs *before* the production server exists, and the ordering is the fix rather
than a preference. An earlier version started the production server first and then tried to free
port 3000 so Playwright could start its own — a step that can quietly fail and leave the wrong
server answering, which surfaces as a `404` on sign-in rather than as "the wrong server is
running." Running the dev-server suite first means there is never a process to hunt down.

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
  fragments.spec.ts              10 browser tests (Playwright)
  global-setup.ts                warms every route before the suite starts
playwright.config.ts
.github/workflows/ci.yml
```
