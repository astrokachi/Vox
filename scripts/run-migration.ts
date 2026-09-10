// Applies pending SQL migrations in drizzle/migrations/ against DATABASE_URL.
// Tracks applied files in a `_migrations` table so re-runs are safe.
// Usage: npm run db:migrate
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = join(process.cwd(), "drizzle/migrations");

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "_migrations" (
      "id" text PRIMARY KEY,
      "applied_at" timestamp DEFAULT now() NOT NULL
    );
  `);

  const { rows } = await pool.query<{ id: string }>(
    `SELECT "id" FROM "_migrations"`,
  );
  const applied = new Set(rows.map((r) => r.id));

  const files = listMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log("No pending migrations.");
    process.exit(0);
  }

  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`Applying migration: ${file}`);

    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO "_migrations" ("id") VALUES ($1)`, [file]);
      console.log(`Applied: ${file}`);
    } catch (err) {
      console.error(`Failed on ${file}`);
      throw err;
    }
  }

  console.log(`Done. Applied ${pending.length} migration(s).`);
} catch (err) {
  console.error("Migration failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
