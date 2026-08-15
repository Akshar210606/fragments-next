import { NextRequest, NextResponse } from 'next/server';
import { signToken } from '@/lib/auth';

/**
 * POST /api/auth/dev-token   { "user": "alice" }
 *
 * Development and test convenience only. v1 used AWS Cognito for real identity;
 * this project deliberately keeps auth local so the interesting parts stay
 * PostgreSQL and Next.js rather than re-integrating an identity provider.
 *
 * Refuses to run in production. An endpoint that mints a token for any username
 * you ask for is a complete authentication bypass, so it must not exist in a
 * deployed environment. Guarding it here means the dangerous path cannot ship
 * even if someone forgets to delete the file.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { status: 'error', error: { code: 404, message: 'Not found' } },
      { status: 404 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const user = typeof body.user === 'string' && body.user.trim() ? body.user.trim() : 'demo-user';

  return NextResponse.json({ status: 'ok', user, token: signToken(user) });
}
