import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { clearPrivateCaches } from '../client/lib/auth.js';

const originalCaches = globalThis.caches;

afterEach(() => {
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
});

test('legacy private API caches are deleted on app startup/logout', async () => {
  const deleted = [];
  globalThis.caches = {
    async keys() { return ['api-cache', 'private-api-owner', 'workbox-precache-v2-safe']; },
    async delete(name) { deleted.push(name); return true; },
  };
  await clearPrivateCaches();
  assert.deepEqual(deleted.sort(), ['api-cache', 'private-api-owner']);
});

test('PWA configuration contains no API runtime caching strategy', async () => {
  const config = await fs.readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /NetworkFirst/);
  assert.doesNotMatch(config, /cacheName:\s*['"]api-cache/);
  assert.match(config, /navigateFallbackDenylist/);

  const apiClient = await fs.readFile(new URL('../client/lib/api.js', import.meta.url), 'utf8');
  assert.match(apiClient, /cache:\s*['"]no-store/);
});
