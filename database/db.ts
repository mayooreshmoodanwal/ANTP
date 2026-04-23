import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local from project root
dotenv.config({ path: resolve(__dirname, "../.env.local") });

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.local.example to .env.local and fill in your Neon connection string.\n" +
      "Get one free at https://neon.tech → Dashboard → Connection Details."
  );
}

/**
 * Neon serverless HTTP driver.
 * Uses HTTP-based queries — no persistent connection needed.
 * Ideal for serverless and burst-traffic patterns.
 */
const sql = neon(DATABASE_URL);

/**
 * Drizzle ORM instance with full schema typing.
 * All queries through this instance are type-safe.
 */
export const db = drizzle(sql, { schema });

export { schema };
export type Database = typeof db;
