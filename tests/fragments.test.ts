import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000';

const token = (userId: string) =>
  jwt.sign({ sub: userId, email: `${userId}@test.local` }, process.env.JWT_SECRET!, {
    expiresIn: '1h',
  });

let alice: string;
let bob: string;
let pngBytes: Buffer;

beforeAll(async () => {
  alice = token('alice');
  bob = token('bob');
  // compressionLevel: 0 is load-bearing, not decoration.
  //
  // Built with sharp's defaults this image is 95 bytes, and re-encoding it
  // through sharp at those same defaults reproduces all 95 byte for byte. The
  // identity-conversion test below would then pass whether or not convert()
  // short-circuits - verified by deleting the short-circuit and watching it
  // stay green. Stored uncompressed the fixture is 289 bytes, which a default
  // round trip collapses to 95, so the comparison has something to catch.
  pngBytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
});

async function create(auth: string, type: string, body: BodyInit) {
  const res = await fetch(`${BASE}/api/fragments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': type },
    body,
  });
  const json = await res.json();
  return { res, json };
}

describe('health', () => {
  it('reports ok and a reachable database', async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('reachable');
  });
});

describe('authentication', () => {
  it('rejects a request with no token', async () => {
    const res = await fetch(`${BASE}/api/fragments`);
    expect(res.status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    const res = await fetch(`${BASE}/api/fragments`, {
      headers: { Authorization: 'Bearer not-a-real-jwt' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ sub: 'alice' }, 'wrong-secret');
    const res = await fetch(`${BASE}/api/fragments`, {
      headers: { Authorization: `Bearer ${forged}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/fragments', () => {
  it('creates a fragment and returns 201 with a Location header', async () => {
    const { res, json } = await create(alice, 'text/plain', 'hello fragments');
    expect(res.status).toBe(201);
    expect(json.fragment.type).toBe('text/plain');
    expect(json.fragment.size).toBe(15);
    expect(json.fragment.ownerId).toBe('alice');
    expect(res.headers.get('location')).toBe(`/api/fragments/${json.fragment.id}`);
  });

  it('rejects an unsupported content type with 415', async () => {
    const { res } = await create(alice, 'application/x-tar', 'nope');
    expect(res.status).toBe(415);
  });

  it('rejects an empty body with 400', async () => {
    const { res } = await create(alice, 'text/plain', '');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/fragments/[id]', () => {
  it('returns the original bytes with the original content type', async () => {
    const { json } = await create(alice, 'text/markdown', '# Title');
    const res = await fetch(`${BASE}/api/fragments/${json.fragment.id}`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toBe('# Title');
  });

  it('returns 404 for an id that does not exist', async () => {
    const res = await fetch(`${BASE}/api/fragments/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    expect(res.status).toBe(404);
  });

  /**
   * ==========================================================================
   * THE TEST THAT MATTERS.
   *
   * Alice creates a fragment. Bob asks for it by id. Bob must get 404.
   *
   * 200 here would mean cross-user data exposure. 403 would be a smaller bug
   * but still a leak — it confirms the id exists, which is all an enumerator
   * needs. The only correct answer is "as far as Bob is concerned, this does
   * not exist."
   * ==========================================================================
   */
  it("does not let one user read another user's fragment", async () => {
    const { json } = await create(alice, 'text/plain', 'alice private data');

    const res = await fetch(`${BASE}/api/fragments/${json.fragment.id}`, {
      headers: { Authorization: `Bearer ${bob}` },
    });

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('alice private data');
  });

  it("does not let one user overwrite another user's fragment", async () => {
    const { json } = await create(alice, 'text/plain', 'original');

    const put = await fetch(`${BASE}/api/fragments/${json.fragment.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${bob}`, 'Content-Type': 'text/plain' },
      body: 'overwritten by bob',
    });
    expect(put.status).toBe(404);

    const check = await fetch(`${BASE}/api/fragments/${json.fragment.id}`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    expect(await check.text()).toBe('original');
  });

  it("does not let one user delete another user's fragment", async () => {
    const { json } = await create(alice, 'text/plain', 'keep me');

    const del = await fetch(`${BASE}/api/fragments/${json.fragment.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bob}` },
    });
    expect(del.status).toBe(404);

    const check = await fetch(`${BASE}/api/fragments/${json.fragment.id}`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    expect(check.status).toBe(200);
  });
});

describe('conversion', () => {
  it('converts markdown to html', async () => {
    const { json } = await create(alice, 'text/markdown', '# Hello');
    const res = await fetch(`${BASE}/api/fragments/${json.fragment.id}.html`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<h1>Hello</h1>');
  });

  it('serves a fragment as its own type without erroring', async () => {
    const { json } = await create(alice, 'text/markdown', '# Same');
    const res = await fetch(`${BASE}/api/fragments/${json.fragment.id}.md`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# Same');
  });

  /**
   * Checks the BYTES, not the header.
   *
   * A Content-Type header is a claim the server makes about itself. Asserting
   * on it only proves the server is internally consistent, including when it
   * is consistently wrong. The magic bytes are the evidence: 'RIFF' at offset
   * 0 and 'WEBP' at offset 8 mean an actual WebP came back.
   *
   * This is the same distinction as testing an API response versus testing the
   * row it wrote.
   */
  it('converts png to webp and returns real webp bytes', async () => {
    const { json } = await create(alice, 'image/png', new Uint8Array(pngBytes));
    const res = await fetch(`${BASE}/api/fragments/${json.fragment.id}.webp`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    expect(res.status).toBe(200);

    const out = Buffer.from(await res.arrayBuffer());
    expect(out.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(out.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('returns the original bytes untouched for an identity conversion', async () => {
    const { json } = await create(alice, 'image/png', new Uint8Array(pngBytes));
    const res = await fetch(`${BASE}/api/fragments/${json.fragment.id}.png`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    const out = Buffer.from(await res.arrayBuffer());
    // Byte-identical: proves we short-circuit instead of re-encoding through
    // sharp, which would silently degrade the image while still "working".
    expect(out.equals(pngBytes)).toBe(true);
  });

  it('rejects an impossible conversion with 415', async () => {
    const { json } = await create(alice, 'image/png', new Uint8Array(pngBytes));
    const res = await fetch(`${BASE}/api/fragments/${json.fragment.id}.json`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    expect(res.status).toBe(415);
  });
});

describe('PUT and DELETE', () => {
  it('updates data and refuses to change type', async () => {
    const { json } = await create(alice, 'text/plain', 'v1');

    const ok = await fetch(`${BASE}/api/fragments/${json.fragment.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'text/plain' },
      body: 'v2 is longer',
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).fragment.size).toBe(12);

    const bad = await fetch(`${BASE}/api/fragments/${json.fragment.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'text/markdown' },
      body: '# nope',
    });
    expect(bad.status).toBe(400);
  });

  it('deletes a fragment and 404s on the second attempt', async () => {
    const { json } = await create(alice, 'text/plain', 'temporary');
    const id = json.fragment.id;

    expect((await fetch(`${BASE}/api/fragments/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice}` },
    })).status).toBe(200);

    expect((await fetch(`${BASE}/api/fragments/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice}` },
    })).status).toBe(404);
  });
});

describe('GET /api/fragments (list)', () => {
  it("lists only the calling user's fragments", async () => {
    const { json: mine } = await create(alice, 'text/plain', 'alice item');
    await create(bob, 'text/plain', 'bob item');

    const res = await fetch(`${BASE}/api/fragments`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    const body = await res.json();
    expect(body.fragments).toContain(mine.fragment.id);

    const bobRes = await fetch(`${BASE}/api/fragments`, {
      headers: { Authorization: `Bearer ${bob}` },
    });
    expect((await bobRes.json()).fragments).not.toContain(mine.fragment.id);
  });

  it('returns full metadata with expand=1 and never returns blob data', async () => {
    await create(alice, 'text/plain', 'expandable');
    const res = await fetch(`${BASE}/api/fragments?expand=1`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    const body = await res.json();
    expect(body.fragments[0]).toHaveProperty('type');
    expect(body.fragments[0]).toHaveProperty('size');
    expect(body.fragments[0]).not.toHaveProperty('data');
  });
});
