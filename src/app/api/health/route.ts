import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// Carried over from v1. A health check that only proves the process is alive
// is nearly useless — this one actually round-trips the database, because
// "the app is up but cannot reach Postgres" is the state you need to detect.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: 'ok',
      author: 'Aksharkumar Patel',
      githubUrl: 'https://github.com/Akshar210606/fragments-next',
      version: process.env.npm_package_version ?? '2.0.0',
      db: 'reachable',
    });
  } catch {
    return NextResponse.json({ status: 'error', db: 'unreachable' }, { status: 503 });
  }
}
