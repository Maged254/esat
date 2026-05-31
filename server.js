require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: "10mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL.split('?')[0],
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false, checkServerIdentity: () => undefined } : false
});

const JWT_SECRET = process.env.JWT_SECRET || 'esat-secret-2026';

// ── Auto-setup database on startup ──────────────────────────
async function setupDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name VARCHAR(150) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(30) NOT NULL DEFAULT 'ehs_officer',
        is_active BOOLEAN DEFAULT TRUE,
        profile_picture TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS employees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_number VARCHAR(20) UNIQUE NOT NULL,
        full_name VARCHAR(150) NOT NULL,
        national_id VARCHAR(30),
        job_title VARCHAR(100),
        department VARCHAR(100),
        project VARCHAR(100),
        client VARCHAR(100),
        organization VARCHAR(100),
        resource_type VARCHAR(20) DEFAULT 'inhouse',
        employment_status VARCHAR(20) DEFAULT 'active',
        exit_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ppe_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(150) NOT NULL,
        category VARCHAR(50) NOT NULL,
        has_size BOOLEAN DEFAULT FALSE,
        size_type VARCHAR(20),
        sort_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS audits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        audited_by UUID NOT NULL REFERENCES users(id),
        audit_date DATE NOT NULL DEFAULT CURRENT_DATE,
        overall_status VARCHAR(20) DEFAULT 'compliant',
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
        ppe_item_id UUID NOT NULL REFERENCES ppe_items(id),
        condition VARCHAR(20) NOT NULL,
        size_value VARCHAR(10),
        comment TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ncr_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        audit_item_id UUID REFERENCES audit_items(id) ON DELETE CASCADE,
        employee_id UUID NOT NULL REFERENCES employees(id),
        ppe_item_id UUID NOT NULL REFERENCES ppe_items(id),
        condition VARCHAR(20) NOT NULL,
        size_value VARCHAR(10),
        comment TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS purchase_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pr_number VARCHAR(30) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'draft',
        created_by UUID NOT NULL REFERENCES users(id),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS purchase_request_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        purchase_request_id UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
        ppe_item_id UUID NOT NULL REFERENCES ppe_items(id),
        size_value VARCHAR(10),
        quantity INTEGER NOT NULL DEFAULT 1,
        unit VARCHAR(20) DEFAULT 'pc',
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ppe_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ncr_item_id UUID REFERENCES ncr_items(id) ON DELETE CASCADE,
        employee_id UUID NOT NULL REFERENCES employees(id),
        ppe_item_id UUID NOT NULL REFERENCES ppe_items(id),
        size_value VARCHAR(10),
        status VARCHAR(30) DEFAULT 'pending',
        date_flagged TIMESTAMPTZ DEFAULT NOW(),
        date_ordered TIMESTAMPTZ,
        date_available TIMESTAMPTZ,
        date_distributed TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS employee_ppe_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        ppe_item_id UUID NOT NULL REFERENCES ppe_items(id) ON DELETE CASCADE,
        UNIQUE(employee_id, ppe_item_id)
      );
    `);

    // Seed PPE items if empty
    const { rowCount } = await client.query('SELECT id FROM ppe_items LIMIT 1');
    if (rowCount === 0) {
      await client.query(`
        INSERT INTO ppe_items (name, category, has_size, size_type, sort_order) VALUES
        ('WAH Helmet (White)', 'head_protection', false, null, 1),
        ('Safety Helmet (Blue)', 'head_protection', false, null, 2),
        ('Safety Helmet (White)', 'head_protection', false, null, 3),
        ('Safety Helmet (Red)', 'head_protection', false, null, 4),
        ('Safety Glasses (High)', 'eye_face_protection', false, null, 5),
        ('Eye Protection', 'eye_face_protection', false, null, 6),
        ('Earmuffs', 'hearing_protection', false, null, 7),
        ('Half Respirator', 'respiratory_protection', false, null, 8),
        ('Leather Welding Gloves Size 14', 'hand_protection', false, null, 9),
        ('Overall (Egypro)', 'body_protection', true, 'clothing', 10),
        ('Reflector Vest (Egypro)', 'body_protection', true, 'clothing', 11),
        ('Rain Coat', 'body_protection', true, 'clothing', 12),
        ('Safety Shoes', 'foot_protection', true, 'shoe', 13),
        ('Safety Gumboots', 'foot_protection', true, 'shoe', 14),
        ('Body Harness', 'fall_protection', true, 'clothing', 15),
        ('Work Positioning Lanyard', 'fall_protection', false, null, 16),
        ('Double Lanyard', 'fall_protection', false, null, 17),
        ('Helmet Detector', 'wah_equipment', false, null, 18),
        ('Wooden Climber', 'wah_equipment', false, null, 19),
        ('Concrete Climber', 'wah_equipment', false, null, 20)
      `);
      console.log('PPE items seeded');
    }

    // Create admin user if not exists
    const hash = await bcrypt.hash('Admin@ESAT2026', 10);
    await client.query(`
      INSERT INTO users (full_name, email, password_hash, role)
      VALUES ('System Admin', 'admin@egypro.com', $1, 'admin')
      ON CONFLICT (email) DO NOTHING
    `, [hash]);

    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture TEXT");
    await client.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS san BOOLEAN DEFAULT TRUE");
    await client.query("UPDATE employees SET san = TRUE WHERE san IS NULL");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_purchase_requested TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_ordered TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_available TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_distributed TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS purchase_requested_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS ordered_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS available_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS distributed_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_purchase_requested TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_ordered TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_available TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_distributed TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS purchase_requested_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS ordered_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS available_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS distributed_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()");
    console.log("Database setup complete");
  } catch(e) {
    console.error('DB setup error:', e.message);
  } finally {
    client.release();
  }
}

// ── Auth middleware ──────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ── Routes ───────────────────────────────────────────────────

// Health
app.get('/health', (_, res) => res.json({ status: 'ok', app: 'ESAT', version: '1.0.0' }));

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1 AND is_active=true', [email]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash)))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: rows[0].id, email: rows[0].email, role: rows[0].role, name: rows[0].full_name }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: rows[0].id, name: rows[0].full_name, email: rows[0].email, role: rows[0].role } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Me
app.get('/api/auth/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT id,full_name,email,role,profile_picture FROM users WHERE id=$1', [req.user.id]);
  res.json(rows[0]);
});

// Dashboard
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const [emp, overdue, ncr, ncrCat, comp, recent] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE employment_status='active') as active, COUNT(*) FILTER (WHERE employment_status='exit' AND exit_date >= date_trunc('year',NOW())) as exits_this_year FROM employees`),
      pool.query(`SELECT COUNT(*) as overdue FROM employees e LEFT JOIN (SELECT employee_id, MAX(audit_date) as last_audit FROM audits GROUP BY employee_id) a ON e.id=a.employee_id WHERE e.employment_status='active' AND (a.last_audit IS NULL OR CURRENT_DATE - a.last_audit > 30)`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status!='resolved') as open, COUNT(*) FILTER (WHERE status='pending') as pending FROM ncr_items`),
      pool.query(`SELECT p.category, COUNT(*) as count FROM ncr_items n JOIN ppe_items p ON p.id=n.ppe_item_id WHERE n.status!='resolved' GROUP BY p.category ORDER BY count DESC`),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE overall_status='compliant') as compliant FROM audits WHERE audit_date >= date_trunc('month',NOW())`),
      pool.query(`SELECT a.id,a.audit_date,a.overall_status,e.full_name as employee_name,e.employee_number,e.department,e.project,u.full_name as audited_by_name,COUNT(ai.id) as total_items,COUNT(CASE WHEN ai.condition!='good' THEN 1 END) as issues_count FROM audits a JOIN employees e ON e.id=a.employee_id JOIN users u ON u.id=a.audited_by LEFT JOIN audit_items ai ON ai.audit_id=a.id GROUP BY a.id,e.full_name,e.employee_number,e.department,e.project,u.full_name ORDER BY a.created_at DESC LIMIT 5`)
    ]);
    const c = comp.rows[0];
    res.json({
      employees: { active: parseInt(emp.rows[0].active), exits_this_year: parseInt(emp.rows[0].exits_this_year) },
      overdue: parseInt(overdue.rows[0].overdue),
      ncr: { open: parseInt(ncr.rows[0].open), pending: parseInt(ncr.rows[0].pending), by_category: ncrCat.rows },
      compliance_rate: c.total > 0 ? Math.round((c.compliant / c.total) * 100) : null,
      recent_audits: recent.rows
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Employees
app.get('/api/employees', auth, async (req, res) => {
  try {
    const { status, search, national_id, project, client, san } = req.query;
    let q = `SELECT e.*, MAX(a.audit_date) as last_audit_date, CURRENT_DATE - MAX(a.audit_date) as days_since_audit FROM employees e LEFT JOIN audits a ON a.employee_id=e.id WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); q += ` AND e.employment_status=$${params.length}`; }
    if (search) { params.push(`%${search}%`); q += ` AND (e.full_name ILIKE $${params.length} OR e.employee_number ILIKE $${params.length})`; }
    if (national_id) { params.push(`%${national_id}%`); q += ` AND e.national_id ILIKE $${params.length}`; }
    if (project) { params.push(project); q += ` AND e.project=$${params.length}`; }
    if (client) { params.push(client); q += ` AND e.client=$${params.length}`; }
    if (san === 'yes') { q += ` AND (e.san IS NULL OR e.san = TRUE)`; }
    if (san === 'no') { q += ` AND e.san = FALSE`; }
    q += ` GROUP BY e.id ORDER BY e.full_name`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/employees/overdue', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id as employee_id, e.employee_number, e.full_name, e.department, e.project, e.employment_status,
        MAX(a.audit_date) as last_audit_date, CURRENT_DATE - MAX(a.audit_date) as days_since_audit
      FROM employees e LEFT JOIN audits a ON a.employee_id=e.id
      WHERE e.employment_status='active'
      GROUP BY e.id
      HAVING MAX(a.audit_date) IS NULL OR CURRENT_DATE - MAX(a.audit_date) > 30
      ORDER BY days_since_audit DESC NULLS FIRST
    `);
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/employees/:id', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM employees WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.get('/api/employees/:id/ppe-assignments', auth, async (req, res) => {
  const { rows } = await pool.query(`SELECT p.* FROM ppe_items p JOIN employee_ppe_assignments epa ON epa.ppe_item_id=p.id WHERE epa.employee_id=$1 AND p.is_active=true ORDER BY p.sort_order`, [req.params.id]);
  res.json(rows);
});

app.post('/api/employees', auth, async (req, res) => {
  if (req.user.role === 'ehs_officer') return res.status(403).json({ error: 'Not authorized' });
  let { employee_number, full_name, national_id, job_title, department, project, client, organization, resource_type, employment_status } = req.body;
  resource_type = resource_type?.toLowerCase();
  employment_status = employment_status?.toLowerCase();

  try {
    const { rows } = await pool.query(`INSERT INTO employees (employee_number,full_name,national_id,job_title,department,project,client,organization,resource_type,employment_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [employee_number, full_name, national_id, job_title, department, project, client, organization, resource_type, employment_status || 'active']);
    res.status(201).json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Employee number exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// Update employee status (admin only)
app.put('/api/employees/:id/status', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { employment_status, exit_date } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE employees SET employment_status=$1, exit_date=$2, updated_at=NOW() WHERE id=$3', [employment_status, exit_date || null, req.params.id]);
    if (employment_status === 'exit') {
      await client.query(`UPDATE ppe_requests SET status='canceled', updated_at=NOW() WHERE employee_id=$1 AND status NOT IN ('distributed','canceled')`, [req.params.id]);
    }
    await client.query('COMMIT');
    const { rows } = await pool.query('SELECT * FROM employees WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Server error' }); }
  finally { client.release(); }
});

// Toggle SAN (admin only)
app.put('/api/employees/:id/san', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { san } = req.body;
  const { rows } = await pool.query('UPDATE employees SET san=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [san, req.params.id]);
  res.json(rows[0]);
});

// Delete employee (admin only)
app.delete('/api/employees/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  await pool.query('DELETE FROM employees WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// PPE Items
app.get('/api/ppe', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ppe_items WHERE is_active=true ORDER BY sort_order');
  res.json(rows);
});

// Audits
app.get('/api/audits', auth, async (req, res) => {
  try {
    const { search, national_id, resource_type, project, client, status, audited_by } = req.query;
    let q = `SELECT a.*,e.full_name as employee_name,e.employee_number,e.national_id,e.department,e.project,e.client,e.organization,e.resource_type,u.full_name as audited_by_name,
        COUNT(ai.id) as total_items, COUNT(CASE WHEN ai.condition!='good' THEN 1 END) as issues_count
      FROM audits a JOIN employees e ON e.id=a.employee_id JOIN users u ON u.id=a.audited_by
      LEFT JOIN audit_items ai ON ai.audit_id=a.id WHERE 1=1`;
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND e.full_name ILIKE $${params.length}`; }
    if (national_id) { params.push(`%${national_id}%`); q += ` AND e.national_id ILIKE $${params.length}`; }
    if (resource_type) { params.push(resource_type); q += ` AND e.resource_type=$${params.length}`; }
    if (project) { params.push(project); q += ` AND e.project=$${params.length}`; }
    if (client) { params.push(client); q += ` AND e.client=$${params.length}`; }
    if (status) { params.push(status); q += ` AND e.employment_status=$${params.length}`; }
    if (audited_by) { params.push(audited_by); q += ` AND a.audited_by=$${params.length}`; }
    q += ` GROUP BY a.id,e.full_name,e.employee_number,e.national_id,e.department,e.project,e.client,e.organization,e.resource_type,u.full_name ORDER BY a.audit_date DESC`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/audits/stats', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE overall_status='compliant') as compliant,
        COUNT(*) FILTER (WHERE overall_status='partial') as partial,
        COUNT(*) FILTER (WHERE overall_status='non_compliant') as non_compliant,
        COUNT(*) FILTER (WHERE date_trunc('month', audit_date) = date_trunc('month', NOW())) as this_month,
        COUNT(*) FILTER (WHERE date_trunc('month', audit_date) = date_trunc('month', NOW() - INTERVAL '1 month')) as last_month
      FROM audits
    `);
    res.json(rows[0]);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/audits/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: auditItems } = await client.query('SELECT id FROM audit_items WHERE audit_id=$1', [req.params.id]);
    for (const ai of auditItems) {
      const { rows: ncrs } = await client.query('SELECT id FROM ncr_items WHERE audit_item_id=$1', [ai.id]);
      for (const ncr of ncrs) {
        await client.query('DELETE FROM ppe_requests WHERE ncr_item_id=$1', [ncr.id]);
      }
      await client.query('DELETE FROM ncr_items WHERE audit_item_id=$1', [ai.id]);
    }
    await client.query('DELETE FROM audits WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'Deleted' });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/api/audits/leaderboard', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.full_name, u.role,
        COUNT(a.id) as total_audits,
        COUNT(a.id) FILTER (WHERE date_trunc('month', a.audit_date) = date_trunc('month', NOW())) as this_month
      FROM users u
      LEFT JOIN audits a ON a.audited_by = u.id
      WHERE u.is_active = true
      GROUP BY u.id
      ORDER BY total_audits DESC
    `);
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/audits/:id', auth, async (req, res) => {
  try {
    const { rows: [audit] } = await pool.query(`
      SELECT a.*,e.full_name as employee_name,e.employee_number,e.national_id,e.department,e.project,e.job_title,e.client,e.organization,e.resource_type,u.full_name as audited_by_name
      FROM audits a JOIN employees e ON e.id=a.employee_id JOIN users u ON u.id=a.audited_by
      WHERE a.id=$1
    `, [req.params.id]);
    if (!audit) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await pool.query(`
      SELECT ai.*,p.name as ppe_name,p.category,p.has_size,p.size_type
      FROM audit_items ai JOIN ppe_items p ON p.id=ai.ppe_item_id
      WHERE ai.audit_id=$1 ORDER BY p.sort_order
    `, [req.params.id]);
    res.json({ ...audit, items });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/audits', auth, async (req, res) => {
  const { employee_id, audit_date, notes, items, audited_by_override } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hasIssues = items.some(i => i.condition !== 'good');
    const allBad = items.every(i => i.condition !== 'good');
    const overall_status = !hasIssues ? 'compliant' : allBad ? 'non_compliant' : 'partial';
    const { rows: [audit] } = await client.query(`INSERT INTO audits (employee_id,audited_by,audit_date,overall_status,notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [employee_id, audited_by_override || req.user.id, audit_date || new Date(), overall_status, notes]);
    for (const item of items) {
      const { rows: [ai] } = await client.query(`INSERT INTO audit_items (audit_id,ppe_item_id,condition,size_value,comment) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [audit.id, item.ppe_item_id, item.condition, item.size_value || null, item.comment || null]);
      if (item.condition !== 'good') {
        await client.query(`INSERT INTO ncr_items (audit_item_id,employee_id,ppe_item_id,condition,size_value,comment) VALUES ($1,$2,$3,$4,$5,$6)`, [ai.id, employee_id, item.ppe_item_id, item.condition, item.size_value || null, item.comment || null]);
      }
    }
    await client.query('COMMIT');
    res.status(201).json(audit);
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Server error' }); }
  finally { client.release(); }
});

// NCR
app.get('/api/ncr', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT n.*,e.full_name as employee_name,e.employee_number,p.name as ppe_name,p.category FROM ncr_items n JOIN employees e ON e.id=n.employee_id JOIN ppe_items p ON p.id=n.ppe_item_id WHERE n.status!='resolved' ORDER BY n.created_at DESC`);
    res.json(rows);
  } catch(e) { console.error("PUT users error:", e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/ncr/stats', auth, async (req, res) => {
  const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE status='pending') as pending, COUNT(*) FILTER (WHERE status='ehs_purchase_requested') as ordered, COUNT(*) FILTER (WHERE status IN ('resolved','distributed') AND updated_at >= date_trunc('month',NOW())) as resolved_this_month, COUNT(*) FILTER (WHERE status NOT IN ('resolved','distributed','canceled')) as total_open FROM ncr_items`);
  res.json(rows[0]);
});

