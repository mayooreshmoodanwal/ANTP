import { defineConfig } from 'drizzle-kit';

// drizzle-kit loads config through esbuild which has compatibility issues
// with ESM dotenv patterns. Use process.env directly — the calling script
// (package.json) loads .env.local before drizzle-kit runs via --env-file.

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is missing.\n' +
    'Run via: npm run db:push (which loads .env.local automatically)\n' +
    'Or: node --env-file=../.env.local node_modules/.bin/drizzle-kit push'
  );
}

export default defineConfig({
  schema: './schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
