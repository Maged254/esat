require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false, checkServerIdentity: () => undefined } : false
});
async function run() {
  const res = await pool.query(`SELECT * FROM audit_documents WHERE audit_id = 'd788c84d-3823-4a32-8613-c167b348362b'`);
  console.log('Rows found:', res.rows.length);
  console.log(res.rows);
  await pool.end();
}
run().catch(console.error);
