import fs from 'node:fs/promises';

const required = ['PORT', 'DB_FILE', 'JWT_SECRET', 'OWNER_NAME', 'OWNER_EMAIL', 'OWNER_PASSWORD'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required by the E2E server harness.`);
}
process.env.NODE_ENV = 'production';
process.env.AI_PROVIDER = 'local';
delete process.env.CORS_ORIGIN;

await fs.rm(process.env.DB_FILE, { force: true });
await import('../server/index.js');
