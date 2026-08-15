# Fragments v2

A versioned REST API that stores text and image fragments and converts them between formats
on the fly, persisting only the original bytes.

Rebuilt from [fragments](https://github.com/Akshar210606/fragments) (Node/Express, DynamoDB, S3)
onto **Next.js, TypeScript and PostgreSQL**.

**Stack:** Next.js 15 (App Router) · TypeScript · PostgreSQL 16 · Prisma · React 19 · Tailwind · Vitest · Docker Compose · GitHub Actions

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

Run the tests against a running server:

```bash
npm test
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

`tests/fragments.test.ts` covers authentication, CRUD, conversion and per-user isolation.

Two worth reading:

**Cross-user isolation** — Alice creates a fragment, Bob requests it, Bob must get `404`. There
are three of these (read, overwrite, delete) because each verb needs its own proof.

**PNG → WebP checks the bytes, not the header** — it asserts `RIFF` at offset 0 and `WEBP` at
offset 8. A `Content-Type` header is a claim the server makes about itself; asserting on it only
proves the server is internally consistent, including when it's consistently wrong.

---

## Before you push this to GitHub

I have not been able to run `npm install && npm run build` end to end — my environment couldn't
reach the package registry to completion. **Run this locally first:**

```bash
npm install
npx prisma generate
npm run typecheck
npm run build
docker compose up -d db && npx prisma migrate dev --name init
npm run dev          # in one terminal
npm test             # in another
```

Fix anything that surfaces before the first public commit. Version numbers in `package.json`
may need nudging depending on what's current when you install.

---

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
tests/fragments.test.ts
```
