import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';

export type AuthedUser = { id: string; email: string };

type Handler<C = unknown> = (
  req: NextRequest,
  user: AuthedUser,
  ctx: C
) => Promise<NextResponse> | NextResponse;

function secret(): string {
  const s = process.env.JWT_SECRET;
  // Fail loudly at request time rather than silently verifying against
  // undefined. A missing secret is a deployment error, not a 401.
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

/**
 * Wraps a route handler so it only ever runs for an authenticated caller.
 *
 * The wrapped handler takes `user` as a required argument, so TypeScript will
 * not let you write a handler that ignores authentication. The design goal is
 * to make the unsafe version impossible to express, rather than relying on
 * every future contributor remembering to call a guard.
 */
export function withAuth<C = unknown>(handler: Handler<C>) {
  return async (req: NextRequest, ctx: C): Promise<NextResponse> => {
    const header = req.headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!token) {
      return NextResponse.json(
        { status: 'error', error: { code: 401, message: 'Missing bearer token' } },
        { status: 401 }
      );
    }

    let user: AuthedUser;
    try {
      const claims = jwt.verify(token, secret()) as jwt.JwtPayload;
      if (!claims.sub) throw new Error('no subject claim');
      user = { id: String(claims.sub), email: String(claims.email ?? '') };
    } catch {
      // Deliberately does not distinguish expired from malformed from
      // wrong-signature. Precise auth errors help an attacker probing your
      // token format far more than they help a legitimate caller.
      return NextResponse.json(
        { status: 'error', error: { code: 401, message: 'Invalid token' } },
        { status: 401 }
      );
    }

    return handler(req, user, ctx);
  };
}

/** Mint a token. Used by the dev-token route and by the test suite. */
export function signToken(userId: string, email = `${userId}@example.com`): string {
  return jwt.sign({ sub: userId, email }, secret(), { expiresIn: '24h' });
}
