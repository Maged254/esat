const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://esat_db_user:9AevHBmGWfJJxn7WLzJlWvFO4EiQQDRd@dpg-d8cuafuk1jcs73a7u67g-a.frankfurt-postgres.render.com/esat_db',
  ssl: { rejectUnauthorized: false, checkServerIdentity: () => undefined }
});
async function run() {
  const res = await pool.query(`SELECT * FROM audit_documents WHERE audit_id = 'd788c84d-3823-4a32-8613-c167b348362b'`);
  console.log('Rows found:', res.rows.length);
  console.log(res.rows);
  await pool.end();
}
run().catch(console.error);
