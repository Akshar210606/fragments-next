import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { withAuth, type AuthedUser } from '@/lib/auth';
import { isSupportedType } from '@/lib/convert';

const META = {
  id: true,
  ownerId: true,
  type: true,
  size: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * POST /api/fragments
 * Body: raw bytes. The Content-Type header decides how they are interpreted.
 * -> 201 with the created fragment's metadata and a Location header.
 */
export const POST = withAuth(async (req: NextRequest, user: AuthedUser) => {
  const contentType = req.headers.get('content-type')?.split(';')[0].trim() ?? '';

  // 415, not 400. The request was well-formed; we simply do not handle this
  // media type. 400 would tell the caller to go looking for a syntax error
  // that isn't there.
  if (!isSupportedType(contentType)) {
    return NextResponse.json(
      { status: 'error', error: { code: 415, message: `Unsupported type: ${contentType}` } },
      { status: 415 }
    );
  }

  const buffer = Buffer.from(await req.arrayBuffer());
  if (buffer.length === 0) {
    return NextResponse.json(
      { status: 'error', error: { code: 400, message: 'Empty body' } },
      { status: 400 }
    );
  }

  const fragment = await prisma.fragment.create({
    data: {
      // From the verified token, never from the request payload. If ownerId
      // came from the body, any caller could create a fragment owned by
      // someone else — the write-side half of the isolation problem.
      ownerId: user.id,
      type: contentType,
      size: buffer.length,
      data: buffer,
    },
    select: META,
  });

  return NextResponse.json(
    { status: 'ok', fragment },
    { status: 201, headers: { Location: `/api/fragments/${fragment.id}` } }
  );
});

/**
 * GET /api/fragments          -> { status, fragments: [id, id, ...] }
 * GET /api/fragments?expand=1 -> { status, fragments: [ {metadata}, ... ] }
 */
export const GET = withAuth(async (req: NextRequest, user: AuthedUser) => {
  const expand = req.nextUrl.searchParams.get('expand') === '1';

  // Note `data` is absent from both branches. Including the blobs would make
  // this response scale with total stored bytes rather than fragment count —
  // a user with 500 images would pull hundreds of megabytes to render what is
  // supposed to be a list of IDs.
  const where = { ownerId: user.id };
  const orderBy = { createdAt: 'desc' } as const;

  // Two separate queries rather than one with `select: expand ? META : {...}`.
  // Prisma derives the row type from the select object, so a conditional select
  // collapses the result into a union and every field access degrades to `any`.
  // Branching keeps each call's select literal, so `rows` is precisely typed
  // and the compiler can actually check the `.id` below.
  if (expand) {
    const rows = await prisma.fragment.findMany({ where, orderBy, select: META });
    return NextResponse.json({ status: 'ok', fragments: rows });
  }

  const rows: { id: string }[] = await prisma.fragment.findMany({
    where,
    orderBy,
    select: { id: true },
  });
  return NextResponse.json({ status: 'ok', fragments: rows.map((r) => r.id) });
});
