import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, "../.env.local") });

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. See .env.local for instructions."
  );
}

async function runMigrations() {
  console.log("🔄 Running ANTP database migrations...\n");

  const sql = neon(DATABASE_URL!);
  const db = drizzle(sql);

  // Enable pgvector extension (required for RAG embeddings)
  console.log("📦 Enabling pgvector extension...");
  await sql("CREATE EXTENSION IF NOT EXISTS vector");

  // Run Drizzle migrations
  console.log("📦 Running schema migrations...");
  await migrate(db, {
    migrationsFolder: resolve(__dirname, "./migrations"),
  });

  console.log("\n✅ Migrations complete!");
  process.exit(0);
}

runMigrations().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