app.put('/api/ncr/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let updateQ;
    if (status === 'resolved') {
      updateQ = await client.query('UPDATE ncr_items SET status=$1, resolved_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *', [status, req.params.id]);
    } else {
      updateQ = await client.query('UPDATE ncr_items SET status=$1, resolved_at=NULL, updated_at=NOW() WHERE id=$2 RETURNING *', [status, req.params.id]);
    }
    const ncr = updateQ.rows[0];
    if (status === 'purchase_requested') {
      await client.query('UPDATE ppe_requests SET status=$1, updated_at=NOW() WHERE ncr_item_id=$2', ['purchase_requested', req.params.id]);
    }
    await client.query('COMMIT');
    res.json(ncr);
  } catch(e) { await client.query('ROLLBACK'); console.error('NCR status error:', e.message); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/api/ncr/purchase-requests', auth, async (req, res) => {
  const { rows } = await pool.query(`SELECT pr.*,u.full_name as created_by_name,COUNT(pri.id) as items_count FROM purchase_requests pr JOIN users u ON u.id=pr.created_by LEFT JOIN purchase_request_items pri ON pri.purchase_request_id=pr.id GROUP BY pr.id,u.full_name ORDER BY pr.created_at DESC`);
  res.json(rows);
});

app.post('/api/ncr/purchase-requests', auth, async (req, res) => {
  const { ncr_item_ids, notes } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const year = new Date().getFullYear();
    const { rows: [{ count }] } = await client.query(`SELECT COUNT(*) FROM purchase_requests WHERE pr_number LIKE $1`, [`PR-${year}-%`]);
    const pr_number = `PR-${year}-${String(parseInt(count)+1).padStart(3,'0')}`;
    const { rows: [pr] } = await client.query(`INSERT INTO purchase_requests (pr_number,created_by,notes) VALUES ($1,$2,$3) RETURNING *`, [pr_number, req.user.id, notes]);
    await client.query(`UPDATE ncr_items SET status='ordered', updated_at=NOW() WHERE id=ANY($1::uuid[])`, [ncr_item_ids]);
    await client.query('COMMIT');
    res.status(201).json(pr);
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Server error' }); }
  finally { client.release(); }
});

