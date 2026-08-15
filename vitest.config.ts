import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Vitest does not read .env the way Next.js does, so the test process would
 * start with no JWT_SECRET and every token it signs would throw. This loads
 * .env directly so tests sign with the same secret the running server verifies
 * against — if the two ever diverge, every authenticated test 401s.
 */
function envFromDotenv(): Record<string, string> {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return {};

  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip surrounding quotes — .env.example wraps values in double quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    env: envFromDotenv(),
  },
});
