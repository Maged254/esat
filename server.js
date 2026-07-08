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
// Any token issued before this process started is rejected, forcing everyone
// to re-login after a backend deploy (except the long-lived sync account).
const SERVER_BOOT_TIME = Math.floor(Date.now() / 1000);

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
      
      CREATE TABLE IF NOT EXISTS locations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        id SERIAL PRIMARY KEY,
        synced_at TIMESTAMPTZ DEFAULT NOW(),
        triggered_by TEXT
      );
    `);

    // Ensure quantity column exists on audit_items
    await client.query('ALTER TABLE audit_items ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1');

    // Ensure project_access column exists on users
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS project_access TEXT[] DEFAULT '{}'")
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS client_access TEXT[] DEFAULT '{}'");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS page_access TEXT[] DEFAULT '{}'");

    // Ensure distribution columns exist on ppe_requests
    await client.query('ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS distribution_method VARCHAR(50)');
    await client.query('ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS courier_tracking_number VARCHAR(200)');

    // Ensure location_id column exists on audits
    await client.query('ALTER TABLE audits ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES locations(id)');

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
    await client.query("ALTER TABLE ncr_items ALTER COLUMN status TYPE VARCHAR(50)");
    await client.query("ALTER TABLE ppe_requests ALTER COLUMN status TYPE VARCHAR(50)");
    await client.query("UPDATE employees SET san = TRUE WHERE san IS NULL");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_purchase_requested TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS flagged_by UUID");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_ordered TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_available TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_distributed TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS purchase_requested_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS ordered_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS available_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS distributed_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS date_purchase_requested TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS flagged_by UUID");
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
    if (!req.user.sync && req.user.iat < SERVER_BOOT_TIME) {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ── Project / client access helpers ──────────────────────────
// Escapes free-text values before they're interpolated into HTML email templates.
const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ['admin', 'ehs_manager', 'ehs_officer', 'supervisor', 'scm_officer', 'project_director'];
// Data-URL profile pictures only, capped just under the 10mb JSON body limit
// (no client-side resize happens before upload, so this must stay generous).
const isValidProfilePicture = (s) => typeof s === 'string' && s.startsWith('data:image/') && s.length <= 9 * 1024 * 1024;

const VALID_CONDITIONS = ['good', 'not_good', 'missing'];
// Returns a whole number 1-9999, or null if the input isn't a valid quantity.
const sanitizeQuantity = (q) => {
  if (q === undefined || q === null) return null;
  const n = Number(q);
  if (!Number.isInteger(n) || n < 1 || n > 9999) return null;
  return n;
};

const RESTRICTED_ROLES = ['ehs_officer', 'supervisor', 'scm_officer', 'project_director', 'ehs_manager'];
const getProjectFilter = async (user) => {
  if (!RESTRICTED_ROLES.includes(user.role)) return null; // unrestricted
  const projects = user.project_access || [];
  if (projects.length === 0) return []; // no access
  // Check if user has all projects
  const { rows } = await pool.query(`
    SELECT ARRAY_AGG(DISTINCT project) as all_projects FROM (
      SELECT project FROM employees WHERE project IS NOT NULL
      UNION
      SELECT project FROM casuals WHERE project IS NOT NULL
    ) combined
  `);
  const allProjects = rows[0].all_projects || [];
  if (allProjects.every(p => projects.includes(p))) return null; // has all projects = unrestricted
  return projects;
};
const getClientFilter = async (user) => {
  if (!RESTRICTED_ROLES.includes(user.role)) return null; // unrestricted
  const clients = user.client_access || [];
  if (clients.length === 0) return []; // no access
  // Check if user has all clients
  const { rows } = await pool.query(`
    SELECT ARRAY_AGG(DISTINCT client) as all_clients FROM (
      SELECT client FROM employees WHERE client IS NOT NULL
      UNION
      SELECT client FROM casuals WHERE client IS NOT NULL
    ) combined
  `);
  const allClients = rows[0].all_clients || [];
  if (allClients.every(c => clients.includes(c))) return null; // has all clients = unrestricted
  return clients;
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
    const isSync = rows[0].email === 'sync@egypro.com';
    const tokenOptions = isSync ? {} : { expiresIn: '8h' };
    const token = jwt.sign({ id: rows[0].id, email: rows[0].email, role: rows[0].role, name: rows[0].full_name, project_access: rows[0].project_access || [], client_access: rows[0].client_access || [], page_access: rows[0].page_access || [], sync: isSync }, JWT_SECRET, tokenOptions);
    res.json({ token, user: { id: rows[0].id, name: rows[0].full_name, email: rows[0].email, role: rows[0].role, project_access: rows[0].project_access || [], client_access: rows[0].client_access || [], page_access: rows[0].page_access || [] } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Me
app.get('/api/auth/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT id,full_name,email,role,profile_picture,project_access,page_access,client_access FROM users WHERE id=$1', [req.user.id]);
  res.json(rows[0]);
});

// Dashboard
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const [emp, overdue, ncr, ncrCat, comp, delays, recent] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE employment_status='active') as active, COUNT(*) FILTER (WHERE employment_status='exit' AND exit_date >= date_trunc('year',NOW())) as exits_this_year FROM employees`),
      pool.query(`SELECT COUNT(*) as overdue FROM employees e LEFT JOIN (SELECT employee_id, MAX(audit_date) as last_audit FROM audits WHERE employee_present = TRUE AND is_deleted IS NOT TRUE GROUP BY employee_id) a ON e.id=a.employee_id WHERE e.employment_status='active' AND e.san=TRUE AND (a.last_audit IS NULL OR CURRENT_DATE - a.last_audit > 30)`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status!='resolved') as open, COUNT(*) FILTER (WHERE status='pending') as pending FROM ncr_items`),
      pool.query(`SELECT p.name as ppe_name, p.category, COUNT(*) as count FROM ncr_items n JOIN ppe_items p ON p.id=n.ppe_item_id WHERE n.status!='resolved' AND n.status!='canceled' GROUP BY p.name, p.category ORDER BY count DESC LIMIT 10`),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE overall_status='compliant') as compliant FROM audits WHERE audit_date >= date_trunc('month',NOW()) AND is_deleted IS NOT TRUE`),
      pool.query(`
        SELECT
          MAX(CASE WHEN status='pending' THEN CURRENT_DATE - date_flagged::date END) as ehs_delay,
          MAX(CASE WHEN status='ehs_purchase_requested' THEN CURRENT_DATE - date_purchase_requested::date END) as scm_delay,
          MAX(CASE WHEN status='scm_ordered' THEN CURRENT_DATE - date_ordered::date END) as suppliers_delay,
          MAX(CASE WHEN status='warehouse_available' THEN CURRENT_DATE - date_available::date END) as projects_delay,
          MAX(CASE WHEN status NOT IN ('distributed','resolved','canceled') THEN CURRENT_DATE - date_flagged::date END) as total_delay
        FROM ppe_requests
        WHERE status NOT IN ('distributed','resolved','canceled')
      `),
      pool.query(`SELECT a.id,a.audit_date,a.overall_status,COALESCE(e.full_name,c.full_name) as employee_name,e.employee_number,COALESCE(e.national_id,c.national_id) as national_id,e.department,COALESCE(e.project,c.project) as project,u.full_name as audited_by_name,COUNT(ai.id) as total_items,COUNT(CASE WHEN ai.condition!='good' THEN 1 END) as issues_count FROM audits a LEFT JOIN employees e ON e.id=a.employee_id LEFT JOIN casuals c ON c.id=a.casual_id JOIN users u ON u.id=a.audited_by LEFT JOIN audit_items ai ON ai.audit_id=a.id GROUP BY a.id,e.full_name,c.full_name,e.employee_number,e.national_id,c.national_id,e.department,e.project,c.project,u.full_name ORDER BY a.created_at DESC LIMIT 5`)
    ]);
    const c = comp.rows[0];
    res.json({
      employees: { active: parseInt(emp.rows[0].active), exits_this_year: parseInt(emp.rows[0].exits_this_year) },
      overdue: parseInt(overdue.rows[0].overdue),
      ncr: { open: parseInt(ncr.rows[0].open), pending: parseInt(ncr.rows[0].pending), by_category: ncrCat.rows },
      compliance_rate: c.total > 0 ? Math.round((c.compliant / c.total) * 100) : null,
      delays: {
        ehs: parseInt(delays.rows[0].ehs_delay) || 0,
        scm: parseInt(delays.rows[0].scm_delay) || 0,
        suppliers: parseInt(delays.rows[0].suppliers_delay) || 0,
        projects: parseInt(delays.rows[0].projects_delay) || 0,
        total: parseInt(delays.rows[0].total_delay) || 0
      },
      recent_audits: recent.rows
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Employees
app.get('/api/employees', auth, async (req, res) => {
  if (!['admin','ehs_manager','ehs_officer','supervisor'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    const { status, search, national_id, project, client, san, job_title, department, resource_type } = req.query;
    let q = `SELECT e.*, MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE AND a.is_deleted IS NOT TRUE) as last_audit_date, CURRENT_DATE - MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE AND a.is_deleted IS NOT TRUE) as days_since_audit, COUNT(epa.id) > 0 as ppe_assigned, u.full_name as ppe_last_edited_by_name FROM employees e LEFT JOIN audits a ON a.employee_id=e.id LEFT JOIN employee_ppe_assignments epa ON epa.employee_id=e.id LEFT JOIN users u ON u.id=e.ppe_last_edited_by WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); q += ` AND e.employment_status=$${params.length}`; }
    if (search) { params.push(`%${search}%`); q += ` AND (e.full_name ILIKE $${params.length} OR e.employee_number ILIKE $${params.length})`; }
    if (national_id) { params.push(`%${national_id}%`); q += ` AND e.national_id ILIKE $${params.length}`; }
    if (project) { params.push(project); q += ` AND e.project=$${params.length}`; }
    if (client) { params.push(client); q += ` AND e.client=$${params.length}`; }
    if (san === 'yes') { q += ` AND (e.san IS NULL OR e.san = TRUE)`; }
    if (san === 'no') { q += ` AND e.san = FALSE`; }
    if (job_title) { params.push(`%${job_title}%`); q += ` AND e.job_title ILIKE $${params.length}`; }
    if (department) { params.push(department); q += ` AND e.department=$${params.length}`; }
    if (resource_type) { params.push(resource_type); q += ` AND e.resource_type=$${params.length}`; }
    const empProjects = await getProjectFilter(req.user);
    if (empProjects !== null) {
      if (empProjects.length === 0) { return res.json([]); }
      params.push(empProjects); q += ` AND e.project = ANY($${params.length})`;
    }
    const empClients = await getClientFilter(req.user);
    if (empClients !== null) {
      if (empClients.length === 0) { return res.json([]); }
      params.push(empClients); q += ` AND e.client = ANY($${params.length})`;
    }
    q += ` GROUP BY e.id, u.full_name ORDER BY e.full_name`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/audit-coverage', auth, async (req, res) => {
  try {
    const projectFilter = await getProjectFilter(req.user);
    const clientFilter = await getClientFilter(req.user);
    if ((projectFilter !== null && projectFilter.length === 0) || (clientFilter !== null && clientFilter.length === 0)) {
      return res.json({
        total_active: 0, san_count: 0, non_san_count: 0,
        bucket_0_30: 0, bucket_31_60: 0, bucket_61_90: 0, bucket_90_plus: 0, never_audited: 0,
        overdue_total: 0, audit_rate: null, avg_days_since_audit: null,
        this_month_audited: 0, last_month_audited: 0, by_project: []
      });
    }

    const { project, client } = req.query;
    const params = [];
    let whereExtra = '';
    if (projectFilter !== null) { params.push(projectFilter); whereExtra += ` AND e.project = ANY($${params.length})`; }
    if (clientFilter !== null) { params.push(clientFilter); whereExtra += ` AND e.client = ANY($${params.length})`; }
    if (project) { params.push(project); whereExtra += ` AND e.project = $${params.length}`; }
    if (client) { params.push(client); whereExtra += ` AND e.client = $${params.length}`; }

    const baseCTE = `
      WITH last_audit AS (
        SELECT employee_id, MAX(audit_date) as last_audit_date
        FROM audits WHERE employee_present = TRUE
        GROUP BY employee_id
      ),
      san_emp AS (
        SELECT e.*, la.last_audit_date,
          CASE WHEN la.last_audit_date IS NULL THEN NULL ELSE CURRENT_DATE - la.last_audit_date END as days_since
        FROM employees e
        LEFT JOIN last_audit la ON la.employee_id = e.id
        WHERE e.employment_status = 'active' AND e.san = TRUE ${whereExtra}
      )
    `;

    const countsQ = pool.query(`
      ${baseCTE}
      SELECT
        COUNT(*) FILTER (WHERE days_since IS NOT NULL AND days_since <= 30) as bucket_0_30,
        COUNT(*) FILTER (WHERE days_since > 30 AND days_since <= 60) as bucket_31_60,
        COUNT(*) FILTER (WHERE days_since > 60 AND days_since <= 90) as bucket_61_90,
        COUNT(*) FILTER (WHERE days_since > 90) as bucket_90_plus,
        COUNT(*) FILTER (WHERE days_since IS NULL) as never_audited,
        COUNT(*) FILTER (WHERE days_since IS NULL OR days_since > 30) as overdue_total,
        COUNT(*) as san_total,
        ROUND(AVG(days_since)) as avg_days_since_audit
      FROM san_emp
    `, params);

    const totalQ = pool.query(`
      SELECT COUNT(*) FILTER (WHERE e.employment_status='active' ${whereExtra}) as total_active,
        COUNT(*) FILTER (WHERE e.employment_status='active' AND e.san=TRUE ${whereExtra}) as san_count,
        COUNT(*) FILTER (WHERE e.employment_status='active' AND e.san=FALSE ${whereExtra}) as non_san_count
      FROM employees e
    `, params);

    const monthQ = pool.query(`
      SELECT
        COUNT(DISTINCT a.employee_id) FILTER (WHERE date_trunc('month', a.audit_date) = date_trunc('month', NOW())) as this_month,
        COUNT(DISTINCT a.employee_id) FILTER (WHERE date_trunc('month', a.audit_date) = date_trunc('month', NOW() - INTERVAL '1 month')) as last_month
      FROM audits a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.employee_present = TRUE AND e.san = TRUE AND e.employment_status='active' ${whereExtra}
    `, params);

    const byProjectQ = pool.query(`
      ${baseCTE}
      SELECT project,
        COUNT(*) as san_total,
        COUNT(*) FILTER (WHERE days_since IS NULL OR days_since > 30) as overdue
      FROM san_emp
      GROUP BY project
      ORDER BY overdue DESC
    `, params);

    const [counts, totals, month, byProject] = await Promise.all([countsQ, totalQ, monthQ, byProjectQ]);
    const c = counts.rows[0];
    const t = totals.rows[0];
    const m = month.rows[0];
    const sanTotal = parseInt(c.san_total) || 0;
    const auditedWithin30 = parseInt(c.bucket_0_30) || 0;

    res.json({
      total_active: parseInt(t.total_active) || 0,
      san_count: parseInt(t.san_count) || 0,
      non_san_count: parseInt(t.non_san_count) || 0,
      bucket_0_30: auditedWithin30,
      bucket_31_60: parseInt(c.bucket_31_60) || 0,
      bucket_61_90: parseInt(c.bucket_61_90) || 0,
      bucket_90_plus: parseInt(c.bucket_90_plus) || 0,
      never_audited: parseInt(c.never_audited) || 0,
      overdue_total: parseInt(c.overdue_total) || 0,
      audit_rate: sanTotal > 0 ? Math.round((auditedWithin30 / sanTotal) * 100) : null,
      avg_days_since_audit: c.avg_days_since_audit !== null ? parseInt(c.avg_days_since_audit) : null,
      this_month_audited: parseInt(m.this_month) || 0,
      last_month_audited: parseInt(m.last_month) || 0,
      by_project: byProject.rows.map(r => ({ project: r.project, san_total: parseInt(r.san_total), overdue: parseInt(r.overdue) }))
    });
  } catch(e) { console.error('Audit coverage error:', e.message); res.status(500).json({ error: e.message }); }
});
app.get('/api/employees/overdue', auth, async (req, res) => {
  try {
    const overdueProjects = await getProjectFilter(req.user);
    if (overdueProjects !== null && overdueProjects.length === 0) return res.json([]);
    const overdueClients = await getClientFilter(req.user);
    if (overdueClients !== null && overdueClients.length === 0) return res.json([]);
    const params = [];
    let whereExtra = '';
    if (overdueProjects !== null) { params.push(overdueProjects); whereExtra += ` AND e.project = ANY($${params.length})`; }
    if (overdueClients !== null) { params.push(overdueClients); whereExtra += ` AND e.client = ANY($${params.length})`; }
    const { rows } = await pool.query(`
      SELECT e.id as employee_id, e.employee_number, e.national_id, e.full_name, e.department, e.project, e.employment_status,
        MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE) as last_audit_date,
        CURRENT_DATE - MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE) as days_since_audit
      FROM employees e LEFT JOIN audits a ON a.employee_id=e.id
      WHERE e.employment_status='active' AND e.san=TRUE ${whereExtra}
      GROUP BY e.id
      HAVING MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE) IS NULL
        OR CURRENT_DATE - MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE) > 30
      ORDER BY days_since_audit DESC NULLS FIRST
    `, params);
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/employees/:id', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM employees WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  const empProjects = await getProjectFilter(req.user);
  if (empProjects !== null && !empProjects.includes(rows[0].project)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const empClients = await getClientFilter(req.user);
  if (empClients !== null && !empClients.includes(rows[0].client)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(rows[0]);
});

app.get('/api/employees/:id/ppe-assignments', auth, async (req, res) => {
  if (!['admin','ehs_manager','ehs_officer','supervisor'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const { rows } = await pool.query(`SELECT p.* FROM ppe_items p JOIN employee_ppe_assignments epa ON epa.ppe_item_id=p.id WHERE epa.employee_id=$1 AND p.is_active=true ORDER BY p.sort_order`, [req.params.id]);
  res.json(rows);
});


app.put('/api/employees/:id/ppe-assignments', auth, async (req, res) => {
  if (!['admin','ehs_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const { ppe_item_ids } = req.body; // array of UUIDs
  const employeeId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM employee_ppe_assignments WHERE employee_id=$1', [employeeId]);
    if (ppe_item_ids && ppe_item_ids.length > 0) {
      for (const ppeId of ppe_item_ids) {
        await client.query('INSERT INTO employee_ppe_assignments (employee_id, ppe_item_id) VALUES ($1,$2)', [employeeId, ppeId]);
      }
    }
    await client.query('UPDATE employees SET ppe_last_edited_by=$1, ppe_last_edited_at=NOW() WHERE id=$2', [req.user.id, employeeId]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/employees', auth, async (req, res) => {
  if (req.user.role === 'ehs_officer') return res.status(403).json({ error: 'Not authorized' });
  let { employee_number, full_name, national_id, job_title, department, project, client, organization, resource_type, employment_status } = req.body;
  resource_type = resource_type?.toLowerCase();
  employment_status = employment_status?.toLowerCase();

  try {
    // Upsert: if national_id exists, update instead of insert
    if (national_id) {
      const existing = await pool.query('SELECT id FROM employees WHERE national_id=$1', [national_id]);
      if (existing.rows.length > 0) {
        const { rows } = await pool.query(
          `UPDATE employees SET full_name=$1, job_title=$2, department=$3, project=$4, client=$5, organization=$6, resource_type=$7, employment_status=$8 WHERE national_id=$9 RETURNING *`,
          [full_name, job_title, department, project, client, organization, resource_type, employment_status || 'active', national_id]
        );
        return res.json(rows[0]);
      }
    }
    const empNumber = employee_number || national_id || ('EMP-' + Date.now());
    const { rows } = await pool.query(`INSERT INTO employees (employee_number,full_name,national_id,job_title,department,project,client,organization,resource_type,employment_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [empNumber, full_name, national_id, job_title, department, project, client, organization, resource_type, employment_status || 'active']);
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
  if (employment_status && !['active', 'exit'].includes(employment_status)) {
    return res.status(400).json({ error: 'Invalid employment_status' });
  }
  if (exit_date && isNaN(Date.parse(exit_date))) return res.status(400).json({ error: 'Invalid exit_date' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE employees SET employment_status=$1, exit_date=$2, updated_at=NOW() WHERE id=$3', [employment_status, exit_date || null, req.params.id]);
    if (employment_status === 'exit') {
      await client.query(`UPDATE ppe_requests SET status='canceled', updated_at=NOW() WHERE employee_id=$1 AND status NOT IN ('distributed','canceled')`, [req.params.id]);
      await client.query(`UPDATE ncr_items SET status='canceled', updated_at=NOW() WHERE employee_id=$1 AND status NOT IN ('resolved','canceled')`, [req.params.id]);
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

// ── Casuals ──────────────────────────────────────────────────
const CASUAL_EDIT_ROLES = ['admin', 'supervisor'];
const CASUAL_VIEW_ROLES = ['admin', 'supervisor', 'ehs_officer', 'ehs_manager'];

// List casuals (view: admin, supervisor, ehs_officer, ehs_manager; project-scoped)
app.get('/api/casuals', auth, async (req, res) => {
  if (!CASUAL_VIEW_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  try {
    const casualProjects = await getProjectFilter(req.user);
    if (casualProjects !== null && casualProjects.length === 0) return res.json([]);
    const casualClients = await getClientFilter(req.user);
    if (casualClients !== null && casualClients.length === 0) return res.json([]);
    let q = `SELECT c.*, COUNT(cpa.id) > 0 as ppe_assigned, u.full_name as last_edited_by_name, u2.full_name as ppe_last_edited_by_name FROM casuals c LEFT JOIN casual_ppe_assignments cpa ON cpa.casual_id=c.id LEFT JOIN users u ON u.id=c.last_edited_by LEFT JOIN users u2 ON u2.id=c.ppe_last_edited_by WHERE 1=1`;
    const params = [];
    if (casualProjects !== null) { params.push(casualProjects); q += ` AND c.project = ANY($${params.length})`; }
    if (casualClients !== null) { params.push(casualClients); q += ` AND c.client = ANY($${params.length})`; }
    q += ' GROUP BY c.id, u.full_name, u2.full_name ORDER BY c.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { console.error('Casuals list error:', e.message); res.status(500).json({ error: e.message }); }
});

// Batch add casuals (admin, supervisor only)
app.post('/api/casuals/batch', auth, async (req, res) => {
  if (!CASUAL_EDIT_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const { project, client, organization, casuals } = req.body;
  if (!project || !client || !Array.isArray(casuals) || casuals.length === 0) {
    return res.status(400).json({ error: 'project, client, and at least one casual required' });
  }
  const client_db = await pool.connect();
  try {
    await client_db.query('BEGIN');
    const inserted = [];
    const reactivated = [];
    const skipped = [];
    for (const c of casuals) {
      if (!c.full_name || !c.national_id) {
        skipped.push({ full_name: c.full_name || '(no name)', reason: 'Full name and National ID are required' });
        continue;
      }
      const { rows: existing } = await client_db.query(
        'SELECT * FROM casuals WHERE national_id=$1',
        [c.national_id]
      );
      if (existing.length > 0) {
        const match = existing[0];
        if (match.employment_status === 'active') {
          skipped.push({ full_name: c.full_name, reason: `National ID ${c.national_id} already exists as an active casual (${match.full_name})` });
          continue;
        } else {
          const { rows } = await client_db.query(
            `UPDATE casuals SET full_name=$1, project=$2, client=$3, organization=$4, employment_status='active', exit_date=NULL, updated_at=NOW(), last_edited_by=$5
             WHERE id=$6 RETURNING *`,
            [c.full_name, project, client, organization || 'Egypro', req.user.id, match.id]
          );
          reactivated.push(rows[0]);
          continue;
        }
      }
      const { rows } = await client_db.query(
        `INSERT INTO casuals (full_name, national_id, job_title, project, client, organization, created_by, last_edited_by)
         VALUES ($1,$2,'Casual',$3,$4,$5,$6,$6) RETURNING *`,
        [c.full_name, c.national_id, project, client, organization || 'Egypro', req.user.id]
      );
      inserted.push(rows[0]);
    }
    await client_db.query('COMMIT');
    const totalAdded = inserted.length + reactivated.length;
    if (totalAdded > 0) {
      resend.emails.send({
        from: 'ESAT <esat@egypro.app>',
        to: 'e.maged@outlook.com',
        subject: `ESAT — ${totalAdded} Casual${totalAdded > 1 ? 's' : ''} Added`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-radius: 8px 8px 0 0; border-bottom: 2px solid #0f2a4a;"><tr><td bgcolor="#ffffff" align="center" style="padding: 16px 24px;">
              <img src="https://esat.egypro.app/esat-login-logo.png" alt="ESAT" width="110" height="50" style="height:50px; width:110px; display:block; margin:0 auto;" />
            </td></tr></table>
            <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="font-size: 15px; color: #374151;">
                <strong style="color: #0f2a4a;">${totalAdded} casual${totalAdded > 1 ? 's were' : ' was'}</strong> added by <strong style="color: #0f2a4a;">${escapeHtml(req.user.name || req.user.email)}</strong>.
              </p>
              <p style="font-size: 15px; color: #374151;">
                Project: <strong style="color: #0f2a4a;">${escapeHtml(project)}</strong> &middot; Client: <strong style="color: #0f2a4a;">${escapeHtml(client)}</strong>
              </p>
              <a href="https://esat.egypro.app/casuals"
                style="display: inline-block; background: #1D9E75; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">
                Open ESAT
              </a>
              <p style="font-size: 14px; color: #374151; margin-top: 24px;">Thanks,<br/>Maged Ezzat</p>
            </div>
          </div>
        `
      }).catch(e => console.error('Casuals batch email error:', e.message));
    }
    res.json({ inserted, reactivated, skipped });
  } catch(e) { await client_db.query('ROLLBACK'); console.error('Casuals batch add error:', e.message); res.status(500).json({ error: e.message }); }
  finally { client_db.release(); }
});

// Edit a casual (admin, supervisor only)
app.put('/api/casuals/:id', auth, async (req, res) => {
  if (!CASUAL_EDIT_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const { full_name, national_id, project, client, organization } = req.body;
  const { rows } = await pool.query(
    `UPDATE casuals SET full_name=$1, national_id=$2, project=$3, client=$4, organization=$5, updated_at=NOW(), last_edited_by=$6 WHERE id=$7 RETURNING *`,
    [full_name, national_id || null, project, client || null, organization || null, req.user.id, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// Exit a casual (admin, supervisor only) — cancels open casual PPE requests
app.put('/api/casuals/:id/status', auth, async (req, res) => {
  if (!CASUAL_EDIT_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const { employment_status, exit_date } = req.body;
  if (employment_status && !['active', 'exit'].includes(employment_status)) {
    return res.status(400).json({ error: 'Invalid employment_status' });
  }
  if (exit_date && isNaN(Date.parse(exit_date))) return res.status(400).json({ error: 'Invalid exit_date' });
  const client_db = await pool.connect();
  try {
    await client_db.query('BEGIN');
    await client_db.query('UPDATE casuals SET employment_status=$1, exit_date=$2, updated_at=NOW(), last_edited_by=$3 WHERE id=$4', [employment_status, exit_date || null, req.user.id, req.params.id]);
    if (employment_status === 'exit') {
      await client_db.query(`UPDATE ppe_requests SET status='canceled' WHERE casual_id=$1 AND status NOT IN ('distributed','resolved','canceled')`, [req.params.id]);
    }
    await client_db.query('COMMIT');
    const { rows } = await pool.query('SELECT * FROM casuals WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch(e) { await client_db.query('ROLLBACK'); console.error('Casual status error:', e.message); res.status(500).json({ error: 'Server error' }); }
  finally { client_db.release(); }
});

// Get casual PPE assignments
app.get('/api/casuals/:id/ppe-assignments', auth, async (req, res) => {
  if (!['admin','ehs_manager','ehs_officer','supervisor'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const { rows } = await pool.query(`SELECT p.* FROM ppe_items p JOIN casual_ppe_assignments cpa ON cpa.ppe_item_id=p.id WHERE cpa.casual_id=$1 AND p.is_active=true ORDER BY p.sort_order`, [req.params.id]);
  res.json(rows);
});
// Set casual PPE assignments (admin, ehs_manager only)
app.put('/api/casuals/:id/ppe-assignments', auth, async (req, res) => {
  if (!['admin','ehs_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const { ppe_item_ids } = req.body;
  const casualId = req.params.id;
  const client_db = await pool.connect();
  try {
    await client_db.query('BEGIN');
    await client_db.query('DELETE FROM casual_ppe_assignments WHERE casual_id=$1', [casualId]);
    if (ppe_item_ids && ppe_item_ids.length > 0) {
      for (const ppeId of ppe_item_ids) {
        await client_db.query('INSERT INTO casual_ppe_assignments (casual_id, ppe_item_id) VALUES ($1,$2)', [casualId, ppeId]);
      }
    }
    await client_db.query('UPDATE casuals SET ppe_last_edited_by=$1, ppe_last_edited_at=NOW() WHERE id=$2', [req.user.id, casualId]);
    await client_db.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client_db.query('ROLLBACK');
    console.error('Casual PPE assignment error:', e.message);
    res.status(500).json({ error: e.message });
  } finally { client_db.release(); }
});

// Delete employee (admin only)
app.delete('/api/employees/all/purge', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM employees');
    res.json({ message: 'All employees deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/employees/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM employees WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Cannot delete: employee has existing audits or records. Deactivate them instead.' });
    res.status(500).json({ error: e.message });
  }
});

// Delete a casual (admin only)
app.delete('/api/casuals/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM casuals WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Cannot delete: this casual has existing audits, NCR items, or PPE requests. Exit them instead.' });
    res.status(500).json({ error: e.message });
  }
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
    let q = `SELECT a.*,
        COALESCE(e.full_name, c.full_name) as employee_name,
        e.employee_number,
        COALESCE(e.national_id, c.national_id) as national_id,
        e.department,
        COALESCE(e.project, c.project) as project,
        COALESCE(e.client, c.client) as client,
        COALESCE(e.organization, c.organization) as organization,
        e.resource_type,
        (a.casual_id IS NOT NULL) as is_casual,
        u.full_name as audited_by_name,
        ud.full_name as deleted_by_name,
        COUNT(ai.id) as total_items, COUNT(CASE WHEN ai.condition!='good' THEN 1 END) as issues_count
      FROM audits a
      LEFT JOIN employees e ON e.id=a.employee_id
      LEFT JOIN casuals c ON c.id=a.casual_id
      JOIN users u ON u.id=a.audited_by
      LEFT JOIN audit_items ai ON ai.audit_id=a.id
      LEFT JOIN users ud ON ud.id=a.deleted_by WHERE 1=1`;
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND COALESCE(e.full_name, c.full_name) ILIKE $${params.length}`; }
    if (national_id) { params.push(`%${national_id}%`); q += ` AND COALESCE(e.national_id, c.national_id) ILIKE $${params.length}`; }
    if (resource_type === 'casual') { q += ` AND a.casual_id IS NOT NULL`; }
    else if (resource_type) { params.push(resource_type); q += ` AND e.resource_type=$${params.length}`; }
    if (project) { params.push(project); q += ` AND COALESCE(e.project, c.project)=$${params.length}`; }
    if (client) { params.push(client); q += ` AND COALESCE(e.client, c.client)=$${params.length}`; }
    if (status) { params.push(status); q += ` AND COALESCE(e.employment_status, c.employment_status)=$${params.length}`; }
    if (audited_by) { params.push(audited_by); q += ` AND a.audited_by=$${params.length}`; }
    const auditProjects = await getProjectFilter(req.user);
    if (auditProjects !== null) {
      if (auditProjects.length === 0) { return res.json([]); }
      params.push(auditProjects); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`;
    }
    const auditClients = await getClientFilter(req.user);
    if (auditClients !== null) {
      if (auditClients.length === 0) { return res.json([]); }
      params.push(auditClients); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`;
    }
    q += ` GROUP BY a.id,e.full_name,c.full_name,e.employee_number,e.national_id,c.national_id,e.department,e.project,c.project,e.client,c.client,e.organization,c.organization,e.resource_type,u.full_name,a.employee_present,a.casual_id,ud.full_name ORDER BY a.created_at DESC`;
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
      FROM audits WHERE is_deleted IS NOT TRUE
    `);
    res.json(rows[0]);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/audits/:id', auth, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { rows: [existing] } = await pool.query('SELECT * FROM audits WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Audit not found' });

  if (!isAdmin) {
    const ageMs = Date.now() - new Date(existing.created_at).getTime();
    if (ageMs > 72 * 60 * 60 * 1000) return res.status(403).json({ error: 'Delete window has expired (72 hours).' });
    if (existing.audited_by !== req.user.id) return res.status(403).json({ error: 'You can only delete your own requests.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Soft delete the audit
    await client.query(
      'UPDATE audits SET is_deleted=TRUE, deleted_at=NOW(), deleted_by=$1 WHERE id=$2',
      [req.user.id, req.params.id]
    );
    // Cancel all linked PPE requests and NCR items
    const { rows: auditItems } = await client.query('SELECT id FROM audit_items WHERE audit_id=$1', [req.params.id]);
    for (const ai of auditItems) {
      await client.query('UPDATE ppe_requests SET status=$1 WHERE ncr_item_id IN (SELECT id FROM ncr_items WHERE audit_item_id=$2)', ['canceled', ai.id]);
      await client.query('UPDATE ncr_items SET status=$1 WHERE audit_item_id=$2', ['canceled', ai.id]);
    }
    await client.query('COMMIT');
    res.json({ message: 'Deleted' });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/api/audits/leaderboard', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.full_name, u.role, u.profile_picture,
        COUNT(a.id) as total_audits,
        COUNT(a.id) FILTER (WHERE date_trunc('month', a.audit_date) = date_trunc('month', NOW())) as this_month
      FROM users u
      LEFT JOIN audits a ON a.audited_by = u.id AND a.is_deleted IS NOT TRUE
      WHERE u.is_active = true
        AND u.email NOT IN ('admin@egypro.com', 'sync@egypro.com', 'eats-sync@egypro.app')
        AND u.role != 'scm_officer'
      GROUP BY u.id
      ORDER BY total_audits DESC
    `);
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/audits/:id', auth, async (req, res) => {
  try {
    const { rows: [audit] } = await pool.query(`
      SELECT a.*,
        COALESCE(e.full_name, c.full_name) as employee_name,
        e.employee_number,
        COALESCE(e.national_id, c.national_id) as national_id,
        e.department,
        COALESCE(e.project, c.project) as project,
        COALESCE(e.job_title, c.job_title) as job_title,
        COALESCE(e.client, c.client) as client,
        COALESCE(e.organization, c.organization) as organization,
        e.resource_type,
        (a.casual_id IS NOT NULL) as is_casual,
        u.full_name as audited_by_name,
        l.name as location_name,
        u2.full_name as last_edited_by_name
      FROM audits a
      LEFT JOIN employees e ON e.id=a.employee_id
      LEFT JOIN casuals c ON c.id=a.casual_id
      JOIN users u ON u.id=a.audited_by
      LEFT JOIN locations l ON l.id=a.location_id
      LEFT JOIN users u2 ON u2.id=a.last_edited_by
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
  const { employee_id, casual_id, audit_date, notes, items, audited_by_override, employee_present, location_id } = req.body;
  if (!employee_id && !casual_id) return res.status(400).json({ error: 'employee_id or casual_id required' });
  if (employee_id && casual_id) return res.status(400).json({ error: 'Provide only one of employee_id or casual_id' });
  if (employee_id) {
    const { rows: [emp] } = await pool.query('SELECT employment_status FROM employees WHERE id=$1', [employee_id]);
    if (emp && emp.employment_status === 'exit') return res.status(400).json({ error: 'This employee has exited and can no longer be audited or have PPE/Tool requests created.' });
  }
  if (casual_id) {
    const { rows: [cas] } = await pool.query('SELECT employment_status FROM casuals WHERE id=$1', [casual_id]);
    if (cas && cas.employment_status === 'exit') return res.status(400).json({ error: 'This casual has exited and can no longer be audited or have PPE/Tool requests created.' });
  }
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });
  for (const item of items) {
    if (!VALID_CONDITIONS.includes(item.condition)) return res.status(400).json({ error: 'Invalid condition value' });
    if (item.quantity !== undefined && item.quantity !== null && sanitizeQuantity(item.quantity) === null) {
      return res.status(400).json({ error: 'quantity must be a whole number between 1 and 9999' });
    }
  }
  if (audit_date && isNaN(Date.parse(audit_date))) return res.status(400).json({ error: 'Invalid audit_date' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hasIssues = items.some(i => i.condition !== 'good');
    const allBad = items.every(i => i.condition !== 'good');
    const overall_status = !hasIssues ? 'compliant' : allBad ? 'non_compliant' : 'partial';
    const { rows: [audit] } = await client.query(`INSERT INTO audits (employee_id,casual_id,audited_by,audit_date,overall_status,notes,employee_present,location_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [employee_id || null, casual_id || null, audited_by_override || req.user.id, audit_date || new Date(), overall_status, notes, employee_present !== false, location_id || null]);
    for (const item of items) {
      const { rows: [ai] } = await client.query(`INSERT INTO audit_items (audit_id,ppe_item_id,condition,size_value,comment,quantity) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [audit.id, item.ppe_item_id, item.condition, item.size_value || null, item.comment || null, sanitizeQuantity(item.quantity) || 1]);
      if (item.condition === 'not_good') {
        // Skip if open PPE request already exists for this person + PPE item
        const { rows: existing } = await client.query(
          employee_id
            ? `SELECT id FROM ppe_requests WHERE employee_id=$1 AND ppe_item_id=$2 AND status NOT IN ('distributed','resolved','canceled')`
            : `SELECT id FROM ppe_requests WHERE casual_id=$1 AND ppe_item_id=$2 AND status NOT IN ('distributed','resolved','canceled')`,
          [employee_id || casual_id, item.ppe_item_id]
        );
        if (existing.length === 0) {
          const { rows: [ncr] } = await client.query('INSERT INTO ncr_items (audit_item_id,employee_id,casual_id,ppe_item_id,condition,size_value,comment) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [ai.id, employee_id || null, casual_id || null, item.ppe_item_id, item.condition, item.size_value || null, item.comment || null]);
          await client.query('INSERT INTO ppe_requests (ncr_item_id,employee_id,casual_id,ppe_item_id,size_value,status,flagged_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [ncr.id, employee_id || null, casual_id || null, item.ppe_item_id, item.size_value || null, 'pending', req.user.id]);
        }
      }
    }
    await client.query('COMMIT');
    res.status(201).json(audit);
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Server error' }); }
  finally { client.release(); }
});

// Edit Audit (within 24h for submitter; anytime for admin)
app.put('/api/audits/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { notes, location_id, employee_present, items } = req.body;
  const isAdmin = req.user.role === 'admin';

  // Fetch existing audit
  const { rows: [existing] } = await pool.query('SELECT * FROM audits WHERE id=$1', [id]);
  if (!existing) return res.status(404).json({ error: 'Audit not found' });

  // 24h check for non-admins
  if (!isAdmin) {
    const ageMs = Date.now() - new Date(existing.created_at).getTime();
    if (ageMs > 72 * 60 * 60 * 1000) return res.status(403).json({ error: 'Edit window has expired (72 hours).' });
    if (existing.audited_by !== req.user.id) return res.status(403).json({ error: 'You can only edit your own requests.' });
  }

  // For non-admins: block if ANY linked PPE request has moved past pending
  if (!isAdmin) {
    const { rows: blocked } = await pool.query(
      `SELECT pr.id FROM ppe_requests pr
       JOIN ncr_items n ON n.id = pr.ncr_item_id
       JOIN audit_items ai ON ai.id = n.audit_item_id
       WHERE ai.audit_id=$1 AND pr.status NOT IN ('pending','canceled')`,
      [id]
    );
    if (blocked.length > 0) return res.status(403).json({ error: 'This request has already been actioned by EHS. Contact an admin to make changes.' });
  }

  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });
  for (const item of items) {
    if (!VALID_CONDITIONS.includes(item.condition)) return res.status(400).json({ error: 'Invalid condition value' });
    if (item.quantity !== undefined && item.quantity !== null && sanitizeQuantity(item.quantity) === null) {
      return res.status(400).json({ error: 'quantity must be a whole number between 1 and 9999' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update audit header
    const hasIssues = items.some(i => i.condition !== 'good');
    const allBad = items.every(i => i.condition !== 'good');
    const overall_status = !hasIssues ? 'compliant' : allBad ? 'non_compliant' : 'partial';
    await client.query(
      `UPDATE audits SET notes=$1, location_id=$2, employee_present=$3, overall_status=$4, last_edited_at=NOW(), last_edited_by=$6 WHERE id=$5`,
      [notes || null, location_id || null, employee_present !== false, overall_status, id, req.user.id]
    );

    // Get existing audit_items for this audit
    const { rows: existingItems } = await client.query(
      'SELECT * FROM audit_items WHERE audit_id=$1', [id]
    );

    for (const item of items) {
      const existingAI = existingItems.find(ai => ai.ppe_item_id === item.ppe_item_id);
      const oldCondition = existingAI ? existingAI.condition : null;
      const newCondition = item.condition;

      if (existingAI) {
        // Update existing audit_item
        await client.query(
          `UPDATE audit_items SET condition=$1, size_value=$2, comment=$3, quantity=$4 WHERE id=$5`,
          [newCondition, item.size_value || null, item.comment || null, sanitizeQuantity(item.quantity) || 1, existingAI.id]
        );

        // Was not_good, now good → delete pending NCR + PPE request
        if (oldCondition === 'not_good' && newCondition !== 'not_good') {
          const { rows: ncrRows } = await client.query(
            'SELECT n.id, pr.id as pr_id, pr.status FROM ncr_items n LEFT JOIN ppe_requests pr ON pr.ncr_item_id=n.id WHERE n.audit_item_id=$1',
            [existingAI.id]
          );
          for (const ncr of ncrRows) {
            if (!isAdmin && ncr.status && !['pending','canceled'].includes(ncr.status)) {
              throw new Error(`Cannot remove ${item.ppe_item_id} — PPE request already actioned (${ncr.status}).`);
            }
            if (ncr.pr_id) await client.query('DELETE FROM ppe_requests WHERE id=$1', [ncr.pr_id]);
            await client.query('DELETE FROM ncr_items WHERE id=$1', [ncr.id]);
          }
        }

        // Was good/not_present, now not_good → create NCR + PPE request if no open one exists
        if (oldCondition !== 'not_good' && newCondition === 'not_good') {
          const personCol = existing.employee_id ? 'employee_id' : 'casual_id';
          const personId = existing.employee_id || existing.casual_id;
          const { rows: openReqs } = await client.query(
            `SELECT id FROM ppe_requests WHERE ${personCol}=$1 AND ppe_item_id=$2 AND status NOT IN ('distributed','resolved','canceled')`,
            [personId, item.ppe_item_id]
          );
          if (openReqs.length === 0) {
            const { rows: [ncr] } = await client.query(
              'INSERT INTO ncr_items (audit_item_id,employee_id,casual_id,ppe_item_id,condition,size_value,comment) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
              [existingAI.id, existing.employee_id || null, existing.casual_id || null, item.ppe_item_id, newCondition, item.size_value || null, item.comment || null]
            );
            await client.query(
              'INSERT INTO ppe_requests (ncr_item_id,employee_id,casual_id,ppe_item_id,size_value,status,flagged_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [ncr.id, existing.employee_id || null, existing.casual_id || null, item.ppe_item_id, item.size_value || null, 'pending', req.user.id]
            );
          }
          // Also update NCR size/comment if it exists
          await client.query(
            'UPDATE ncr_items SET size_value=$1, comment=$2 WHERE audit_item_id=$3',
            [item.size_value || null, item.comment || null, existingAI.id]
          );
          await client.query(
            'UPDATE ppe_requests SET size_value=$1 WHERE ncr_item_id IN (SELECT id FROM ncr_items WHERE audit_item_id=$2)',
            [item.size_value || null, existingAI.id]
          );
        }

        // Still not_good → update NCR + PPE request size/comment
        if (oldCondition === 'not_good' && newCondition === 'not_good') {
          await client.query(
            'UPDATE ncr_items SET size_value=$1, comment=$2 WHERE audit_item_id=$3',
            [item.size_value || null, item.comment || null, existingAI.id]
          );
          await client.query(
            'UPDATE ppe_requests SET size_value=$1 WHERE ncr_item_id IN (SELECT id FROM ncr_items WHERE audit_item_id=$2)',
            [item.size_value || null, existingAI.id]
          );
        }

      } else {
        // New item not previously in audit — insert it
        const { rows: [ai] } = await client.query(
          `INSERT INTO audit_items (audit_id,ppe_item_id,condition,size_value,comment,quantity) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [id, item.ppe_item_id, newCondition, item.size_value || null, item.comment || null, sanitizeQuantity(item.quantity) || 1]
        );
        if (newCondition === 'not_good') {
          const personCol = existing.employee_id ? 'employee_id' : 'casual_id';
          const personId = existing.employee_id || existing.casual_id;
          const { rows: openReqs } = await client.query(
            `SELECT id FROM ppe_requests WHERE ${personCol}=$1 AND ppe_item_id=$2 AND status NOT IN ('distributed','resolved','canceled')`,
            [personId, item.ppe_item_id]
          );
          if (openReqs.length === 0) {
            const { rows: [ncr] } = await client.query(
              'INSERT INTO ncr_items (audit_item_id,employee_id,casual_id,ppe_item_id,condition,size_value,comment) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
              [ai.id, existing.employee_id || null, existing.casual_id || null, item.ppe_item_id, newCondition, item.size_value || null, item.comment || null]
            );
            await client.query(
              'INSERT INTO ppe_requests (ncr_item_id,employee_id,casual_id,ppe_item_id,size_value,status,flagged_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [ncr.id, existing.employee_id || null, existing.casual_id || null, item.ppe_item_id, item.size_value || null, 'pending', req.user.id]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    const { rows: [updated] } = await pool.query('SELECT * FROM audits WHERE id=$1', [id]);
    res.json(updated);
  } catch(e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(400).json({ error: e.message || 'Server error' });
  } finally { client.release(); }
});

// NCR
app.get('/api/ncr', auth, async (req, res) => {
  try {
    let ncrRows;
    const ncrProjects = await getProjectFilter(req.user);
    const ncrClients = await getClientFilter(req.user);
    if ((ncrProjects !== null && ncrProjects.length === 0) || (ncrClients !== null && ncrClients.length === 0)) {
      ncrRows = [];
    } else {
      let ncrQ = `SELECT n.*,
          COALESCE(e.full_name, c.full_name) as employee_name,
          e.employee_number,
          COALESCE(e.national_id, c.national_id) as employee_national_id,
          COALESCE(e.project, c.project) as project,
          (n.casual_id IS NOT NULL) as is_casual,
          p.name as ppe_name,p.category,p.needs_pda,u.full_name as audited_by_name,COALESCE(ai.quantity,1) as quantity
        FROM ncr_items n
        LEFT JOIN employees e ON e.id=n.employee_id
        LEFT JOIN casuals c ON c.id=n.casual_id
        JOIN ppe_items p ON p.id=n.ppe_item_id
        LEFT JOIN audit_items ai ON ai.id=n.audit_item_id
        LEFT JOIN audits a ON a.id=ai.audit_id
        LEFT JOIN users u ON u.id=a.audited_by WHERE 1=1`;
      const ncrParams = [];
      if (ncrProjects !== null) { ncrParams.push(ncrProjects); ncrQ += ` AND COALESCE(e.project, c.project) = ANY($${ncrParams.length})`; }
      if (ncrClients !== null) { ncrParams.push(ncrClients); ncrQ += ` AND COALESCE(e.client, c.client) = ANY($${ncrParams.length})`; }
      ncrQ += ` ORDER BY n.created_at DESC`;
      const { rows: _ncrRows } = await pool.query(ncrQ, ncrParams);
      ncrRows = _ncrRows;
    }
    res.json(ncrRows);
  } catch(e) { console.error('NCR error:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/ncr/stats', auth, async (req, res) => {
  const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE status='pending') as pending, COUNT(*) FILTER (WHERE status='ehs_purchase_requested') as ordered, COUNT(*) FILTER (WHERE status IN ('resolved','distributed') AND updated_at >= date_trunc('month',NOW())) as resolved_this_month, COUNT(*) FILTER (WHERE status NOT IN ('resolved','distributed','canceled')) as total_open FROM ncr_items`);
  res.json(rows[0]);
});

app.put('/api/ncr/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const allowedRoles = ['admin', 'ehs_manager', 'project_director'];
  if (!allowedRoles.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  if (req.user.role === 'project_director' && status !== 'pda_approved') {
    return res.status(403).json({ error: 'Project Director can only set status to PDA Approved' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      `SELECT n.status, pr.id as ppe_request_id, pr.pda_approved_date, pi.needs_pda
       FROM ncr_items n
       LEFT JOIN ppe_requests pr ON pr.ncr_item_id = n.id
       LEFT JOIN ppe_items pi ON pi.id = n.ppe_item_id
       WHERE n.id = $1`,
      [req.params.id]
    );
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'NCR item not found' });
    }
    if (req.user.role === 'project_director' && current.status !== 'ehs_purchase_requested') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Can only approve items currently at EHS Purchase Requested' });
    }
    const skippingPda = current.needs_pda
      && current.status === 'ehs_purchase_requested'
      && !current.pda_approved_date
      && ['scm_ordered', 'warehouse_available', 'distributed'].includes(status);
    if (skippingPda) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This PPE item requires Project Director Approval before it can move to SCM Ordered' });
    }
    let updateQ;
    if (status === 'resolved') {
      updateQ = await client.query('UPDATE ncr_items SET status=$1, resolved_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *', [status, req.params.id]);
    } else {
      updateQ = await client.query('UPDATE ncr_items SET status=$1, resolved_at=NULL, updated_at=NOW() WHERE id=$2 RETURNING *', [status, req.params.id]);
    }
    const ncr = updateQ.rows[0];
    if (status === 'ehs_purchase_requested') {
      await client.query('UPDATE ppe_requests SET status=$1, date_purchase_requested=NOW(), purchase_requested_by=$2, updated_at=NOW() WHERE ncr_item_id=$3', ['ehs_purchase_requested', req.user.id, req.params.id]);
    }
    if (status === 'pda_approved') {
      await client.query('UPDATE ppe_requests SET status=$1, pda_approved_date=NOW(), pda_approved_by=$2, updated_at=NOW() WHERE ncr_item_id=$3', ['pda_approved', req.user.id, req.params.id]);
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
    const r1 = await pool.query("UPDATE ppe_requests SET status='ehs_purchase_requested' WHERE status IN ('purchase_requested','ordered') RETURNING id");
    const r2 = await pool.query("UPDATE ncr_items SET status='ehs_purchase_requested' WHERE status IN ('purchase_requested','ordered') RETURNING id");
    const r3 = await pool.query("UPDATE ncr_items SET status='distributed' WHERE status='resolved' RETURNING id");
    res.json({ ppe_fixed: r1.rowCount, ncr_fixed: r2.rowCount, resolved_fixed: r3.rowCount });
  } catch(e) { console.error('fix-statuses error:', e.message); res.status(500).json({ error: e.message }); }
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

app.delete('/api/ppe/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM ppe_items WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Cannot delete: this PPE item is referenced in existing audits. Set it to Inactive instead.' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ppe', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { name, category, has_size, size_type, sort_order, needs_pda } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'name and category required' });
  const { rows } = await pool.query(
    'INSERT INTO ppe_items (name, category, has_size, size_type, sort_order, is_active, needs_pda) VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING *',
    [name, category, has_size || false, size_type || null, sort_order || 99, needs_pda || false]
  );
  res.json(rows[0]);
});

app.put('/api/ppe/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { name, category, has_size, size_type, sort_order, is_active, needs_pda } = req.body;
  const { rows } = await pool.query(
    'UPDATE ppe_items SET name=$1, category=$2, has_size=$3, size_type=$4, sort_order=$5, is_active=$6, needs_pda=$7 WHERE id=$8 RETURNING *',
    [name, category, has_size, size_type || null, sort_order, is_active, needs_pda || false, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.get('/api/ppe-requests', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*,
        COALESCE(e.full_name, c.full_name) as employee_name,
        e.employee_number,
        COALESCE(e.national_id, c.national_id) as employee_national_id,
        COALESCE(e.employment_status, c.employment_status) as employment_status,
        COALESCE(e.job_title, c.job_title) as job_title,
        COALESCE(e.project, c.project) as project,
        COALESCE(e.client, c.client) as client,
        (r.casual_id IS NOT NULL) as is_casual,
        p.name as ppe_name, p.category, p.needs_pda,
        u0.full_name as flagged_by_name,
        u1.full_name as purchase_requested_by_name,
        u2.full_name as ordered_by_name,
        u3.full_name as available_by_name,
        u4.full_name as distributed_by_name,
        u5.full_name as pda_approved_by_name,
        l.name as location_name,
        COALESCE((SELECT ai3.quantity FROM audit_items ai3 JOIN ncr_items n3 ON n3.audit_item_id=ai3.id WHERE n3.id=r.ncr_item_id LIMIT 1), 1) as quantity
      FROM ppe_requests r
      LEFT JOIN employees e ON e.id=r.employee_id
      LEFT JOIN casuals c ON c.id=r.casual_id
      JOIN ppe_items p ON p.id=r.ppe_item_id
      LEFT JOIN audits a ON a.id=(SELECT ai2.audit_id FROM audit_items ai2 JOIN ncr_items n2 ON n2.audit_item_id=ai2.id WHERE n2.id=r.ncr_item_id LIMIT 1)
      LEFT JOIN locations l ON l.id=a.location_id
      LEFT JOIN users u0 ON u0.id=r.flagged_by
      LEFT JOIN users u1 ON u1.id=r.purchase_requested_by
      LEFT JOIN users u2 ON u2.id=r.ordered_by
      LEFT JOIN users u3 ON u3.id=r.available_by
      LEFT JOIN users u4 ON u4.id=r.distributed_by
      LEFT JOIN users u5 ON u5.id=r.pda_approved_by
      ORDER BY
        CASE r.status
          WHEN 'pending' THEN 1
          WHEN 'ehs_purchase_requested' THEN 2
          WHEN 'scm_ordered' THEN 3
          WHEN 'warehouse_available' THEN 4
          WHEN 'distributed' THEN 5
          WHEN 'canceled' THEN 6
          ELSE 7
        END,
        r.date_flagged DESC
    `);
    const ppeProjects = await getProjectFilter(req.user);
    const ppeClients = await getClientFilter(req.user);
    let filteredRows = rows;
    if (ppeProjects !== null) {
      if (ppeProjects.length === 0) filteredRows = [];
      else filteredRows = filteredRows.filter(r => ppeProjects.includes(r.project));
    }
    if (ppeClients !== null) {
      if (ppeClients.length === 0) filteredRows = [];
      else filteredRows = filteredRows.filter(r => ppeClients.includes(r.client));
    }
    res.json(filteredRows);
  } catch(e) { console.error('PPE requests error:', e.message); res.status(500).json({ error: e.message }); }
});

app.put('/api/ppe-requests/:id/status', auth, async (req, res) => {
  const { status, distribution_method, courier_tracking_number } = req.body;
  const allowedRoles = ['admin', 'scm_officer', 'ehs_manager', 'project_director'];
  if (!allowedRoles.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  if (req.user.role === 'scm_officer' && ['pending', 'ehs_purchase_requested', 'pda_approved'].includes(status)) {
    return res.status(403).json({ error: 'SCM Officer can only update from PDA Approved onwards' });
  }
  if (req.user.role === 'project_director' && status !== 'pda_approved') {
    return res.status(403).json({ error: 'Project Director can only set status to PDA Approved' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      'SELECT pr.status, pr.pda_approved_date, pi.needs_pda FROM ppe_requests pr JOIN ppe_items pi ON pr.ppe_item_id = pi.id WHERE pr.id = $1',
      [req.params.id]
    );
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'PPE request not found' });
    }
    const skippingPda = current.needs_pda
      && current.status === 'ehs_purchase_requested'
      && !current.pda_approved_date
      && ['scm_ordered', 'warehouse_available', 'distributed'].includes(status);
    if (skippingPda) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This PPE item requires Project Director Approval before it can move to SCM Ordered' });
    }
    if (req.user.role === 'project_director' && current.status !== 'ehs_purchase_requested') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Can only approve items currently at EHS Purchase Requested' });
    }
    let extraFields = '';
    let extraParams = [status, req.params.id];
    if (status === 'ehs_purchase_requested') extraFields = ', date_purchase_requested=NOW(), purchase_requested_by=$3';
    if (status === 'pda_approved') extraFields = ', pda_approved_date=NOW(), pda_approved_by=$3';
    if (status === 'scm_ordered') { extraParams.push(req.user.id); extraFields = ', date_ordered=NOW(), ordered_by=$3, po_number=$4'; extraParams.push(req.body.po_number || null); }
    if (status === 'warehouse_available') extraFields = ', date_available=NOW(), available_by=$3, date_ordered=COALESCE(date_ordered,NOW()), ordered_by=COALESCE(ordered_by,$3)';
    if (status === 'distributed') {
      extraParams.push(req.user.id); // $3
      extraFields = ', date_distributed=NOW(), distributed_by=$3, date_available=COALESCE(date_available,NOW()), available_by=COALESCE(available_by,$3), date_ordered=COALESCE(date_ordered,NOW()), ordered_by=COALESCE(ordered_by,$3)';
      if (distribution_method) { extraFields += ', distribution_method=$4'; extraParams.push(distribution_method); }
      if (distribution_method && courier_tracking_number) { extraFields += ', courier_tracking_number=$5'; extraParams.push(courier_tracking_number); }
    } else if (status !== 'scm_ordered' && extraFields.includes('$3')) {
      extraParams.push(req.user.id);
    }
    const { rows: [r] } = await client.query(
      'UPDATE ppe_requests SET status=$1' + extraFields + ', updated_at=NOW() WHERE id=$2 RETURNING *',
      extraParams
    );
    if (r.ncr_item_id) {
      if (status === 'distributed') {
        await client.query('UPDATE ncr_items SET status=$1, resolved_at=NOW(), updated_at=NOW() WHERE id=$2', ['distributed', r.ncr_item_id]);
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


// Sync log
app.post('/api/sync-log', auth, async (req, res) => {
  const { triggered_by } = req.body;
  await pool.query('INSERT INTO sync_log (triggered_by) VALUES ($1)', [triggered_by || 'power_automate']);
  res.json({ ok: true });
});

app.get('/api/sync-log/latest', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1');
  res.json(rows[0] || null);
});

// Start
const PORT = 8080;

// ── Locations ──────────────────────────────────────────────
app.get('/api/locations', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM locations WHERE active=TRUE ORDER BY name ASC');
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/locations', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows: [loc] } = await pool.query(
      'INSERT INTO locations (name) VALUES ($1) RETURNING *', [name.trim()]
    );
    res.json(loc);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Location already exists' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/locations/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, active } = req.body;
  try {
    const { rows: [loc] } = await pool.query(
      'UPDATE locations SET name=COALESCE($1,name), active=COALESCE($2,active) WHERE id=$3 RETURNING *',
      [name?.trim() || null, active !== undefined ? active : null, req.params.id]
    );
    if (!loc) return res.status(404).json({ error: 'Not found' });
    res.json(loc);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Location name already exists' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/locations/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows } = await pool.query('SELECT COUNT(*) FROM audits WHERE location_id=$1', [req.params.id]);
    if (parseInt(rows[0].count) > 0) return res.status(400).json({ error: 'Cannot delete: location is used in existing audits. Deactivate it instead.' });
    await pool.query('DELETE FROM locations WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});


app.post('/api/admin/seed-locations', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query(`
      INSERT INTO locations (name) VALUES
        ('Bomet'),('Chogoria'),('Coast Hola'),('Dadaab'),('Eldoret'),
        ('Elwak'),('Embu'),('Garissa'),('Karatina'),('Kericho'),
        ('Kitale'),('Lodwar'),('Makutano'),('Mandera'),('Marsabit 1'),
        ('Marsabit 2'),('Maua'),('Meru'),('Modogashe'),('Moyale'),
        ('Murang''a'),('Mutu'),('Mwea'),('Mwingi'),('Nairobi'),
        ('Nakuru'),('Nanyuki'),('Narok'),('Naivasha'),('North Horr'),
        ('Nyahururu'),('Nyeri'),('Takaba'),('Thika'),('Wajir 1'),
        ('Wajir 2')
      ON CONFLICT (name) DO NOTHING
    `);
    const { rows } = await pool.query('SELECT COUNT(*) FROM locations');
    res.json({ success: true, count: rows[0].count });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/backfill-page-access', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const fullPages = ['/','/employees','/audit/new','/history','/ncr','/ppe-tracker','/graphs'];
    const { rowCount } = await pool.query(
      `UPDATE users SET page_access=$1, updated_at=NOW()
       WHERE role <> 'admin' AND (page_access IS NULL OR page_access = '{}')`,
      [fullPages]
    );
    res.json({ success: true, updated: rowCount });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});


app.post('/api/admin/replace-ppe-items', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  const jwt = require('jsonwebtoken');
  let user;
  try { user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM employee_ppe_assignments');
    await client.query('DELETE FROM ppe_items');
    await client.query(`
      INSERT INTO ppe_items (name, category, has_size, size_type, sort_order, is_active) VALUES
('Overall - EGYPRO Printed - With Reflective Straps - Blue', 'body_protection', true, 'clothing', 1, true),
('Rain Coat - EGYPRO Printed', 'body_protection', true, 'clothing', 2, true),
('Reflector Vest - (EN 471) - EGYPRO Printed', 'body_protection', true, 'clothing', 3, true),
('Safety Gumboot - (EN 20345/6)', 'body_protection', true, 'shoe', 4, true),
('Safety Shoes - (EN 20345) - PROTECTA (S3) - High Neck', 'body_protection', true, 'shoe', 5, true),
('Safety Shoes - (EN 20345) - PROTECTA (S3) - Normal Neck', 'body_protection', true, 'shoe', 6, true),
('Hand Gloves - (EN 388) - Basic Safety Protection', 'body_protection', false, NULL, 7, true),
('Hand Gloves - (EN 388) - Impact Resistant', 'body_protection', false, NULL, 8, true),
('Hand Gloves - Leather Size 14 - Cable Pulling', 'body_protection', false, NULL, 9, true),
('Chin Strap (Helmet)', 'body_protection', false, NULL, 10, true),
('Earmuff - (EN 352)', 'body_protection', false, NULL, 11, true),
('Eye Protection Goggles - (EN 166)', 'body_protection', false, NULL, 12, true),
('Respirator Half Mask', 'body_protection', false, NULL, 13, true),
('Safety Helmet - (EN 397) - Blue', 'body_protection', false, NULL, 14, true),
('Safety Helmet - (EN 397) - White', 'body_protection', false, NULL, 15, true),
('WAH Helmet - (EN 397) - White', 'body_protection', false, NULL, 16, true),
('Book - Fuel Truck Checklist - Egypro/Huawei', 'documentation_safety_signage', false, NULL, 17, true),
('Book - Fuel Truck Checklist - Egypro/SFC', 'documentation_safety_signage', false, NULL, 18, true),
('Book - Vehicle Checklist', 'documentation_safety_signage', false, NULL, 19, true),
('Book - EHS - Egypro/Huawei', 'documentation_safety_signage', false, NULL, 20, true),
('Book - EHS - Egypro/SFC', 'documentation_safety_signage', false, NULL, 21, true),
('EHS Absolute Rules - A4 - Laminated Sign', 'documentation_safety_signage', false, NULL, 22, true),
('Reflective Tape 2in (5cm width) 50m - Self Adhesive - White 3M', 'documentation_safety_signage', false, NULL, 23, true),
('Safety Banner - Egypro/Huawei 1m X 1m', 'documentation_safety_signage', false, NULL, 24, true),
('Safety Banner - Emergency Assembly Point 1m X 1m', 'documentation_safety_signage', false, NULL, 25, true),
('Safety Banner - Safety Points 1m X 1m', 'documentation_safety_signage', false, NULL, 26, true),
('Sign - Men At work With Speed Limit - Egypro/SFC - Metal', 'documentation_safety_signage', false, NULL, 27, true),
('Body Harness - (EN 813)', 'fall_protection', false, NULL, 28, true),
('Climber Straps', 'fall_protection', false, NULL, 29, true),
('Climbers - Concrete Pole - Adjustable - with Rubber Grip', 'fall_protection', false, NULL, 30, true),
('Climbers - Wooden Pole - Adjustable - Spikes Size 8.5', 'fall_protection', false, NULL, 31, true),
('Double Lanyard with shock absorber - (EN 362) or (EN 355) or (EN 354)', 'fall_protection', false, NULL, 32, true),
('Work Positioning Lanyard with grip adjuster - (EN 358)', 'fall_protection', false, NULL, 33, true),
('Anchorage Sling - (EN 566) - 1.5m', 'fall_protection', false, NULL, 34, true),
('Non Return Pulley System - (EN 567)', 'fall_protection', false, NULL, 35, true),
('Rescue Kit', 'fall_protection', false, NULL, 36, true),
('Safety Rope - (EN 1891:1998) - 100m', 'fall_protection', false, NULL, 37, true),
('Safety Rope - (EN 1891:1998) - 200m', 'fall_protection', false, NULL, 38, true),
('Safety Rope - (EN 1891:1998) - 25m', 'fall_protection', false, NULL, 39, true),
('Waist Tool Bag', 'fall_protection', false, NULL, 40, true),
('Ladder - Foldable - Fiber Glass - 4X3 Steps - (3.7m)', 'general_safety', false, NULL, 41, true),
('Ladder - Foldable - Fiber Glass - 4X4 Steps - (4.7m)', 'general_safety', false, NULL, 42, true),
('Ladder - Foldable - Fiber Glass - 4X5 Steps - (6.6m)', 'general_safety', false, NULL, 43, true),
('Ladder - Foldable - Fiber Glass - 4X6 Steps - (7.8m)', 'general_safety', false, NULL, 44, true),
('Jerrycan - Fuel - Metal - 20 Litres', 'general_safety', false, NULL, 45, true),
('Jerrycan - Transparent - Water - Plastic - 20 Litres', 'general_safety', false, NULL, 46, true),
('Fire Extinguisher - 6KG - Dry Powder With Inspection Sticker', 'general_safety', false, NULL, 47, true),
('First Aid Kit - Category A - Small', 'general_safety', false, NULL, 48, true),
('First Aid Kit - Category B - Medium', 'general_safety', false, NULL, 49, true),
('First Aid Kit - Category C - Large', 'general_safety', false, NULL, 50, true),
('Flag - Green', 'general_safety', false, NULL, 51, true),
('Flag - Red', 'general_safety', false, NULL, 52, true),
('Life Saver Triangle (Road Safety Reflective Warning Triangle) - Pair', 'general_safety', false, NULL, 53, true),
('Tent - 30mm Aluminum - (3m x 3m) - Roof Only - Gazebo', 'general_safety', false, NULL, 54, true),
('Cones - Reflector strap - 70cm', 'general_safety', false, NULL, 55, true),
('Safety Net - 1m X 50m - Orange', 'general_safety', false, NULL, 56, true),
('Crimping Tool - RJ45', 'maintenance_tools', false, NULL, 57, true),
('Hacksaw Frame - Size 300mm/12in - INGCO (HHFS3068)', 'maintenance_tools', false, NULL, 58, true),
('Hammer - Claw - Fiberglass handle - Weight 450g - INGCO (HCH81016)', 'maintenance_tools', false, NULL, 59, true),
('Hex Allen Key - 9pcs Set - Long Arm - INGCO (HHK11091)', 'maintenance_tools', false, NULL, 60, true),
('Torx (Star) Allen Key - 9pcs Set - Long Arm - INGCO (HHK13091)', 'maintenance_tools', false, NULL, 61, true),
('Cutting Pliers 7in - 1000V Insulated - INGCO (HIHDCP28188)', 'maintenance_tools', false, NULL, 62, true),
('Hand Tools Set - 16pcs - 1000V Insulated - INGCO (HKISPA0702)', 'maintenance_tools', false, NULL, 63, true),
('Insulated Adjustable Wrench / Spanner 10in - INGCO (HIADW101)', 'maintenance_tools', false, NULL, 64, true),
('Spanner Wrench Set - 7pcs - 1000V Insulated - Open End - INGCO (HKISPA0701)', 'maintenance_tools', false, NULL, 65, true),
('Spanner Wrench Set - 7pcs - 1000V Insulated - Ring End - INGCO (HKISPA0702)', 'maintenance_tools', false, NULL, 66, true),
('Contactless AC voltage detector - UNI-T', 'maintenance_tools', false, NULL, 67, true),
('High Pressure Washer - 2500W - 160BAR - 6L/MIN - 5m Hose - INGCO (HPWR25008)', 'maintenance_tools', false, NULL, 68, true),
('Pressure Sprayer 2L - INGCO (HSPP20202)', 'maintenance_tools', false, NULL, 69, true),
('Shield Microfibre Telescopic Wash Mop - 2m', 'maintenance_tools', false, NULL, 70, true),
('Converter Plug Adapter (2 Pin to 3 Pin) 13Amp', 'maintenance_tools', false, NULL, 71, true),
('Extension Cable Reel - 25 Meter - 2.5mm 3 Core', 'maintenance_tools', false, NULL, 72, true),
('Blower Aspirator 650W - INGCO (AB6038)', 'maintenance_tools', false, NULL, 73, true),
('Drilling Machine - Impact - INGCO (ID8108)', 'maintenance_tools', false, NULL, 74, true),
('Heat Gun - 2000W - INGCO (HG200078)', 'maintenance_tools', false, NULL, 75, true),
('Hand Gloves - (EN 60903) - 1KV - Rubber Electrical Insulating - Class 0', 'testing_measuring', false, NULL, 76, true),
('Hand Gloves - (EN 60903) - 33KV - Rubber Electrical Insulating - Class 4', 'testing_measuring', false, NULL, 77, true),
('Helmet Mounted High Voltage Detector - (HHVSB11) - Honeywell', 'testing_measuring', false, NULL, 78, true),
('LOTOTO kit (Lockout, Tagout, Tryout)', 'testing_measuring', false, NULL, 79, true),
('Digital Clamp Meter - AC/DC - Uni-T (UT203)', 'testing_measuring', false, NULL, 80, true),
('KPLC Safety Instrument Test Kit - High Voltage Personal Alert, 50KV Handle, Conduit Adapter - SureTech', 'testing_measuring', false, NULL, 81, true),
('Laser Distance Detector - 0.05-100m - INGCO (HLDD1008)', 'testing_measuring', false, NULL, 82, true),
('Tel-O-Pole Measuring Stick - Fiberglass - 40FT', 'testing_measuring', false, NULL, 83, true)
    `);
    await client.query('COMMIT');
    const { rows } = await client.query('SELECT COUNT(*) FROM ppe_items');
    res.json({ success: true, count: rows[0].count });
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});


// ── Email / Resend ────────────────────────────────────────────
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendDailySCMDigest() {
  try {
    const { rows: pending } = await pool.query(`
      SELECT COUNT(*) as count, MAX(CURRENT_DATE - date_flagged::date) as oldest_days
      FROM ppe_requests WHERE status = 'ehs_purchase_requested'
    `);
    const count = parseInt(pending[0].count);
    const oldestDays = parseInt(pending[0].oldest_days) || 0;
    const { rows: ordered } = await pool.query(`
      SELECT COUNT(*) as count, MAX(CURRENT_DATE - date_ordered::date) as oldest_days
      FROM ppe_requests WHERE status = 'scm_ordered'
    `);
    const orderedCount = parseInt(ordered[0].count);
    const orderedOldestDays = parseInt(ordered[0].oldest_days) || 0;

    if (count === 0 && orderedCount === 0) return;

    await resend.emails.send({
        from: 'ESAT <esat@egypro.app>',
        to: 'e.maged@outlook.com',
        subject: `ESAT Daily SCM — ${count + orderedCount} Pending PPE/Tool Item${(count + orderedCount) > 1 ? 's' : ''} Awaiting Action`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-radius: 8px 8px 0 0; border-bottom: 2px solid #0f2a4a;"><tr><td bgcolor="#ffffff" align="center" style="padding: 16px 24px;">
              <img src="https://esat.egypro.app/esat-login-logo.png" alt="ESAT" width="110" height="50" style="height:50px; width:110px; display:block; margin:0 auto;" />
            </td></tr></table>
            <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="font-size: 15px; color: #374151;">Hello Supply Chain Team,</p>
              ${count > 0 ? `<p style="font-size: 15px; color: #374151;">
                We have <strong style="color: #0f2a4a;">${count} pending PPE/Tool item${count > 1 ? 's' : ''}</strong>
                to be ordered or to confirm availability. The oldest item has been waiting for
                <strong style="color: ${oldestDays > 0 ? '#e53e3e' : '#374151'};">${oldestDays} day${oldestDays !== 1 ? 's' : ''}</strong>.
              </p>` : ''}
              ${orderedCount > 0 ? `<p style="font-size: 15px; color: #374151;">
                And our Suppliers have <strong style="color: #0f2a4a;">${orderedCount} pending PPE/Tool item${orderedCount > 1 ? 's' : ''}</strong>
                to be delivered to our warehouse. The oldest item has been waiting for
                <strong style="color: ${orderedOldestDays > 0 ? '#e53e3e' : '#374151'};">${orderedOldestDays} day${orderedOldestDays !== 1 ? 's' : ''}</strong>.
              </p>` : ''}
              <p style="font-size: 15px; color: #374151;">Please check the ESAT system to clear the pending list.</p>
              <a href="https://esat.egypro.app"
                style="display: inline-block; background: #1D9E75; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">
                Open ESAT
              </a>
              <p style="font-size: 14px; color: #374151; margin-top: 24px;">Thanks,<br/>Maged Ezzat</p>
            </div>
          </div>
        `
      });
    console.log('SCM digest sent — ' + count + ' pending, ' + orderedCount + ' ordered');
  } catch(e) {
    console.error('SCM digest error:', e.message);
  }
}




async function sendDailyBTSDigest() {
  try {
    const btsProjects = ['Active MS', 'BTS - MS', 'BTS - MS - MK', 'BTS - MS - NE', 'BTS - Rollout', 'Fuel', 'TI', 'Workshop'];
    const { rows: pending } = await pool.query(`
      SELECT COUNT(*) as count, MAX(CURRENT_DATE - date_available::date) as oldest_days
      FROM ppe_requests r
      LEFT JOIN employees e ON e.id = r.employee_id
      LEFT JOIN casuals c ON c.id = r.casual_id
      WHERE r.status = 'warehouse_available'
      AND COALESCE(e.project, c.project) = ANY($1)
    `, [btsProjects]);
    const count = parseInt(pending[0].count);
    const oldestDays = parseInt(pending[0].oldest_days) || 0;
    if (count === 0) return;
    const { rows: byProject } = await pool.query(`
      SELECT COALESCE(e.project, c.project) as project, COALESCE(e.client, c.client) as client, COUNT(*) as count, MAX(CURRENT_DATE - date_available::date) as oldest_days
      FROM ppe_requests r
      LEFT JOIN employees e ON e.id = r.employee_id
      LEFT JOIN casuals c ON c.id = r.casual_id
      WHERE r.status = 'warehouse_available'
      AND COALESCE(e.project, c.project) = ANY($1)
      GROUP BY COALESCE(e.project, c.project), COALESCE(e.client, c.client)
      ORDER BY count DESC
    `, [btsProjects]);
    const projectRowsHtml = byProject.map(p => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; color: #374151;">${escapeHtml(p.project)}${p.client ? `<div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">${escapeHtml(p.client)}</div>` : ''}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; color: #0f2a4a; font-weight: 600; text-align: center;">${p.count}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; text-align: center; color: ${parseInt(p.oldest_days) > 0 ? '#e53e3e' : '#374151'};">${parseInt(p.oldest_days) || 0}</td>
      </tr>`).join('');

    await resend.emails.send({
      from: 'ESAT <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `ESAT Daily BTS Projects — ${count} Pending PPE/Tool Item${count > 1 ? 's' : ''} Awaiting Action`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-radius: 8px 8px 0 0; border-bottom: 2px solid #0f2a4a;"><tr><td bgcolor="#ffffff" align="center" style="padding: 16px 24px;">
            <img src="https://esat.egypro.app/esat-login-logo.png" alt="ESAT" width="110" height="50" style="height:50px; width:110px; display:block; margin:0 auto;" />
          </td></tr></table>
          <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="font-size: 15px; color: #374151;">Hello BTS Project Team,</p>
            <p style="font-size: 15px; color: #374151;">
              We have <strong style="color: #0f2a4a;">${count} available PPE/Tool item${count > 1 ? 's' : ''}</strong>
              at our warehouse to be collected. The oldest item has been waiting for
              <strong style="color: ${oldestDays > 0 ? '#e53e3e' : '#374151'};">${oldestDays} day${oldestDays !== 1 ? 's' : ''}</strong>.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden;">
              <tr style="background: #f3f4f6;">
                <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Project</th>
                <th style="padding: 8px 12px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">Items</th>
                <th style="padding: 8px 12px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">Oldest (days)</th>
              </tr>
              ${projectRowsHtml}
            </table>
            <p style="font-size: 15px; color: #374151;">Please check the ESAT system to clear the pending list.</p>
            <a href="https://esat.egypro.app"
              style="display: inline-block; background: #1D9E75; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">
              Open ESAT
            </a>
            <p style="font-size: 14px; color: #374151; margin-top: 24px;">Thanks,<br/>Maged Ezzat</p>
          </div>
        </div>
      `
    });
    console.log('BTS digest sent — ' + count + ' items');
  } catch(e) {
    console.error('BTS digest error:', e.message);
  }
}

async function sendDailyFibreDigest() {
  try {
    const fibreProjects = ['FTTX Rollout', 'Fibre Home', 'Fibre MS', 'Fibre Rollout'];
    const { rows: pending } = await pool.query(`
      SELECT COUNT(*) as count, MAX(CURRENT_DATE - date_available::date) as oldest_days
      FROM ppe_requests r
      LEFT JOIN employees e ON e.id = r.employee_id
      LEFT JOIN casuals c ON c.id = r.casual_id
      WHERE r.status = 'warehouse_available'
      AND COALESCE(e.project, c.project) = ANY($1)
    `, [fibreProjects]);
    const count = parseInt(pending[0].count);
    const oldestDays = parseInt(pending[0].oldest_days) || 0;
    if (count === 0) return;
    const { rows: byProject } = await pool.query(`
      SELECT COALESCE(e.project, c.project) as project, COALESCE(e.client, c.client) as client, COUNT(*) as count, MAX(CURRENT_DATE - date_available::date) as oldest_days
      FROM ppe_requests r
      LEFT JOIN employees e ON e.id = r.employee_id
      LEFT JOIN casuals c ON c.id = r.casual_id
      WHERE r.status = 'warehouse_available'
      AND COALESCE(e.project, c.project) = ANY($1)
      GROUP BY COALESCE(e.project, c.project), COALESCE(e.client, c.client)
      ORDER BY count DESC
    `, [fibreProjects]);
    const projectRowsHtml = byProject.map(p => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; color: #374151;">${escapeHtml(p.project)}${p.client ? `<div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">${escapeHtml(p.client)}</div>` : ''}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; color: #0f2a4a; font-weight: 600; text-align: center;">${p.count}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; text-align: center; color: ${parseInt(p.oldest_days) > 0 ? '#e53e3e' : '#374151'};">${parseInt(p.oldest_days) || 0}</td>
      </tr>`).join('');

    await resend.emails.send({
      from: 'ESAT <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `ESAT Daily Fibre Projects — ${count} Pending PPE/Tool Item${count > 1 ? 's' : ''} Awaiting Action`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-radius: 8px 8px 0 0; border-bottom: 2px solid #0f2a4a;"><tr><td bgcolor="#ffffff" align="center" style="padding: 16px 24px;">
            <img src="https://esat.egypro.app/esat-login-logo.png" alt="ESAT" width="110" height="50" style="height:50px; width:110px; display:block; margin:0 auto;" />
          </td></tr></table>
          <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="font-size: 15px; color: #374151;">Hello Fibre Project Team,</p>
            <p style="font-size: 15px; color: #374151;">
              We have <strong style="color: #0f2a4a;">${count} available PPE/Tool item${count > 1 ? 's' : ''}</strong>
              at our warehouse to be collected. The oldest item has been waiting for
              <strong style="color: ${oldestDays > 0 ? '#e53e3e' : '#374151'};">${oldestDays} day${oldestDays !== 1 ? 's' : ''}</strong>.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden;">
              <tr style="background: #f3f4f6;">
                <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Project</th>
                <th style="padding: 8px 12px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">Items</th>
                <th style="padding: 8px 12px; text-align: center; font-size: 12px; color: #6b7280; text-transform: uppercase;">Oldest (days)</th>
              </tr>
              ${projectRowsHtml}
            </table>
            <p style="font-size: 15px; color: #374151;">Please check the ESAT system to clear the pending list.</p>
            <a href="https://esat.egypro.app"
              style="display: inline-block; background: #1D9E75; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">
              Open ESAT
            </a>
            <p style="font-size: 14px; color: #374151; margin-top: 24px;">Thanks,<br/>Maged Ezzat</p>
          </div>
        </div>
      `
    });
    console.log('Fibre digest sent — ' + count + ' items');
  } catch(e) {
    console.error('Fibre digest error:', e.message);
  }
}

async function sendDailyEHSDigest() {
  try {
    const { rows: pending } = await pool.query(`
      SELECT COUNT(*) as count, MAX(CURRENT_DATE - date_flagged::date) as oldest_days
      FROM ppe_requests WHERE status = 'pending'
    `);
    const count = parseInt(pending[0].count);
    const oldestDays = parseInt(pending[0].oldest_days) || 0;
    if (count === 0) return;

    await resend.emails.send({
      from: 'ESAT <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `ESAT Daily EHS — ${count} Pending PPE/Tool Item${count > 1 ? 's' : ''} Awaiting Action`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-radius: 8px 8px 0 0; border-bottom: 2px solid #0f2a4a;"><tr><td bgcolor="#ffffff" align="center" style="padding: 16px 24px;">
            <img src="https://esat.egypro.app/esat-login-logo.png" alt="ESAT" width="110" height="50" style="height:50px; width:110px; display:block; margin:0 auto;" />
          </td></tr></table>
          <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="font-size: 15px; color: #374151;">Hello John,</p>
            <p style="font-size: 15px; color: #374151;">
              We have <strong style="color: #0f2a4a;">${count} pending PPE/Tool item${count > 1 ? 's' : ''}</strong>
              that require a purchase request. The oldest item has been waiting for
              <strong style="color: ${oldestDays > 0 ? '#e53e3e' : '#374151'};">${oldestDays} day${oldestDays !== 1 ? 's' : ''}</strong>.
            </p>
            <p style="font-size: 15px; color: #374151;">Please check the ESAT system to clear the pending list.</p>
            <a href="https://esat.egypro.app"
              style="display: inline-block; background: #1D9E75; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">
              Open ESAT
            </a>
            <p style="font-size: 14px; color: #374151; margin-top: 24px;">Thanks,<br/>Maged Ezzat</p>
          </div>
        </div>
      `
    });
    console.log('EHS digest sent — ' + count + ' pending items');
  } catch(e) {
    console.error('EHS digest error:', e.message);
  }
}

// Schedule daily digests
function scheduleAt(utcHour, utcMin, label, fn) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(utcHour, utcMin, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next - now;
  console.log(label + ' scheduled in ' + Math.floor(ms/3600000) + 'h ' + Math.floor((ms%3600000)/60000) + 'm');
  setTimeout(() => { fn(); setInterval(fn, 24*60*60*1000); }, ms);
}


async function sendDailyOverdueDigest() {
  try {
    const { rows } = await pool.query(`
      SELECT
        e.client,
        e.project,
        COUNT(*) as overdue_count,
        MAX(COALESCE(CURRENT_DATE - a.audit_date::date, 9999)) as max_days,
        (SELECT e2.full_name FROM employees e2
          LEFT JOIN audits a2 ON a2.employee_id = e2.id
          WHERE e2.project = e.project AND e2.client = e.client
            AND e2.employment_status = 'active' AND e2.san = true
          GROUP BY e2.id, e2.full_name
          ORDER BY MAX(COALESCE(CURRENT_DATE - a2.audit_date::date, 9999)) DESC
          LIMIT 1) as oldest_employee,
        (SELECT MAX(COALESCE(CURRENT_DATE - a2.audit_date::date, 9999))
          FROM employees e2
          LEFT JOIN audits a2 ON a2.employee_id = e2.id
          WHERE e2.project = e.project AND e2.client = e.client
            AND e2.employment_status = 'active' AND e2.san = true
          GROUP BY e2.id
          ORDER BY 1 DESC
          LIMIT 1) as oldest_days
      FROM employees e
      LEFT JOIN (
        SELECT DISTINCT ON (employee_id) employee_id, audit_date
        FROM audits WHERE employee_present = TRUE ORDER BY employee_id, audit_date DESC
      ) a ON a.employee_id = e.id
      WHERE e.employment_status = 'active' AND e.san = true
        AND COALESCE(CURRENT_DATE - a.audit_date::date, 9999) > 30
      GROUP BY e.client, e.project
      ORDER BY e.client, e.project
    `);

    if (rows.length === 0) return;

    const totalOverdue = rows.reduce((sum, r) => sum + parseInt(r.overdue_count), 0);

    // Group by client
    const byClient = {};
    rows.forEach(r => {
      const client = r.client || '—';
      if (!byClient[client]) byClient[client] = [];
      byClient[client].push(r);
    });

    let tableRows = '';
    Object.entries(byClient).forEach(([client, projects]) => {
      tableRows += `<tr><td colspan="3" style="background:#0f2a4a;color:white;font-weight:700;font-size:13px;padding:8px 12px;">${escapeHtml(client)}</td></tr>`;
      projects.forEach(r => {
        const days = parseInt(r.oldest_days) || 0;
        const daysColor = days > 60 ? '#e53e3e' : days > 30 ? '#e65100' : '#1d9e75';
        tableRows += `
          <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:8px 12px;font-size:13px;padding-left:24px;">${escapeHtml(r.project) || '—'}</td>
            <td style="padding:8px 12px;font-size:13px;text-align:center;font-weight:700;color:#0f2a4a;">${r.overdue_count}</td>
            <td style="padding:8px 12px;font-size:12px;">${escapeHtml(r.oldest_employee) || '—'} <span style="color:${daysColor};font-weight:700;">(${days}d)</span></td>
          </tr>`;
      });
    });

    await resend.emails.send({
      from: 'ESAT <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `ESAT Daily — ${totalOverdue} Overdue Audit${totalOverdue > 1 ? 's' : ''} Across Projects`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-radius: 8px 8px 0 0; border-bottom: 2px solid #0f2a4a;"><tr><td bgcolor="#ffffff" align="center" style="padding: 16px 24px;">
            <img src="https://esat.egypro.app/esat-login-logo.png" alt="ESAT" width="110" height="50" style="height:50px; width:110px; display:block; margin:0 auto;" />
          </td></tr></table>
          <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="margin:0 0 16px;font-size:15px;color:#111;">Hello Maged,</p>
            <p style="margin:0 0 20px;font-size:14px;color:#374151;">Here is today's overdue audit summary. <strong>${totalOverdue} employee${totalOverdue > 1 ? 's are' : ' is'}</strong> overdue for a PPE/Tool audit (>30 days).</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:white;">
              <tr style="background:#f3f4f6;">
                <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;">PROJECT</th>
                <th style="padding:8px 12px;text-align:center;font-size:12px;color:#6b7280;font-weight:600;">OVERDUE</th>
                <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;">OLDEST DUE</th>
              </tr>
              ${tableRows}
            </table>
            <p style="margin:24px 0 0;font-size:13px;color:#6b7280;">Thanks, Maged Ezzat</p>
          </div>
        </div>`
    });
    console.log('Overdue digest sent — ' + totalOverdue + ' overdue');
  } catch(e) { console.error('Overdue digest error:', e.message); }
}

function scheduleDailyDigest() {
  scheduleAt(5, 30, 'Fibre digest', sendDailyFibreDigest);  // 8:30am EAT
  scheduleAt(5, 35, 'BTS digest', sendDailyBTSDigest);      // 8:35am EAT
  scheduleAt(5, 45, 'EHS digest', sendDailyEHSDigest);      // 8:45am EAT
  scheduleAt(6,  0, 'SCM digest', sendDailySCMDigest);      // 9:00am EAT
  scheduleAt(13, 0, 'Overdue digest', sendDailyOverdueDigest); // 4:00pm EAT
}

app.post('/api/admin/test-bts-digest', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await sendDailyBTSDigest();
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/test-fibre-digest', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await sendDailyFibreDigest();
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/test-ehs-digest', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows: pending } = await pool.query(`
      SELECT COUNT(*) as count, MAX(CURRENT_DATE - date_flagged::date) as oldest_days
      FROM ppe_requests WHERE status = 'pending'
    `);
    const count = parseInt(pending[0].count);
    const oldestDays = parseInt(pending[0].oldest_days) || 0;
    if (count === 0) return res.json({ success: true, count, message: 'No pending items, email not sent' });
    await resend.emails.send({
      from: 'ESAT <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `ESAT Daily EHS — ${count} Pending PPE/Tool Item${count > 1 ? 's' : ''} Awaiting Action`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-radius: 8px 8px 0 0; border-bottom: 2px solid #0f2a4a;"><tr><td bgcolor="#ffffff" align="center" style="padding: 16px 24px;">
            <img src="https://esat.egypro.app/esat-login-logo.png" alt="ESAT" width="110" height="50" style="height:50px; width:110px; display:block; margin:0 auto;" />
          </td></tr></table>
          <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="font-size: 15px; color: #374151;">Hello John,</p>
            <p style="font-size: 15px; color: #374151;">
              We have <strong style="color: #0f2a4a;">${count} pending PPE/Tool item${count > 1 ? 's' : ''}</strong>
              that require a purchase request. The oldest item has been waiting for
              <strong style="color: ${oldestDays > 0 ? '#e53e3e' : '#374151'};">${oldestDays} day${oldestDays !== 1 ? 's' : ''}</strong>.
            </p>
            <p style="font-size: 15px; color: #374151;">Please check the ESAT system to clear the pending list.</p>
            <a href="https://esat.egypro.app"
              style="display: inline-block; background: #1D9E75; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">
              Open ESAT
            </a>
            <p style="font-size: 14px; color: #374151; margin-top: 24px;">Thanks,<br/>Maged Ezzat</p>
          </div>
        </div>
      `
    });
    res.json({ success: true, count, oldestDays });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/test-scm-digest', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows: pending } = await pool.query(`
      SELECT COUNT(*) as count, MAX(CURRENT_DATE - date_flagged::date) as oldest_days
      FROM ppe_requests WHERE status = 'ehs_purchase_requested'
    `);
    const count = parseInt(pending[0].count);
    const oldestDays = parseInt(pending[0].oldest_days) || 0;
    const { rows: ordered } = await pool.query(`
      SELECT COUNT(*) as count, MAX(CURRENT_DATE - date_ordered::date) as oldest_days
      FROM ppe_requests WHERE status = 'scm_ordered'
    `);
    const orderedCount = parseInt(ordered[0].count);
    const orderedOldestDays = parseInt(ordered[0].oldest_days) || 0;
    if (count === 0 && orderedCount === 0) return res.json({ success: true, count, orderedCount, message: 'No pending items, email not sent' });
    await resend.emails.send({
      from: 'ESAT <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `ESAT Daily SCM — ${count + orderedCount} Pending PPE/Tool Item${(count + orderedCount) > 1 ? 's' : ''} Awaiting Action`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-radius: 8px 8px 0 0; border-bottom: 2px solid #0f2a4a;"><tr><td bgcolor="#ffffff" align="center" style="padding: 16px 24px; background-color: #ffffff !important;">
            <img src="https://esat.egypro.app/esat-login-logo.png" alt="ESAT" width="110" height="50" style="height:50px; width:110px; display:block; margin:0 auto;" />
          </td></tr></table>
          <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="font-size: 15px; color: #374151;">Hello Supply Chain Team,</p>
            ${count > 0 ? `<p style="font-size: 15px; color: #374151;">
              We have <strong style="color: #0f2a4a;">${count} pending PPE/Tool item${count > 1 ? 's' : ''}</strong>
              to be ordered or to confirm availability. The oldest item has been waiting for
              <strong style="color: ${oldestDays > 0 ? '#e53e3e' : '#374151'};">${oldestDays} day${oldestDays !== 1 ? 's' : ''}</strong>.
            </p>` : ''}
            ${orderedCount > 0 ? `<p style="font-size: 15px; color: #374151;">
              And our Suppliers have <strong style="color: #0f2a4a;">${orderedCount} pending PPE/Tool item${orderedCount > 1 ? 's' : ''}</strong>
              to be delivered to our warehouse. The oldest item has been waiting for
              <strong style="color: ${orderedOldestDays > 0 ? '#e53e3e' : '#374151'};">${orderedOldestDays} day${orderedOldestDays !== 1 ? 's' : ''}</strong>.
            </p>` : ''}
            <p style="font-size: 15px; color: #374151;">Please check the ESAT system to clear the pending list.</p>
            <a href="https://esat.egypro.app" 
              style="display: inline-block; background: #1D9E75; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">
              Open ESAT
            </a>
            <p style="font-size: 14px; color: #374151; margin-top: 24px;">Thanks,<br/>Maged Ezzat</p>
          </div>
        </div>
      `
    });
    res.json({ success: true, count, oldestDays, orderedCount, orderedOldestDays });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

setupDB().then(() => {
  
// ── Cloudinary Setup ────────────────────────────────────────
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const ALLOWED_UPLOAD_MIMETYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_UPLOAD_MIMETYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF and image files (JPEG, PNG, HEIC) are allowed'));
  }
});
// Strips anything but alphanumerics/hyphen/underscore so user-controlled values
// can't inject extra path segments into the Cloudinary public_id/folder.
const sanitizeForPublicId = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '-');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ── Upload Audit Document ────────────────────────────────────
app.post('/api/audit-documents/upload', auth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload rejected' });
    try {
      const { audit_id, employee_id, field_name, national_id, employee_name, audit_date } = req.body;
      if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
      if (!audit_id || !employee_id || !field_name) {
        return res.status(400).json({ message: 'audit_id, employee_id and field_name are required' });
      }
      if (audit_date && isNaN(Date.parse(audit_date))) {
        return res.status(400).json({ message: 'Invalid audit_date' });
      }

      const safeName = sanitizeForPublicId(employee_name);
      const safeNationalId = sanitizeForPublicId(national_id);
      const safeDate = sanitizeForPublicId(audit_date);
      const safeField = sanitizeForPublicId(field_name);
      const folder = `esat/${safeNationalId}_${safeName}/${safeDate}`;
      const publicId = `${folder}/${safeDate}_${safeName}_${safeField}`;

      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { public_id: publicId, overwrite: true, resource_type: 'auto' },
          (error, result) => { if (error) reject(error); else resolve(result); }
        );
        stream.end(req.file.buffer);
      });

      await pool.query(
        `INSERT INTO audit_documents (audit_id, employee_id, field_name, cloudinary_url, cloudinary_public_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (audit_id, field_name) DO UPDATE SET cloudinary_url=EXCLUDED.cloudinary_url, cloudinary_public_id=EXCLUDED.cloudinary_public_id`,
        [audit_id, employee_id, field_name, result.secure_url, result.public_id]
      );

      res.json({ url: result.secure_url, public_id: result.public_id });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ message: 'Upload failed', error: err.message });
    }
  });
});


// ── Download Audit Document (proxy) ─────────────────────────
app.get('/api/audit-documents/:id/download', auth, async (req, res) => {
  try {
    const doc = await pool.query('SELECT * FROM audit_documents WHERE id = $1', [req.params.id]);
    if (!doc.rows.length) return res.status(404).json({ message: 'Not found' });
    const url = doc.rows[0].cloudinary_url;
    const rawFilename = url.split('/').pop().split('?')[0];
    const filename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const https = require('https');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    https.get(url, (stream) => stream.pipe(res));
  } catch (err) {
    res.status(500).json({ message: 'Download failed' });
  }
});

// ── Get Audit Documents ──────────────────────────────────────
app.get('/api/audit-documents/:audit_id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM audit_documents WHERE audit_id = $1 ORDER BY uploaded_at ASC`,
      [req.params.audit_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch documents' });
  }
});

// ── Delete Audit Document ────────────────────────────────────
app.delete('/api/audit-documents/:id', auth, async (req, res) => {
  try {
    const doc = await pool.query(`SELECT * FROM audit_documents WHERE id = $1`, [req.params.id]);
    if (!doc.rows.length) return res.status(404).json({ message: 'Not found' });
    await cloudinary.uploader.destroy(doc.rows[0].cloudinary_public_id);
    await pool.query(`DELETE FROM audit_documents WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Delete failed' });
  }
});

app.post('/api/admin/test-overdue-digest', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await sendDailyOverdueDigest();
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => { console.log(`ESAT running on port ${PORT}`); scheduleDailyDigest(); });
});

// ── User Management Routes ───────────────────────────────────

// GET all users (admin only)

app.get('/api/graphs', auth, async (req, res) => {
  try {
    const [ppeByEmployee, auditsByMonth, ncrByMonth] = await Promise.all([
      pool.query(`
        SELECT e.full_name as employee_name, COUNT(r.id) as ppe_count
        FROM employees e
        JOIN ppe_requests r ON r.employee_id = e.id
        WHERE r.status NOT IN ('distributed','resolved','canceled')
        AND e.employment_status = 'active'
        GROUP BY e.id, e.full_name
        ORDER BY ppe_count DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', audit_date), 'Mon YYYY') as month,
               DATE_TRUNC('month', audit_date) as month_date,
               COUNT(*) as count
        FROM audits
        WHERE audit_date >= NOW() - INTERVAL '6 months'
        GROUP BY month_date, month
        ORDER BY month_date ASC
      `),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') as month,
               DATE_TRUNC('month', created_at) as month_date,
               COUNT(*) as created,
               COUNT(*) FILTER (WHERE status IN ('resolved','distributed')) as resolved
        FROM ncr_items
        WHERE created_at >= NOW() - INTERVAL '6 months'
        GROUP BY month_date, month
        ORDER BY month_date ASC
      `)
    ]);

    const counts = ppeByEmployee.rows.map(r => parseInt(r.ppe_count));
    const avg = counts.length > 0 ? Math.round(counts.reduce((a,b) => a+b, 0) / counts.length) : 0;

    res.json({
      ppe_by_employee: ppeByEmployee.rows.map(r => ({ name: r.employee_name, count: parseInt(r.ppe_count) })),
      ppe_average: avg,
      audits_by_month: auditsByMonth.rows.map(r => ({ month: r.month, count: parseInt(r.count) })),
      ncr_by_month: ncrByMonth.rows.map(r => ({ month: r.month, created: parseInt(r.created), resolved: parseInt(r.resolved) }))
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/users', auth, async (req, res) => {
  if (!['admin','ehs_manager','ehs_officer','supervisor'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const { rows } = await pool.query('SELECT id, full_name, email, role, is_active, profile_picture, project_access, page_access, client_access, created_at FROM users ORDER BY created_at DESC');
  res.json(rows);
});

// POST create new user (admin only)
app.post('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { full_name, email, password, role, project_access, page_access } = req.body;
  if (!full_name || !email || !password || !role) return res.status(400).json({ error: 'All fields required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role, project_access, page_access, client_access) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, full_name, email, role, is_active, project_access, page_access, client_access',
      [full_name, email, hash, role, project_access || [], page_access || [], req.body.client_access || []]
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
  const { full_name, email, role, is_active, password, profile_picture, project_access, page_access } = req.body;
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password && password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (profile_picture && !isValidProfilePicture(profile_picture)) return res.status(400).json({ error: 'Invalid profile picture' });
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET full_name=$1, email=$2, role=$3, is_active=$4, password_hash=$5, profile_picture=$6, project_access=$7, page_access=$8, client_access=$9, updated_at=NOW() WHERE id=$10',
        [full_name, email, role, is_active, hash, profile_picture || null, project_access || [], page_access || [], req.body.client_access || [], req.params.id]);
    } else {
      await pool.query('UPDATE users SET full_name=$1, email=$2, role=$3, is_active=$4, profile_picture=$5, project_access=$6, page_access=$7, client_access=$8, updated_at=NOW() WHERE id=$9',
        [full_name, email, role, is_active, profile_picture || null, project_access || [], page_access || [], req.body.client_access || [], req.params.id]);
    }
    const { rows } = await pool.query('SELECT id, full_name, email, role, is_active, profile_picture, project_access, page_access, client_access FROM users WHERE id=$1', [req.params.id]);
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