app.put('/api/ncr/purchase-requests/:id/send', auth, async (req, res) => {
  const { rows } = await pool.query(`UPDATE purchase_requests SET status='sent', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
  res.json(rows[0]);
});

// Fix old statuses to new naming convention
app.post('/api/admin/fix-statuses', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query("UPDATE ppe_requests SET status='ehs_purchase_requested' WHERE status IN ('purchase_requested','ordered')");
    await pool.query("UPDATE ncr_items SET status='ehs_purchase_requested' WHERE status IN ('purchase_requested','ordered')");
    res.json({ message: 'Statuses fixed' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete NCR item (admin only)
app.delete('/api/ncr/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM ppe_requests WHERE ncr_item_id=$1', [req.params.id]);
    await pool.query('DELETE FROM ncr_items WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// PPE Request Tracker
app.get('/api/ppe-requests', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*,
        e.full_name as employee_name, e.employee_number, e.employment_status,
        p.name as ppe_name, p.category,
        u1.full_name as purchase_requested_by_name,
        u2.full_name as ordered_by_name,
        u3.full_name as available_by_name,
        u4.full_name as distributed_by_name
      FROM ppe_requests r
      JOIN employees e ON e.id=r.employee_id
      JOIN ppe_items p ON p.id=r.ppe_item_id
      LEFT JOIN users u1 ON u1.id=r.purchase_requested_by
      LEFT JOIN users u2 ON u2.id=r.ordered_by
      LEFT JOIN users u3 ON u3.id=r.available_by
      LEFT JOIN users u4 ON u4.id=r.distributed_by
      ORDER BY r.date_flagged DESC
    `);
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/ppe-requests/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const allowedRoles = ['admin', 'scm_officer', 'ehs_manager'];
  if (!allowedRoles.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  if (req.user.role === 'scm_officer' && ['pending', 'ehs_purchase_requested'].includes(status)) {
    return res.status(403).json({ error: 'SCM Officer can only update from EHS Purchase Requested onwards' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let extraFields = '';
    let extraParams = [status, req.params.id];
    if (status === 'ehs_purchase_requested') extraFields = ', date_purchase_requested=NOW(), purchase_requested_by=$3';
    if (status === 'scm_ordered') extraFields = ', date_ordered=NOW(), ordered_by=$3';
    if (status === 'warehouse_available') extraFields = ', date_available=NOW(), available_by=$3';
    if (status === 'distributed') extraFields = ', date_distributed=NOW(), distributed_by=$3';
    if (extraFields.includes('$3')) extraParams.push(req.user.id);
    const { rows: [r] } = await client.query(
      'UPDATE ppe_requests SET status=$1' + extraFields + ', updated_at=NOW() WHERE id=$2 RETURNING *',
      extraParams
    );
    if (r.ncr_item_id) {
      if (status === 'distributed') {
        await client.query('UPDATE ncr_items SET status=$1, resolved_at=NOW(), updated_at=NOW() WHERE id=$2', ['resolved', r.ncr_item_id]);
      } else {
        await client.query('UPDATE ncr_items SET status=$1, updated_at=NOW() WHERE id=$2', [status, r.ncr_item_id]);
      }
    }
    await client.query('COMMIT');
    res.json(r);
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// Fix missing dates on existing PPE requests (admin only)
app.post('/api/admin/fix-ppe-dates', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query("UPDATE ppe_requests SET date_purchase_requested=updated_at WHERE status='ehs_purchase_requested' AND date_purchase_requested IS NULL");
    res.json({ message: 'Dates fixed' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// One-time backfill NCR items to PPE requests (admin only)
app.post('/api/admin/backfill-ppe-requests', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO ppe_requests (ncr_item_id, employee_id, ppe_item_id, size_value, status, date_flagged)
      SELECT n.id, n.employee_id, n.ppe_item_id, n.size_value,
        CASE WHEN n.status='purchase_requested' THEN 'ehs_purchase_requested' ELSE 'pending' END,
        n.created_at
      FROM ncr_items n
      WHERE NOT EXISTS (SELECT 1 FROM ppe_requests p WHERE p.ncr_item_id = n.id)
      RETURNING id
    `);
    res.json({ backfilled: rows.length });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Start
const PORT = 8080;
setupDB().then(() => {
  app.listen(PORT, () => console.log(`ESAT running on port ${PORT}`));
});

// ── User Management Routes ───────────────────────────────────

// GET all users (admin only)
app.get('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { rows } = await pool.query('SELECT id, full_name, email, role, is_active, profile_picture, created_at FROM users ORDER BY created_at DESC');
  res.json(rows);
});

// POST create new user (admin only)
app.post('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { full_name, email, password, role } = req.body;
  if (!full_name || !email || !password || !role) return res.status(400).json({ error: 'All fields required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, full_name, email, role, is_active',
      [full_name, email, hash, role]
    );
    res.status(201).json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT update user (admin only)
app.put('/api/users/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { full_name, email, role, is_active, password, profile_picture } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET full_name=$1, email=$2, role=$3, is_active=$4, password_hash=$5, profile_picture=$6, updated_at=NOW() WHERE id=$7',
        [full_name, email, role, is_active, hash, profile_picture || null, req.params.id]);
    } else {
      await pool.query('UPDATE users SET full_name=$1, email=$2, role=$3, is_active=$4, profile_picture=$5, updated_at=NOW() WHERE id=$6',
        [full_name, email, role, is_active, profile_picture || null, req.params.id]);
    }
    const { rows } = await pool.query('SELECT id, full_name, email, role, is_active, profile_picture FROM users WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch(e) { console.error("PUT users error:", e.message); res.status(500).json({ error: e.message }); }
});

// Change own password
app.post('/api/auth/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 8)
    return res.status(400).json({ error: 'Invalid password data' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!(await bcrypt.compare(currentPassword, rows[0].password_hash)))
      return res.status(401).json({ error: 'Current password incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ message: 'Password updated' });
  } catch(e) { console.error("PUT users error:", e.message); res.status(500).json({ error: e.message }); }
});
