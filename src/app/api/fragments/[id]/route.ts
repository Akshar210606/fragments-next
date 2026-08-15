import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { withAuth, type AuthedUser } from '@/lib/auth';
import { EXT_TO_TYPE, canConvert, convert, parseIdAndExt, validTargets } from '@/lib/convert';

type Ctx = { params: Promise<{ id: string }> };

const notFound = () =>
  NextResponse.json(
    { status: 'error', error: { code: 404, message: 'Fragment not found' } },
    { status: 404 }
  );

/**
 * GET /api/fragments/[id]        -> original bytes, original Content-Type
 * GET /api/fragments/[id].[ext]  -> converted bytes, converted Content-Type
 *
 * ---------------------------------------------------------------------------
 * THE IMPORTANT PART: ownership is enforced in the WHERE clause.
 *
 *     where: { id, ownerId: user.id }
 *
 * The alternative — fetch by id, then compare ownerId and return 404 — behaves
 * identically today and is a latent data leak. The moment someone adds an early
 * return above the check, reorders the branches, or copies the fetch into a new
 * handler without bringing the guard along, the check is gone. Nothing throws.
 * Nothing fails a build. The endpoint returns 200 with another user's data.
 *
 * Pushing the constraint into the query means there is no code path that reads
 * a row you are not entitled to. The unsafe version cannot be written by
 * accident, only on purpose.
 *
 * 404 rather than 403 for another user's fragment: 403 confirms the id exists,
 * which hands an enumerator a working oracle.
 * ---------------------------------------------------------------------------
 */
export const GET = withAuth(async (_req: NextRequest, user: AuthedUser, ctx: Ctx) => {
  const { id: raw } = await ctx.params;
  const { id, ext } = parseIdAndExt(raw);

  const fragment = await prisma.fragment.findFirst({
    where: { id, ownerId: user.id },
  });
  if (!fragment) return notFound();

  const original = Buffer.from(fragment.data);

  if (!ext) {
    return new NextResponse(new Uint8Array(original), {
      status: 200,
      headers: { 'Content-Type': fragment.type, 'Content-Length': String(original.length) },
    });
  }

  const target = EXT_TO_TYPE[ext];
  if (!canConvert(fragment.type, target)) {
    return NextResponse.json(
      {
        status: 'error',
        error: {
          code: 415,
          message: `Cannot convert ${fragment.type} to ${target}`,
          supported: validTargets(fragment.type),
        },
      },
      { status: 415 }
    );
  }

  const converted = await convert(original, fragment.type, target);
  return new NextResponse(new Uint8Array(converted.data), {
    status: 200,
    headers: {
      'Content-Type': converted.type,
      'Content-Length': String(converted.data.length),
    },
  });
});

/**
 * PUT /api/fragments/[id] — replace a fragment's data.
 * The type is fixed at creation; a mismatched Content-Type is a 400.
 */
export const PUT = withAuth(async (req: NextRequest, user: AuthedUser, ctx: Ctx) => {
  const { id: raw } = await ctx.params;
  const { id } = parseIdAndExt(raw);

  const existing = await prisma.fragment.findFirst({
    where: { id, ownerId: user.id },
    select: { id: true, type: true },
  });
  if (!existing) return notFound();

  const contentType = req.headers.get('content-type')?.split(';')[0].trim() ?? '';
  if (contentType !== existing.type) {
    return NextResponse.json(
      {
        status: 'error',
        error: {
          code: 400,
          message: `Type cannot change. Fragment is ${existing.type}, received ${contentType}`,
        },
      },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await req.arrayBuffer());
  if (buffer.length === 0) {
    return NextResponse.json(
      { status: 'error', error: { code: 400, message: 'Empty body' } },
      { status: 400 }
    );
  }

  // updateMany with the owner in the where clause, not update({ where: { id } }).
  // `update` targets a unique field only, so the ownership constraint could not
  // live in the query and would have to be a separate check — reintroducing
  // exactly the gap the GET handler avoids. The count tells us it applied.
  const result = await prisma.fragment.updateMany({
    where: { id, ownerId: user.id },
    data: { data: buffer, size: buffer.length },
  });
  if (result.count === 0) return notFound();

  const fragment = await prisma.fragment.findFirst({
    where: { id, ownerId: user.id },
    select: { id: true, ownerId: true, type: true, size: true, createdAt: true, updatedAt: true },
  });

  return NextResponse.json({ status: 'ok', fragment });
});

/**
 * DELETE /api/fragments/[id]
 *
 * Not idempotent by choice: deleting an already-deleted fragment returns 404,
 * not 204. The caller asked us to delete something that does not exist, and
 * saying so is more useful than pretending it worked. A client that wants
 * idempotent behaviour can treat 404 as success.
 */
export const DELETE = withAuth(async (_req: NextRequest, user: AuthedUser, ctx: Ctx) => {
  const { id: raw } = await ctx.params;
  const { id } = parseIdAndExt(raw);

  const result = await prisma.fragment.deleteMany({ where: { id, ownerId: user.id } });
  if (result.count === 0) return notFound();

  return NextResponse.json({ status: 'ok' });
});
