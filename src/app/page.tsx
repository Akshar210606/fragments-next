'use client';

import { useEffect, useState, useCallback } from 'react';

type Meta = {
  id: string;
  ownerId: string;
  type: string;
  size: number;
  createdAt: string;
  updatedAt: string;
};

const TYPES = ['text/plain', 'text/markdown', 'text/html', 'application/json'];

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState('demo-user');
  const [fragments, setFragments] = useState<Meta[]>([]);
  const [body, setBody] = useState('# Hello from Fragments v2');
  const [type, setType] = useState('text/markdown');
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const login = async () => {
    setError(null);
    const res = await fetch('/api/auth/dev-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user }),
    });
    const json = await res.json();
    setToken(json.token);
  };

  const load = useCallback(async () => {
    if (!token) return;
    const res = await fetch('/api/fragments?expand=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    setFragments(json.fragments ?? []);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const createFragment = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    const res = await fetch('/api/fragments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
      body,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setError(j?.error?.message ?? `Request failed with ${res.status}`);
    } else {
      await load();
    }
    setBusy(false);
  };

  const view = async (id: string, ext?: string) => {
    if (!token) return;
    setError(null);
    const res = await fetch(`/api/fragments/${id}${ext ? '.' + ext : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setError(j?.error?.message ?? `Request failed with ${res.status}`);
      setPreview(null);
      return;
    }
    setPreview(await res.text());
  };

  const remove = async (id: string) => {
    if (!token) return;
    await fetch(`/api/fragments/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setPreview(null);
    await load();
  };

  return (
    <main className="mx-auto max-w-3xl p-8 font-sans">
      <h1 className="text-2xl font-semibold">Fragments v2</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Next.js · TypeScript · PostgreSQL · Prisma
      </p>

      {!token ? (
        <section
          data-testid="signin-panel"
          className="mt-8 rounded-lg border border-neutral-200 p-5"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Sign in
          </h2>
          <p className="mt-2 text-sm text-neutral-600">
            Development token endpoint. Sign in as two different users in two browser
            profiles to see per-user isolation working.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              data-testid="username-input"
              className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="username"
            />
            <button
              data-testid="signin-button"
              onClick={login}
              className="rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700"
            >
              Get token
            </button>
          </div>
        </section>
      ) : (
        <>
          <p className="mt-6 text-sm text-neutral-600">
            Signed in as{' '}
            <span data-testid="current-user" className="font-semibold">
              {user}
            </span>{' '}
            <button
              data-testid="signout-button"
              onClick={() => setToken(null)}
              className="ml-2 underline"
            >
              sign out
            </button>
          </p>

          <section className="mt-6 rounded-lg border border-neutral-200 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              New fragment
            </h2>
            <select
              data-testid="type-select"
              className="mt-3 rounded border border-neutral-300 px-2 py-1.5 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <textarea
              data-testid="body-input"
              className="mt-3 h-32 w-full rounded border border-neutral-300 p-3 font-mono text-sm"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <button
              data-testid="create-button"
              disabled={busy}
              onClick={createFragment}
              className="mt-2 rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </section>

          {error && (
            <p
              data-testid="error"
              className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {error}
            </p>
          )}

          <section className="mt-6">
            <h2
              data-testid="fragment-count"
              className="text-sm font-semibold uppercase tracking-wide text-neutral-500"
            >
              Your fragments ({fragments.length})
            </h2>
            <ul data-testid="fragment-list" className="mt-3 space-y-2">
              {fragments.map((f) => (
                <li
                  key={f.id}
                  // The full id as an attribute, not as visible text. It is what
                  // lets a test address one specific row's buttons instead of
                  // matching every "delete" on the page, which is a strict-mode
                  // violation the moment a user owns two fragments.
                  data-testid="fragment-row"
                  data-fragment-id={f.id}
                  className="flex flex-wrap items-center gap-3 rounded border border-neutral-200 p-3 text-sm"
                >
                  <code data-testid="fragment-id" className="text-xs text-neutral-500">
                    {f.id.slice(0, 8)}
                  </code>
                  <span data-testid="fragment-type" className="rounded bg-neutral-100 px-2 py-0.5 text-xs">
                    {f.type}
                  </span>
                  <span data-testid="fragment-size" className="text-xs text-neutral-500">
                    {f.size} bytes
                  </span>
                  <span className="ml-auto flex gap-2">
                    <button
                      data-testid="view-raw"
                      onClick={() => view(f.id)}
                      className="underline"
                    >
                      raw
                    </button>
                    {f.type === 'text/markdown' && (
                      <button
                        data-testid="view-html"
                        onClick={() => view(f.id, 'html')}
                        className="underline"
                      >
                        as html
                      </button>
                    )}
                    <button
                      data-testid="delete-fragment"
                      onClick={() => remove(f.id)}
                      className="text-red-600 underline"
                    >
                      delete
                    </button>
                  </span>
                </li>
              ))}
              {fragments.length === 0 && (
                <li data-testid="empty-state" className="text-sm text-neutral-500">
                  Nothing yet.
                </li>
              )}
            </ul>
          </section>

          {preview !== null && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                Preview
              </h2>
              <pre
                data-testid="preview"
                className="mt-2 overflow-auto rounded border border-neutral-200 bg-neutral-50 p-4 text-xs"
              >
                {preview}
              </pre>
            </section>
          )}
        </>
      )}
    </main>
  );
}
