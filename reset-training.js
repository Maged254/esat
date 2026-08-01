#!/usr/bin/env node
/*
 * reset-training.js — wipe the Training module's TRIAL data.
 *
 * The training tables are fully additive and isolated: nothing else in ESAT
 * references them, so clearing or dropping them cannot affect employees,
 * casuals, audits, PPE, NCRs or any existing data. This script is the
 * "reset the training backend once we're confident" step — run it deliberately
 * to clear trial data before real use or a real migration.
 *
 * Usage (from the esat2/ directory, with DATABASE_URL set — same env the
 * backend uses; e.g. `DATABASE_URL=... node reset-training.js --yes`):
 *
 *   node reset-training.js --yes          Clear all training_records (the trial
 *                                         requests). Keeps the 10 seeded course
 *                                         definitions. This is the usual reset.
 *
 *   node reset-training.js --all --yes    Drop training_records, training_courses
 *                                         and users.training_course_access
 *                                         entirely. The backend recreates them
 *                                         empty + re-seeds the 10 courses on its
 *                                         next boot (setupDB runs on startup).
 *
 * The --yes flag is required so the script can never wipe data by accident.
 * It touches ONLY training_* objects — never any other table.
 */
require('dotenv').config();
const { Pool } = require('pg');

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const dropAll = args.includes('--all');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Refusing to run.');
  process.exit(1);
}

if (!confirmed) {
  console.log('This will ' + (dropAll
    ? 'DROP the training_courses and training_records tables and the users.training_course_access column.'
    : 'clear ALL training_records (trial training requests). Course definitions are kept.'));
  console.log('Nothing was changed. Re-run with --yes to actually perform the reset.');
  process.exit(0);
}

// Always negotiate SSL: this script is meant to run against the remote Render
// database, which requires it. (Matches the backend's production Pool.)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL.split('?')[0],
  ssl: { rejectUnauthorized: false, checkServerIdentity: () => undefined },
});

(async () => {
  const client = await pool.connect();
  try {
    if (dropAll) {
      // CASCADE handles the training_records → training_courses FK ordering.
      await client.query('DROP TABLE IF EXISTS training_records CASCADE');
      await client.query('DROP TABLE IF EXISTS training_courses CASCADE');
      await client.query('ALTER TABLE users DROP COLUMN IF EXISTS training_course_access');
      console.log('✓ Dropped training_records, training_courses and users.training_course_access.');
      console.log('  They will be recreated empty and re-seeded on the next backend deploy/boot.');
    } else {
      const { rowCount } = await client.query('SELECT 1 FROM information_schema.tables WHERE table_name = $1', ['training_records']);
      if (rowCount === 0) {
        console.log('training_records does not exist yet — nothing to clear.');
      } else {
        const before = await client.query('SELECT COUNT(*)::int AS n FROM training_records');
        await client.query('TRUNCATE TABLE training_records');
        console.log(`✓ Cleared ${before.rows[0].n} training_records. The 10 course definitions are untouched.`);
      }
    }
  } catch (e) {
    console.error('Reset failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
