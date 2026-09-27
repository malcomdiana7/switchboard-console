let accessToken = sessionStorage.getItem('accessToken');
let refreshPromise: Promise<boolean> | null = null;
export function setToken(token: string | null) {
  accessToken = token;
  if (token) sessionStorage.setItem('accessToken', token);
  else sessionStorage.removeItem('accessToken');
}
async function refresh() {
  if (!refreshPromise)
    refreshPromise = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) return false;
        setToken((await r.json()).accessToken);
        return true;
      })
      .finally(() => (refreshPromise = null));
  return refreshPromise;
}
export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });
  if (response.status === 401 && retry && (await refresh())) return api(path, init, false);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message ?? `HTTP ${response.status}`);
    Object.assign(error, body.error ?? {});
    throw error;
  }
  return body;
}
export function hasToken() {
  return !!accessToken;
}
export function getToken() {
  return accessToken;
}
export function decodeRole() {
  try {
    return JSON.parse(atob(accessToken!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      .role as string;
  } catch {
    return null;
  }
}
