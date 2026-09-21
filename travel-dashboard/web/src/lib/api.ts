import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Called when the server says the session is gone, so a session that lapses
 * mid-shift returns the employee to the sign-in screen instead of leaving them
 * clicking through screens that quietly fail.
 */
let onSessionLost: (() => void) | null = null;
export const setSessionLostHandler = (handler: (() => void) | null) => {
  onSessionLost = handler;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    // The session lives in an httpOnly cookie, so it has to ride along.
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    // A failed sign-in is not a lost session — it is someone mistyping.
    if (response.status === 401 && !path.startsWith('/auth/')) onSessionLost?.();
    throw new ApiError(payload?.error ?? `Request failed (${response.status})`, response.status);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: (path: string) => request<void>(path, { method: 'DELETE' }),
};

export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '' && value !== 'all') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

interface Resource<T> {
  data: T | undefined;
  error: string | undefined;
  /** True only on the first load — a refetch keeps the previous render on screen. */
  loading: boolean;
  refetching: boolean;
  reload: () => void;
}

/**
 * Fetches `path` and refetches whenever it changes. Refetches hold the previous
 * data so filtering never flashes a skeleton or jumps the layout. Pass `null`
 * to skip the request entirely when a screen does not need the data.
 */
export function useResource<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadedOnce = useRef(false);

  useEffect(() => {
    if (path === null) {
      setPending(false);
      return;
    }
    let active = true;
    setPending(true);
    api
      .get<T>(path)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(undefined);
        loadedOnce.current = true;
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : 'Something went wrong');
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    data,
    error,
    loading: pending && !loadedOnce.current,
    refetching: pending && loadedOnce.current,
    reload,
  };
}
