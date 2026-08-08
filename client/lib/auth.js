const TOKEN_KEY = 'esk_token';
const USER_KEY = 'esk_user';

export function setAuth(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser() {
  try {
    const u = localStorage.getItem(USER_KEY);
    return u ? JSON.parse(u) : null;
  } catch {
    return null;
  }
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  void clearPrivateCaches();
}

// Removes cache names used by older releases that cached /api responses.
// Current service workers cache static build assets only.
export async function clearPrivateCaches() {
  if (!('caches' in globalThis)) return;
  const names = await globalThis.caches.keys();
  await Promise.all(
    names
      .filter(name => name === 'api-cache' || name.startsWith('private-api-'))
      .map(name => globalThis.caches.delete(name)),
  );
}
