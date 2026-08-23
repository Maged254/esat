require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const compression = require('compression');

const app = express();
app.set('trust proxy', true); // so req.ip reflects the real client IP behind Render's proxy
app.use(compression());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: "10mb" }));
// Trim leading/trailing whitespace on every JSON string input (names, national
// IDs, project/client, organization/company names, training names, ...) so stray
// spaces from copy-paste can't create duplicates or lookup mismatches. Password
// fields are left untouched (a stored password could contain intentional spaces).
const SKIP_TRIM_KEYS = new Set(['password', 'currentPassword', 'newPassword', 'confirmPassword', 'current_password', 'new_password', 'confirm_password']);
const deepTrim = (val, key) => {
  if (typeof val === 'string') {
    if (SKIP_TRIM_KEYS.has(key)) return val;
    const t = val.trim();
    // National IDs are numeric — strip any stray non-digits (spaces, quotes,
    // Excel apostrophes) so "1231232'" and "1231232 " normalise to "1231232".
    return key === 'national_id' ? t.replace(/[^0-9]/g, '') : t;
  }
  if (Array.isArray(val)) return val.map(v => deepTrim(v));
  if (val && typeof val === 'object') { for (const k of Object.keys(val)) val[k] = deepTrim(val[k], k); return val; }
  return val;
};
app.use((req, _res, next) => { if (req.body && typeof req.body === 'object') deepTrim(req.body); next(); });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL.split('?')[0],
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false, checkServerIdentity: () => undefined } : false
});

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Refusing to start with a predictable secret.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
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
      
      CREATE TABLE IF NOT EXISTS ppe_assignment_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
        casual_id UUID REFERENCES casuals(id) ON DELETE SET NULL,
        person_name TEXT,
        national_id TEXT,
        organization TEXT,
        project TEXT,
        client TEXT,
        ppe_item_id UUID REFERENCES ppe_items(id) ON DELETE SET NULL,
        ppe_item_name TEXT,
        action VARCHAR(10) NOT NULL CHECK (action IN ('added','removed')),
        changed_by UUID REFERENCES users(id),
        changed_by_name TEXT,
        changed_at TIMESTAMPTZ DEFAULT NOW()
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

    // The Graphs page was split into separate Audits/Requests pages -- carry
    // forward access for anyone who had '/graphs' so they aren't locked out.
    await client.query("UPDATE users SET page_access = array_append(page_access, '/audits') WHERE '/graphs' = ANY(page_access) AND NOT ('/audits' = ANY(page_access))");
    await client.query("UPDATE users SET page_access = array_append(page_access, '/requests') WHERE '/graphs' = ANY(page_access) AND NOT ('/requests' = ANY(page_access))");
    await client.query("UPDATE users SET page_access = array_remove(page_access, '/graphs') WHERE '/graphs' = ANY(page_access)");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN DEFAULT FALSE");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ");

    // Request log (admin-only visibility)
    await client.query(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        endpoint VARCHAR(300),
        ip VARCHAR(64),
        status_code INTEGER,
        error_detail TEXT,
        duration_ms INTEGER
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ppe_assignment_log_at ON ppe_assignment_log(changed_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ppe_assignment_log_person ON ppe_assignment_log(employee_id, casual_id)');

    // Foreign-key / frequently-filtered columns had no indexes at all — every
    // join or WHERE on these was a full table scan.
    await client.query('CREATE INDEX IF NOT EXISTS idx_audits_employee_id ON audits(employee_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audits_casual_id ON audits(casual_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audits_audited_by ON audits(audited_by)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audits_location_id ON audits(location_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_items_audit_id ON audit_items(audit_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_items_ppe_item_id ON audit_items(ppe_item_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ncr_items_employee_id ON ncr_items(employee_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ncr_items_casual_id ON ncr_items(casual_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ncr_items_audit_item_id ON ncr_items(audit_item_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ncr_items_ppe_item_id ON ncr_items(ppe_item_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ppe_requests_employee_id ON ppe_requests(employee_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ppe_requests_casual_id ON ppe_requests(casual_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ppe_requests_ncr_item_id ON ppe_requests(ncr_item_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ppe_requests_ppe_item_id ON ppe_requests(ppe_item_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_employees_project ON employees(project)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_employees_client ON employees(client)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_employees_national_id ON employees(national_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_employees_status_san ON employees(employment_status, san)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_casuals_project ON casuals(project)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_casuals_client ON casuals(client)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_casuals_national_id ON casuals(national_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_casuals_employment_status ON casuals(employment_status)');
    // Uniqueness backstops (normalised): no two casuals may share a national ID
    // (digits only) or a full name (case/space-insensitive). Wrapped so a boot
    // never crashes if legacy duplicates still exist -- it self-heals on the next
    // boot once they are removed. New adds are already blocked at the app layer.
    try { await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_casuals_national_id ON casuals (regexp_replace(national_id, '[^0-9]', '', 'g'))`); }
    catch (e) { console.warn('casuals national_id unique index deferred (duplicates present?):', e.message); }
    try { await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_casuals_full_name ON casuals (LOWER(TRIM(full_name)))`); }
    catch (e) { console.warn('casuals full_name unique index deferred (duplicates present?):', e.message); }

    // Ensure distribution columns exist on ppe_requests
    await client.query('ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS distribution_method VARCHAR(50)');
    await client.query('ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS courier_tracking_number VARCHAR(200)');

    // Backfill: requests that were canceled by an exit before 'exit' existed
    // as its own status should read as Exit, not Canceled. Safe to re-run --
    // once relabeled they no longer match status='canceled'.
    await client.query(`
      UPDATE ppe_requests SET status='exit', updated_at=NOW()
      WHERE status='canceled' AND (
        employee_id IN (SELECT id FROM employees WHERE employment_status='exit')
        OR casual_id IN (SELECT id FROM casuals WHERE employment_status='exit')
      )
    `);

    // Same backfill for NCR items: those canceled by an exit should read as
    // Exit, matching the PPE tracker. Keys off the current exit population,
    // so it stays correct as more people exit. Safe to re-run.
    await client.query(`
      UPDATE ncr_items SET status='exit', updated_at=NOW()
      WHERE status='canceled' AND (
        employee_id IN (SELECT id FROM employees WHERE employment_status='exit')
        OR casual_id IN (SELECT id FROM casuals WHERE employment_status='exit')
      )
    `);

    // A rejection (Safety or PM) closes the NCR out: stored as status='canceled'
    // (already excluded from every open/count query) but distinguished — and labelled
    // "Rejected" — by having a reject_reason.
    await client.query('ALTER TABLE ncr_items ADD COLUMN IF NOT EXISTS reject_reason TEXT');
    await client.query('ALTER TABLE ncr_items ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id)');
    await client.query('ALTER TABLE ncr_items ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ');
    // Which gate the item was turned back at. Not derivable from the stored
    // status -- both stages end as 'canceled' -- and the rejector's role is a
    // poor proxy, since roles change and an admin can reject at either gate.
    await client.query('ALTER TABLE ncr_items ADD COLUMN IF NOT EXISTS rejected_stage VARCHAR(10)');
    // Deleting an audit closes every NCR it raised. That was recorded on the
    // audit but never on the items, so they showed as cancelled by nobody for no
    // reason -- the audit itself always knew.
    await client.query('ALTER TABLE ncr_items ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id)');
    await client.query('ALTER TABLE ncr_items ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ');
    await client.query('ALTER TABLE ncr_items ADD COLUMN IF NOT EXISTS cancel_reason TEXT');
    await client.query(`
      UPDATE ncr_items n
         SET cancelled_by = a.deleted_by,
             cancelled_at = a.deleted_at,
             cancel_reason = 'Audit deleted' || COALESCE(' — ' || NULLIF(TRIM(a.delete_reason),''), '')
        FROM audit_items ai
        JOIN audits a ON a.id = ai.audit_id
       WHERE ai.id = n.audit_item_id
         AND a.is_deleted IS TRUE
         AND n.status = 'canceled'
         AND n.reject_reason IS NULL
         AND n.cancelled_at IS NULL
    `);
    // Backfill the rejections made before the column existed. Safety approval
    // stamps date_purchase_requested on the linked PPE request and a later
    // rejection never clears it, so its presence means the item had already
    // passed Safety and was therefore turned back at PM.
    await client.query(`
      UPDATE ncr_items n SET rejected_stage = CASE
          WHEN EXISTS (SELECT 1 FROM ppe_requests pr
                        WHERE pr.ncr_item_id = n.id AND pr.date_purchase_requested IS NOT NULL) THEN 'pm'
          ELSE 'safety' END
       WHERE n.status = 'canceled' AND n.reject_reason IS NOT NULL AND n.rejected_stage IS NULL
    `);

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
    // HR/admin edits to an employee's core details are tracked (who/when + a reason),
    // surfaced as the "Last Update (HR)" column on the Employees page. Kept separate
    // from ppe_last_edited_* (PPE assignment) and from updated_at (touched by san/status).
    await client.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_edited_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ");
    await client.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_edit_reason TEXT");
    await client.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id)");
    await client.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS national_id_doc_key TEXT");
    // ETMS-synced employees have no ESAT user behind their creation/exit, so the
    // status tooltip showed "By: —". These text columns hold the ETMS names (from
    // the SharePoint export) as a fallback for the created_by/change-log user joins,
    // and added_on holds the true ETMS "Created" date (the sync-insert created_at is
    // not the real add date). Backfilled once from MasterList.xlsx; blanks-only.
    await client.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS created_by_name_text TEXT");
    await client.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS exited_by_name_text TEXT");
    await client.query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS added_on DATE");
    // Employment ID (employee_number) is only for in-house employees; interns and
    // outsource have none. Relax NOT NULL — the UNIQUE constraint still enforces
    // uniqueness among the ones that have a value (Postgres allows multiple NULLs).
    await client.query("ALTER TABLE employees ALTER COLUMN employee_number DROP NOT NULL");
    // Immutable, append-only history of employee-detail changes (edits + exits).
    // Snapshots employee + editor identity so a row stays readable even if the
    // employee is later renamed or the user removed. `changes` is a JSON array of
    // { field, before, after }. Feeds the Change History page + the daily digest.
    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_change_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
        employee_name VARCHAR(150),
        national_id VARCHAR(30),
        employee_number VARCHAR(20),
        action VARCHAR(20) NOT NULL DEFAULT 'update',
        reason TEXT,
        changes JSONB NOT NULL DEFAULT '[]'::jsonb,
        changed_by UUID REFERENCES users(id),
        changed_by_name VARCHAR(150),
        changed_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_employee_change_log_changed_at ON employee_change_log(changed_at)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_employee_change_log_employee ON employee_change_log(employee_id)");
    // Append-only log of casual add/reactivate events; feeds the hourly Casual Resources Updates digest.
    await client.query(`
      CREATE TABLE IF NOT EXISTS casual_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        casual_id UUID REFERENCES casuals(id) ON DELETE SET NULL,
        action VARCHAR(20) NOT NULL,
        project VARCHAR(150),
        client VARCHAR(150),
        actor_id UUID REFERENCES users(id),
        actor_name VARCHAR(150),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_casual_events_created_at ON casual_events(created_at)");
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

    // Warehouse pre-check flag: settable at EHS Purchase Requested / Approved
    // (PM) stage without moving the request's actual status, so the tracker's
    // Warehouse column can show "unavailable" ahead of SCM ordering it.
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS warehouse_unavailable_flagged_at TIMESTAMPTZ");
    await client.query("ALTER TABLE ppe_requests ADD COLUMN IF NOT EXISTS warehouse_unavailable_flagged_by UUID REFERENCES users(id)");

    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ");
    // Existing rows default to how they were actually uploaded: public 'upload'
    // delivery, resource_type 'image'. New uploads override both explicitly.
    await client.query("ALTER TABLE audit_documents ADD COLUMN IF NOT EXISTS resource_type VARCHAR(20) DEFAULT 'image'");
    await client.query("ALTER TABLE audit_documents ADD COLUMN IF NOT EXISTS delivery_type VARCHAR(20) DEFAULT 'upload'");
    await client.query("ALTER TABLE audits ADD COLUMN IF NOT EXISTS delete_reason TEXT");

    // ── Training module (ETMS migration, Phase 1) ──────────────
    // Schema only -- historical ETMS data is NOT imported until the Phase 0
    // certificate reconciliation passes. See the ETMS→ESAT migration report.
    await client.query(`
      CREATE TABLE IF NOT EXISTS training_courses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(150) NOT NULL UNIQUE,
        validity_months INTEGER,
        is_credential BOOLEAN DEFAULT FALSE,
        needs_certificate BOOLEAN DEFAULT TRUE,
        is_sensitive BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS training_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
        casual_id UUID REFERENCES casuals(id) ON DELETE CASCADE,
        course_id UUID NOT NULL REFERENCES training_courses(id),
        status VARCHAR(30) NOT NULL DEFAULT 'requested',
        requested_by UUID REFERENCES users(id),
        requested_at TIMESTAMPTZ DEFAULT NOW(),
        scheduled_date DATE,
        pending_reason TEXT,
        not_eligible_reason TEXT,
        cancelled_by UUID REFERENCES users(id),
        cancelled_at TIMESTAMPTZ,
        cancel_reason TEXT,
        completed_at DATE,
        recorded_by UUID REFERENCES users(id),
        recorded_at TIMESTAMPTZ,
        expiry_date DATE,
        validity_months_applied INTEGER,
        training_cost NUMERIC(12,2),
        partnership VARCHAR(150),
        project_at_completion VARCHAR(100),
        client_at_completion VARCHAR(100),
        organization_at_completion VARCHAR(100),
        certificate_url TEXT,
        cloudinary_public_id TEXT,
        resource_type VARCHAR(20),
        delivery_type VARCHAR(20),
        original_filename TEXT,
        source_sharepoint_url TEXT,
        migrated_at TIMESTAMPTZ,
        is_deleted BOOLEAN DEFAULT FALSE,
        delete_reason TEXT,
        deleted_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS training_course_access UUID[] DEFAULT '{}'");
    // Per-HR-user access to named HR tasks (e.g. 'add_employee', 'edit_employee'),
    // managed in Admin → HR Tasks Managers. Admins always have every task.
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS hr_task_access TEXT[] DEFAULT '{}'");
    // Per-user access to manage outsource resources by subtype ('services' and/or
    // 'vehicle_supplier'), managed in Admin → Outsource Managers. Each grant covers
    // add + edit + exit for that subtype. Admins always have both.
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS outsource_access TEXT[] DEFAULT '{}'");
    // When a certificate expires we auto-open a renewal request; this stamps that
    // request with the date the previous certificate expired (shown as a note).
    await client.query('ALTER TABLE training_records ADD COLUMN IF NOT EXISTS prior_expiry_date DATE');
    // A course can be marked "no expiry": its certificate never expires, so
    // completion needs no validity period and no expiry date is computed.
    await client.query('ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS no_expiry BOOLEAN DEFAULT FALSE');
    // Simple key/value app settings (admin-toggleable). Starts with the cert
    // requirement OFF so the migration can complete records without certs.
    await client.query(`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`INSERT INTO app_settings (key, value) VALUES ('require_training_certificate','false') ON CONFLICT (key) DO NOTHING`);

    // One-time: Employment ID is in-house only now, so clear it for existing
    // interns and outsource. Word-boundary '\yintern\y' avoids matching e.g.
    // "International". Guarded by a marker so it runs exactly once.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key='intern_outsource_empid_cleared') THEN
          UPDATE employees SET employee_number=NULL
            WHERE employee_number IS NOT NULL
              AND (resource_type IN ('outsource','intern') OR job_title ~* '\\yintern\\y');
          INSERT INTO app_settings (key, value) VALUES ('intern_outsource_empid_cleared','done') ON CONFLICT (key) DO NOTHING;
        END IF;
      END $$;
    `);

    // Targeted constraints: ESAT has none elsewhere, but each of these prevents
    // a specific corruption that would be expensive to unpick after migration.
    // 1. A record belongs to exactly one person.
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE training_records ADD CONSTRAINT training_records_one_person
          CHECK ((employee_id IS NULL) <> (casual_id IS NULL));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    // 2. A completed record must carry its completion date. Expiry may be NULL for
    //    "no expiry" courses, so it is not required here (replaces the older rule
    //    that also demanded expiry_date).
    await client.query('ALTER TABLE training_records DROP CONSTRAINT IF EXISTS training_records_completed_has_dates');
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE training_records ADD CONSTRAINT training_records_completed_has_dates
          CHECK (status <> 'completed' OR completed_at IS NOT NULL);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    // 3. At most one OPEN request per person+course -- encodes the ETMS rule that
    //    the update screen only lists people with an outstanding request, without
    //    blocking renewals (a plain UNIQUE(employee,course) would break them).
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_training_request_employee
        ON training_records (employee_id, course_id)
        WHERE status IN ('requested','scheduled','pending') AND is_deleted IS NOT TRUE AND employee_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_training_request_casual
        ON training_records (casual_id, course_id)
        WHERE status IN ('requested','scheduled','pending') AND is_deleted IS NOT TRUE AND casual_id IS NOT NULL
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_training_records_employee ON training_records(employee_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_training_records_status ON training_records(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_training_records_expiry ON training_records(expiry_date)');
    // Support the correlated "superseded certificate" subquery (SUPERSEDED_SQL),
    // which the /tracker and /stats aggregates evaluate per row. Without these the
    // stats query is O(n^2) and times out once real training data exists
    // (measured 61s @ 1,551 rows -> 0.4s with the indexes).
    await client.query("CREATE INDEX IF NOT EXISTS idx_tr_supersede ON training_records (course_id, employee_id, completed_at) WHERE status='completed' AND is_deleted IS NOT TRUE");
    await client.query("CREATE INDEX IF NOT EXISTS idx_tr_supersede_casual ON training_records (course_id, casual_id, completed_at) WHERE status='completed' AND is_deleted IS NOT TRUE");

    // Append-only history of everything that happens to a training record. The
    // record itself only ever holds its LATEST state -- recording an outcome or
    // restoring a removed request overwrites what was there, so without this
    // there is no way to tell who did what, or that it happened at all. Nothing
    // updates or deletes rows here; the actor's name is copied in so the history
    // survives the user being removed, and a NULL actor means the system did it
    // (the expiry sweep).
    await client.query(`
      CREATE TABLE IF NOT EXISTS training_record_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        training_record_id UUID NOT NULL REFERENCES training_records(id) ON DELETE CASCADE,
        action VARCHAR(30) NOT NULL,
        from_status VARCHAR(30),
        to_status VARCHAR(30),
        detail TEXT,
        changed_by UUID REFERENCES users(id),
        changed_by_name TEXT,
        changed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_tre_record ON training_record_events (training_record_id, changed_at)');

    // Seed the initial course types carried over from ETMS -- but ONLY on a
    // brand-new (empty) table. Re-seeding on every boot would resurrect courses
    // the admin has since deleted/renamed, so it must not run once the table
    // has any rows. validity_months is left NULL except Defensive Driving.
    const { rows: [{ count: existingCourses }] } = await client.query('SELECT COUNT(*)::int AS count FROM training_courses');
    if (existingCourses === 0) {
      await client.query(`
        INSERT INTO training_courses (name, validity_months, is_credential, is_sensitive, sort_order) VALUES
          ('Defensive Driving', 24, FALSE, FALSE, 1),
          ('Fall Arrest & Basic Rescue Technician', NULL, FALSE, FALSE, 2),
          ('Rope Rigging Technician', NULL, FALSE, FALSE, 3),
          ('General Safety and Pole Climbing', NULL, FALSE, FALSE, 4),
          ('Basic Competency and Safety in Power Systems', NULL, FALSE, FALSE, 5),
          ('Fire Fighting', NULL, FALSE, FALSE, 6),
          ('First Aid', NULL, FALSE, FALSE, 7),
          ('Hazard Identification & Risk Assessment', NULL, FALSE, FALSE, 8)
        ON CONFLICT (name) DO NOTHING
      `);
    }

    // Icon is stored per course (a stable slug, not the editable name) so
    // renaming a training keeps its icon. Backfill known courses once; admins
    // pick the icon for anything else via the Admin panel.
    await client.query("ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS icon VARCHAR(50)");
    await client.query(`
      UPDATE training_courses SET icon = CASE name
        WHEN 'Defensive Driving' THEN 'defensive_driving'
        WHEN 'Fall Arrest & Basic Rescue Technician' THEN 'fall_arrest'
        WHEN 'Rope Rigging Technician' THEN 'rope_rigging'
        WHEN 'General Safety and Pole Climbing' THEN 'pole_climbing'
        WHEN 'Basic Competency and Safety in Power Systems' THEN 'power_systems'
        WHEN 'Fire Fighting' THEN 'fire_fighting'
        WHEN 'First Aid' THEN 'first_aid'
        WHEN 'Hazard Identification & Risk Assessment' THEN 'hira'
        WHEN 'Driving License' THEN 'driving_license'
        WHEN 'Medical Certificate' THEN 'medical'
        WHEN 'EHS Induction' THEN 'ehs_induction'
        ELSE icon END
      WHERE icon IS NULL
    `);

    // Admin-managed list of Pending reasons, shown as a dropdown when HR marks a
    // training request Pending on the Update Training Records screen.
    await client.query(`
      CREATE TABLE IF NOT EXISTS training_pending_reasons (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        label VARCHAR(150) NOT NULL UNIQUE,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // These three are written automatically by the expiry->renewal sweep
    // (ensureRenewalRequests), so they must always be selectable in the Pending
    // Reason filters -- seeded on every boot, unlike the admin's own reasons.
    // They keep the wording ETMS used, so the automation and the history that
    // came over from it read as one set rather than near-duplicate pairs.
    await client.query(`
      INSERT INTO training_pending_reasons (label)
      VALUES ('Pending HR Dept.'), ('Pending Fleet Training Approval'), ('Pending Operation Dept.')
      ON CONFLICT (label) DO NOTHING
    `);
    // The automation first shipped with short labels ('Pending HR' etc), which
    // duplicated the ETMS wording above. Fold them back in: re-label the records
    // that carry one, then drop the short options from the dropdown.
    await client.query(`
      UPDATE training_records SET pending_reason = CASE pending_reason
               WHEN 'Pending HR' THEN 'Pending HR Dept.'
               WHEN 'Pending Fleet' THEN 'Pending Fleet Training Approval'
               ELSE 'Pending Operation Dept.' END,
             updated_at = NOW()
       WHERE pending_reason IN ('Pending HR','Pending Fleet','Pending Operation')
    `);
    await client.query(`
      DELETE FROM training_pending_reasons WHERE label IN ('Pending HR','Pending Fleet','Pending Operation')
    `);

    // Admin-managed option lists for the employee Add/Edit dropdowns
    // (Department / Project / Client). As ESAT goes independent of ETMS these
    // become the source of truth instead of DISTINCT values scraped from rows.
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_lists (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        list_type VARCHAR(20) NOT NULL,
        name VARCHAR(120) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (list_type, name)
      )
    `);
    // Seed ONCE (only while the table is empty) from the existing employee data
    // so the lists start populated with every department/project/client in use.
    // Guarded by NOT EXISTS so an admin deleting a value doesn't get it re-added
    // on the next boot just because employee rows still reference it.
    await client.query(`
      INSERT INTO org_lists (list_type, name)
      SELECT t.list_type, t.name FROM (
        SELECT 'department' AS list_type, department AS name FROM employees WHERE department IS NOT NULL AND department <> ''
        UNION SELECT 'project', project FROM employees WHERE project IS NOT NULL AND project <> ''
        UNION SELECT 'client', client FROM employees WHERE client IS NOT NULL AND client <> ''
      ) t
      WHERE NOT EXISTS (SELECT 1 FROM org_lists)
      ON CONFLICT (list_type, name) DO NOTHING
    `);

    // Outsource entities (contractors / vehicle suppliers). An outsource employee's
    // classification is derived from their organization via this table; Egypro folks
    // are Inhouse/Intern (from job title), so only NON-Egypro orgs live here. Seeded
    // ONCE from existing employee organizations as 'vehicle_supplier' — the ETMS export
    // shows every current outsource org is a vehicle provider (DAMCHOTEL, the lone
    // contractor, has no ESAT employees). Admins add/flip contractors in the panel.
    await client.query(`
      CREATE TABLE IF NOT EXISTS outsource_entities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(160) UNIQUE NOT NULL,
        type VARCHAR(20) NOT NULL DEFAULT 'vehicle_supplier' CHECK (type IN ('services','vehicle_supplier')),
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // The 'contractor' type was renamed to 'services'. Drop the old CHECK (whatever
    // Postgres auto-named it), migrate any rows, then add the new CHECK. Idempotent.
    await client.query(`DO $$
      DECLARE cname text;
      BEGIN
        SELECT conname INTO cname FROM pg_constraint WHERE conrelid='outsource_entities'::regclass AND contype='c' LIMIT 1;
        IF cname IS NOT NULL THEN EXECUTE 'ALTER TABLE outsource_entities DROP CONSTRAINT '||quote_ident(cname); END IF;
        UPDATE outsource_entities SET type='services' WHERE type='contractor';
        ALTER TABLE outsource_entities ADD CONSTRAINT outsource_entities_type_check CHECK (type IN ('services','vehicle_supplier'));
      END $$;`);
    // Guarded by NOT EXISTS so an admin deleting an entity doesn't get it re-added on
    // the next boot just because employee rows still reference that organization.
    await client.query(`
      INSERT INTO outsource_entities (name, type)
      SELECT DISTINCT TRIM(organization), 'vehicle_supplier' FROM employees
      WHERE organization IS NOT NULL AND TRIM(organization) <> '' AND LOWER(TRIM(organization)) <> 'egypro'
        AND NOT EXISTS (SELECT 1 FROM outsource_entities)
      ON CONFLICT (name) DO NOTHING
    `);
    // Open training records used to land as 'requested' with no reason -- both the
    // expiry-opened renewals and the manually raised requests. Nothing creates that
    // state any more (both now open as Pending against the owning team), so bring
    // the leftovers onto the same footing. A no-op once done.
    await client.query(`
      UPDATE training_records t
         SET status = 'pending',
             pending_reason = ${PENDING_TEAM_REASON_SQL},
             updated_at = NOW()
        FROM employees e
        LEFT JOIN outsource_entities oe ON LOWER(TRIM(oe.name)) = LOWER(TRIM(e.organization))
       WHERE e.id = t.employee_id
         AND t.status = 'requested'
         AND t.is_deleted IS NOT TRUE
    `);

    // Per-project PDA (Project Director Approval) requirement for a PPE/Tool item.
    // A row with project '*' means "all projects". An item with no rows never needs PDA.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ppe_item_pda_projects (
        ppe_item_id UUID NOT NULL REFERENCES ppe_items(id) ON DELETE CASCADE,
        project VARCHAR(100) NOT NULL,
        PRIMARY KEY (ppe_item_id, project)
      )`);
    // Whether a request for `p_item` by someone on `p_project` needs PDA: the item lists
    // that project explicitly, or lists '*' (all projects).
    await client.query(`
      CREATE OR REPLACE FUNCTION ppe_needs_pda(p_item UUID, p_project TEXT) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM ppe_item_pda_projects ipp
          WHERE ipp.ppe_item_id = p_item
            AND (ipp.project = '*' OR ipp.project = p_project)
        );
      $$ LANGUAGE sql STABLE`);
    // One-time seed: existing "Needs PDA" items required PDA for everyone, so map them to
    // '*'. Guarded by NOT EXISTS so admin edits aren't undone on the next boot.
    await client.query(`
      INSERT INTO ppe_item_pda_projects (ppe_item_id, project)
      SELECT id, '*' FROM ppe_items
      WHERE needs_pda = true AND NOT EXISTS (SELECT 1 FROM ppe_item_pda_projects)
      ON CONFLICT DO NOTHING
    `);

    // Mobile Lines owns its own schema (see modules/mobile-lines.js) but migrates
    // inside this same boot pass, so a deploy is still one migration step.
    await mobileLines.setup(client);

    console.log("Database setup complete");
  } catch(e) {
    console.error('DB setup error:', e.message);
  } finally {
    client.release();
  }
}

// Always logs the full error server-side. Only echoes err.message to the
// client when it's a deliberately-thrown application error (no Postgres/
// system error code attached) — raw DB/system exceptions never reach the
// client, just a generic message.
const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please contact support.';
const sendError = (res, err, status = 500) => {
  console.error(err);
  // Stashed for the request-logging middleware below — full detail, admin-only,
  // never sent in the client-facing response.
  res.locals.errorDetail = (err && (err.stack || err.message)) || String(err);
  const safeMessage = err.code ? GENERIC_ERROR_MESSAGE : (err.message || GENERIC_ERROR_MESSAGE);
  res.status(status).json({ error: safeMessage });
};

// ── Request logging (admin-only visibility via GET /api/admin/logs) ──
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    pool.query(
      `INSERT INTO request_logs (user_id, endpoint, ip, status_code, error_detail, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user?.id || null, `${req.method} ${req.path}`, req.ip, res.statusCode, res.locals.errorDetail || null, Date.now() - start]
    ).catch(e => console.error('Request log insert failed:', e.message));
  });
  next();
});

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

// ── Live updates (SSE) ────────────────────────────────────────
// Replaces frontend polling: connected clients are pushed a message whenever
// an employee record changes (Power Automate sync, or a manual edit), instead
// of every open tab re-fetching the full employee list on a timer.
const sseClients = new Set();
const broadcastEmployeesChanged = () => {
  for (const client of sseClients) client.write('data: employees-changed\n\n');
};

// EventSource can't send custom headers, so the token travels as a query param here.
app.get('/api/events', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).end();
  try {
    const user = jwt.verify(token, JWT_SECRET);
    if (!user.sync && user.iat < SERVER_BOOT_TIME) return res.status(401).end();
  } catch {
    return res.status(401).end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ── Project / client access helpers ──────────────────────────
// Escapes free-text values before they're interpolated into HTML email templates.
const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ['admin', 'ehs_manager', 'ehs_officer', 'supervisor', 'scm_officer', 'project_director', 'hr', 'fleet'];
// Data-URL profile pictures only, capped just under the 10mb JSON body limit
// (no client-side resize happens before upload, so this must stay generous).
const isValidProfilePicture = (s) => typeof s === 'string' && s.startsWith('data:image/') && s.length <= 9 * 1024 * 1024;

// Returns an error message if the password fails policy, or null if it passes.
const PASSWORD_MIN_LENGTH = 12;
const validatePassword = (pw) => {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter';
  if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must include a special character';
  return null;
};

const VALID_CONDITIONS = ['good', 'not_good', 'not_present'];
const FIRE_EXTINGUISHER_ITEM = 'Fire Extinguisher - 6KG - Dry Powder With Inspection Sticker';
const FIRE_EXTINGUISHER_COMMENT_OPTIONS = ['New Issuance', 'Replacement'];
// Returns a whole number 1-9999, or null if the input isn't a valid quantity.
const sanitizeQuantity = (q) => {
  if (q === undefined || q === null) return null;
  const n = Number(q);
  if (!Number.isInteger(n) || n < 1 || n > 9999) return null;
  return n;
};

const validateRequiredPpeComments = async (items) => {
  const itemIds = items.map(item => item.ppe_item_id).filter(Boolean);
  if (itemIds.length === 0) return null;
  const { rows } = await pool.query(
    'SELECT id FROM ppe_items WHERE name=$1 AND id=ANY($2::uuid[])',
    [FIRE_EXTINGUISHER_ITEM, itemIds]
  );
  if (rows.length === 0) return null;
  const fireExtinguisherIds = new Set(rows.map(row => row.id));
  const invalidItem = items.find(item =>
    fireExtinguisherIds.has(item.ppe_item_id)
    && item.condition === 'not_good'
    && !FIRE_EXTINGUISHER_COMMENT_OPTIONS.includes(String(item.comment || '').trim())
  );
  return invalidItem
    ? `Select New Issuance or Replacement for ${FIRE_EXTINGUISHER_ITEM}`
    : null;
};

const RESTRICTED_ROLES = ['ehs_officer', 'supervisor', 'scm_officer', 'project_director', 'ehs_manager'];

// getProjectFilter/getClientFilter run on nearly every authenticated request
// (list endpoints + all the by-id scope checks). The "does this user's access
// list cover everything" check only needs the set of distinct projects/clients,
// which changes rarely — cache it for a short TTL instead of re-scanning
// employees+casuals on every single call.
const DISTINCT_VALUES_CACHE_TTL_MS = 60 * 1000;
let _allProjectsCache = { data: null, expiresAt: 0 };
let _allClientsCache = { data: null, expiresAt: 0 };

const getAllProjects = async () => {
  if (_allProjectsCache.data && Date.now() < _allProjectsCache.expiresAt) return _allProjectsCache.data;
  const { rows } = await pool.query(`
    SELECT ARRAY_AGG(DISTINCT project) as all_projects FROM (
      SELECT project FROM employees WHERE project IS NOT NULL
      UNION
      SELECT project FROM casuals WHERE project IS NOT NULL
    ) combined
  `);
  const data = rows[0].all_projects || [];
  _allProjectsCache = { data, expiresAt: Date.now() + DISTINCT_VALUES_CACHE_TTL_MS };
  return data;
};

const getAllClients = async () => {
  if (_allClientsCache.data && Date.now() < _allClientsCache.expiresAt) return _allClientsCache.data;
  const { rows } = await pool.query(`
    SELECT ARRAY_AGG(DISTINCT client) as all_clients FROM (
      SELECT client FROM employees WHERE client IS NOT NULL
      UNION
      SELECT client FROM casuals WHERE client IS NOT NULL
    ) combined
  `);
  const data = rows[0].all_clients || [];
  _allClientsCache = { data, expiresAt: Date.now() + DISTINCT_VALUES_CACHE_TTL_MS };
  return data;
};

const getProjectFilter = async (user) => {
  if (!RESTRICTED_ROLES.includes(user.role)) return null; // unrestricted
  const projects = user.project_access || [];
  if (projects.length === 0) return []; // no access
  const allProjects = await getAllProjects();
  if (allProjects.every(p => projects.includes(p))) return null; // has all projects = unrestricted
  return projects;
};
const getClientFilter = async (user) => {
  if (!RESTRICTED_ROLES.includes(user.role)) return null; // unrestricted
  const clients = user.client_access || [];
  if (clients.length === 0) return []; // no access
  const allClients = await getAllClients();
  if (allClients.every(c => clients.includes(c))) return null; // has all clients = unrestricted
  return clients;
};

// True if a resource with this project/client is within the user's access.
const inScope = async (user, project, client) => {
  const projectFilter = await getProjectFilter(user);
  if (projectFilter !== null && !projectFilter.includes(project)) return false;
  const clientFilter = await getClientFilter(user);
  if (clientFilter !== null && !clientFilter.includes(client)) return false;
  return true;
};
// ── Mobile Lines module ────────────────────────────────────
// The first domain split out of this file. It takes what it needs by injection
// rather than importing, so this stays the only place that builds the pool, the
// auth middleware and the scope helpers. Mounted here, below those definitions;
// its schema migrates from setupDB above.
// The mail helpers are defined much further down, so they go in as thunks --
// evaluated when a mail is actually sent, not when the module is constructed.
const mobileLines = require('./modules/mobile-lines')({
  express, pool, auth, inScope, getProjectFilter, getClientFilter, sendError,
  sendMail: (opts) => resend.emails.send({ from: 'OneHub <esat@egypro.app>', to: 'e.maged@outlook.com', ...opts }),
  mailWrap: (html) => mailWrap(html),
});
app.use('/api/mobile-lines', mobileLines.router);
app.use('/api/mobile-line-requests', mobileLines.lineRequests);
// The product-change workflow (change requests, operator email batches,
// implementation confirmation) is retired: product changes are now made
// directly on the line by an admin, which is audited as a correction. The
// routers are left unmounted rather than deleted so the code is there if the
// approval chain is ever wanted back.
// app.use('/api/mobile-line-change-requests', mobileLines.requests);
// app.use('/api/mobile-line-email-batches', mobileLines.batches);

// Looks up the project/client of the employee or casual behind an id.
const getPersonScope = async (id) => {
  const { rows } = await pool.query(
    `SELECT project, client FROM employees WHERE id=$1
     UNION ALL
     SELECT project, client FROM casuals WHERE id=$1`,
    [id]
  );
  return rows[0] || null;
};
// Looks up the project/client of the employee or casual behind an audit.
const getAuditScope = async (auditId) => {
  const { rows: [audit] } = await pool.query('SELECT employee_id, casual_id FROM audits WHERE id=$1', [auditId]);
  if (!audit) return null;
  return getPersonScope(audit.employee_id || audit.casual_id);
};

// ── Routes ───────────────────────────────────────────────────

// Health
app.get('/health', (_, res) => res.json({ status: 'ok', app: 'ESAT', version: '1.0.0' }));

// Login
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1 AND is_active=true', [email]);
    const user = rows[0];

    if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `Account locked due to failed login attempts. Try again in ${minutesLeft} minute(s).` });
    }

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      if (user) {
        const attempts = (user.failed_login_attempts || 0) + 1;
        if (attempts >= LOCKOUT_THRESHOLD) {
          await pool.query(
            `UPDATE users SET failed_login_attempts=$1, locked_until=NOW() + INTERVAL '${LOCKOUT_MINUTES} minutes' WHERE id=$2`,
            [attempts, user.id]
          );
        } else {
          await pool.query('UPDATE users SET failed_login_attempts=$1 WHERE id=$2', [attempts, user.id]);
        }
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.failed_login_attempts || user.locked_until) {
      await pool.query('UPDATE users SET failed_login_attempts=0, locked_until=NULL WHERE id=$1', [user.id]);
    }
    await pool.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
    const isSync = user.email === 'sync@egypro.com';
    const tokenOptions = isSync ? {} : { expiresIn: '8h' };
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.full_name, project_access: user.project_access || [], client_access: user.client_access || [], page_access: user.page_access || [], hr_task_access: user.hr_task_access || [], outsource_access: user.outsource_access || [], sync: isSync }, JWT_SECRET, tokenOptions);
    res.json({ token, user: { id: user.id, name: user.full_name, email: user.email, role: user.role, project_access: user.project_access || [], client_access: user.client_access || [], page_access: user.page_access || [], hr_task_access: user.hr_task_access || [], outsource_access: user.outsource_access || [], must_reset_password: user.must_reset_password || false } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Me
app.get('/api/auth/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT id,full_name,email,role,profile_picture,project_access,page_access,client_access,hr_task_access,outsource_access,must_reset_password FROM users WHERE id=$1', [req.user.id]);
  const u = rows[0];
  if (!u) return res.status(401).json({ error: 'Session no longer valid, please sign in again' });
  // A token carries the role and access rights it was issued with, but this
  // endpoint answers from the database -- so after an admin changes someone's
  // role, the app renders what they NOW are while every write is still judged
  // against what they WERE. The result is buttons that silently do nothing
  // (a promoted EHS manager could see Approve and get 403 from it).
  //
  // Rather than let the two drift, treat a mismatch as an expired session: the
  // client logs out on a 401 here, and the next login mints a correct token.
  // The sync account is exempt -- its long-lived token is pasted into a Power
  // Automate flow and must not be invalidated from here.
  const sameList = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
  const stale = u.role !== req.user.role
    || !sameList(u.project_access, req.user.project_access)
    || !sameList(u.client_access, req.user.client_access)
    || !sameList(u.hr_task_access, req.user.hr_task_access)
    || !sameList(u.outsource_access, req.user.outsource_access);
  if (stale && !req.user.sync) {
    return res.status(401).json({ error: 'Your role or access has changed — please sign in again' });
  }
  res.json(u);
});

// Cheap session-validity check (no DB hit) — polled periodically so a backend
// redeploy logs out idle-but-open tabs promptly instead of waiting for the
// user's next real API call.
app.get('/api/auth/ping', auth, (req, res) => res.sendStatus(204));

// Dashboard
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const [emp, overdue, ncr, ncrCat, comp, delays, recent] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE employment_status='active') as active, COUNT(*) FILTER (WHERE employment_status='exit' AND exit_date >= date_trunc('year',NOW())) as exits_this_year FROM employees`),
      pool.query(`SELECT COUNT(*) as overdue FROM employees e LEFT JOIN (SELECT employee_id, MAX(audit_date) as last_audit FROM audits WHERE employee_present = TRUE AND is_deleted IS NOT TRUE GROUP BY employee_id) a ON e.id=a.employee_id WHERE e.employment_status='active' AND e.san=TRUE AND (a.last_audit IS NULL OR CURRENT_DATE - a.last_audit > 30)`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('resolved','distributed','canceled','exit')) as open, COUNT(*) FILTER (WHERE status='pending') as pending FROM ncr_items`),
      // Item x month matrix for the NCR heat map -- top 20 items by total NCRs
      // raised in the last 6 months (not just currently-open ones, so the
      // heat map reflects real occurrence history rather than a snapshot).
      // The dashboard card is full-width now, so it can afford more columns
      // than the old 8-item cap.
      pool.query(`
        WITH item_totals AS (
          SELECT p.id, p.name, COUNT(*) as total
          FROM ncr_items n JOIN ppe_items p ON p.id = n.ppe_item_id
          WHERE n.status != 'canceled' AND n.created_at >= NOW() - INTERVAL '6 months'
          GROUP BY p.id, p.name
          ORDER BY total DESC
          LIMIT 20
        )
        SELECT it.name as ppe_name, it.total,
               TO_CHAR(DATE_TRUNC('month', n.created_at), 'Mon YYYY') as month,
               DATE_TRUNC('month', n.created_at) as month_date,
               COUNT(*) as count
        FROM ncr_items n
        JOIN item_totals it ON it.id = n.ppe_item_id
        WHERE n.status != 'canceled' AND n.created_at >= NOW() - INTERVAL '6 months'
        GROUP BY it.name, it.total, month_date, month
        ORDER BY it.total DESC, month_date ASC
      `),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE overall_status='compliant') as compliant FROM audits WHERE audit_date >= date_trunc('month',NOW()) AND is_deleted IS NOT TRUE`),
      pool.query(`
        SELECT
          MAX(CASE WHEN status='pending' THEN CURRENT_DATE - date_flagged::date END) as ehs_delay,
          MAX(CASE WHEN status='ehs_purchase_requested' THEN CURRENT_DATE - date_purchase_requested::date END) as scm_delay,
          MAX(CASE WHEN status='scm_ordered' THEN CURRENT_DATE - date_ordered::date END) as suppliers_delay,
          MAX(CASE WHEN status='warehouse_available' THEN CURRENT_DATE - date_available::date END) as projects_delay,
          MAX(CASE WHEN status NOT IN ('distributed','resolved','canceled','exit') THEN CURRENT_DATE - date_flagged::date END) as total_delay
        FROM ppe_requests
        WHERE status NOT IN ('distributed','resolved','canceled','exit')
      `),
      pool.query(`SELECT a.id,a.audit_date,a.overall_status,COALESCE(e.full_name,c.full_name) as employee_name,e.employee_number,COALESCE(e.national_id,c.national_id) as national_id,e.department,COALESCE(e.project,c.project) as project,u.full_name as audited_by_name,COUNT(ai.id) as total_items,COUNT(CASE WHEN ai.condition!='good' THEN 1 END) as issues_count FROM audits a LEFT JOIN employees e ON e.id=a.employee_id LEFT JOIN casuals c ON c.id=a.casual_id JOIN users u ON u.id=a.audited_by LEFT JOIN audit_items ai ON ai.audit_id=a.id GROUP BY a.id,e.full_name,c.full_name,e.employee_number,e.national_id,c.national_id,e.department,e.project,c.project,u.full_name ORDER BY a.created_at DESC LIMIT 5`)
    ]);
    const c = comp.rows[0];
    // Pivot the item/month rows into a fixed 6-column grid -- generated
    // independently of the query results so months with zero NCRs still
    // show up as a (zero-filled) column instead of leaving a gap.
    const heatmapMonths = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      heatmapMonths.push(new Date(now.getFullYear(), now.getMonth() - i, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' }));
    }
    const heatmapItems = new Map();
    for (const row of ncrCat.rows) {
      if (!heatmapItems.has(row.ppe_name)) heatmapItems.set(row.ppe_name, { ppe_name: row.ppe_name, total: parseInt(row.total), byMonth: {} });
      heatmapItems.get(row.ppe_name).byMonth[row.month] = parseInt(row.count);
    }
    const ncrHeatmap = {
      months: heatmapMonths,
      items: [...heatmapItems.values()]
        .sort((a, b) => b.total - a.total)
        .map(it => ({ ppe_name: it.ppe_name, total: it.total, counts: heatmapMonths.map(m => it.byMonth[m] || 0) })),
    };
    res.json({
      employees: { active: parseInt(emp.rows[0].active), exits_this_year: parseInt(emp.rows[0].exits_this_year) },
      overdue: parseInt(overdue.rows[0].overdue),
      ncr: { open: parseInt(ncr.rows[0].open), pending: parseInt(ncr.rows[0].pending), heatmap: ncrHeatmap },
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

// Restricts a query to outsource resources of the caller's permitted subtype(s),
// for the Outsource page (?outsource_scope=1) and always for the fleet role.
// Returns a SQL fragment appended to the WHERE (may push a param). Relies on the
// `oe` (outsource_entities) join that both the list and stats queries already have.
function outsourceScopeClause(req, params) {
  const wants = req.query.outsource_scope === '1' || req.user.role === 'fleet';
  if (!wants) return '';
  let c = ` AND e.resource_type='outsource'`;
  // The subtype grant (outsource_access) limits outsource MANAGERS (fleet/supervisor)
  // to the subtype(s) they manage. Admin and oversight roles (project_director) see all
  // subtypes, still scoped to their projects/clients by the filters applied separately.
  if (req.user.role !== 'admin' && req.user.role !== 'project_director') {
    const subs = Array.isArray(req.user.outsource_access) ? req.user.outsource_access : [];
    if (!subs.length) return ` AND 1=0`; // no subtype granted → sees nothing
    params.push(subs); c += ` AND oe.type = ANY($${params.length})`;
  }
  return c;
}

// Employees
app.get('/api/employees', auth, async (req, res) => {
  if (!['admin','hr','ehs_manager','ehs_officer','supervisor','fleet','project_director'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    const { status, search, national_id, employee_number, project, client, san, job_title, department, resource_type, classification, audit_age, page, pageSize } = req.query;
    // Other pages (pickers/dropdowns) call this endpoint without `page` and need
    // the old bare-array shape with every matching row -- only paginate, and only
    // switch to the {rows,total,...} shape, when a page param is actually sent.
    const paginate = !!page;
    const limit = paginate ? Math.min(Math.max(parseInt(pageSize) || 25, 1), 100) : null;
    const pageNum = paginate ? Math.max(parseInt(page) || 1, 1) : 1;
    const offset = paginate ? (pageNum - 1) * limit : 0;
    let q = `SELECT e.*, MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE AND a.is_deleted IS NOT TRUE) as last_audit_date, CURRENT_DATE - MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE AND a.is_deleted IS NOT TRUE) as days_since_audit, COUNT(epa.id) > 0 as ppe_assigned, u.full_name as ppe_last_edited_by_name, ued.full_name as last_edited_by_name, COALESCE(uc.full_name, e.created_by_name_text) as created_by_name, COALESCE(ex.changed_by_name, e.exited_by_name_text) as exited_by_name, ex.changed_at as exited_at, CASE WHEN LOWER(TRIM(e.organization))='egypro' AND COALESCE(e.job_title,'') NOT ILIKE '%intern%' THEN 'Inhouse' WHEN LOWER(TRIM(e.organization))='egypro' AND e.job_title ILIKE '%intern%' THEN 'Intern' WHEN oe.type='services' THEN 'Outsource (Services)' WHEN oe.type='vehicle_supplier' THEN 'Outsource (Vehicle Supplier)' ELSE 'Outsource' END as classification, COUNT(*) OVER() as full_count FROM employees e LEFT JOIN audits a ON a.employee_id=e.id LEFT JOIN employee_ppe_assignments epa ON epa.employee_id=e.id LEFT JOIN users u ON u.id=e.ppe_last_edited_by LEFT JOIN users ued ON ued.id=e.last_edited_by LEFT JOIN users uc ON uc.id=e.created_by LEFT JOIN outsource_entities oe ON LOWER(TRIM(oe.name))=LOWER(TRIM(e.organization)) LEFT JOIN LATERAL (SELECT changed_by_name, changed_at FROM employee_change_log WHERE employee_id=e.id AND action='exit' ORDER BY changed_at DESC LIMIT 1) ex ON true WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); q += ` AND e.employment_status=$${params.length}`; }
    if (search) { params.push(`%${search}%`); q += ` AND (e.full_name ILIKE $${params.length} OR e.employee_number ILIKE $${params.length})`; }
    if (national_id) { params.push(`%${national_id}%`); q += ` AND e.national_id ILIKE $${params.length}`; }
    if (employee_number) { params.push(`%${employee_number}%`); q += ` AND e.employee_number ILIKE $${params.length}`; }
    if (project) { params.push(project); q += ` AND e.project=$${params.length}`; }
    if (client) { params.push(client); q += ` AND e.client=$${params.length}`; }
    if (san === 'yes') { q += ` AND (e.san IS NULL OR e.san = TRUE)`; }
    if (san === 'no') { q += ` AND e.san = FALSE`; }
    if (job_title) { params.push(`%${job_title}%`); q += ` AND e.job_title ILIKE $${params.length}`; }
    if (department) { params.push(department); q += ` AND e.department=$${params.length}`; }
    // 'intern' isn't a real resource_type value -- interns are stored as
    // resource_type='inhouse' and identified by job title. 'inhouse' has to
    // explicitly exclude them so the two stat-card filters stay disjoint.
    if (resource_type === 'intern') { q += ` AND e.job_title ILIKE '%intern%'`; }
    else if (resource_type === 'inhouse') { q += ` AND e.resource_type='inhouse' AND e.job_title NOT ILIKE '%intern%'`; }
    else if (resource_type) { params.push(resource_type); q += ` AND e.resource_type=$${params.length}`; }
    // Classification filter (Inhouse/Intern derived from org+job title; the two
    // Outsource kinds from the organization's entity type via the oe join).
    if (classification === 'inhouse') { q += ` AND LOWER(TRIM(e.organization))='egypro' AND COALESCE(e.job_title,'') NOT ILIKE '%intern%'`; }
    else if (classification === 'intern') { q += ` AND LOWER(TRIM(e.organization))='egypro' AND e.job_title ILIKE '%intern%'`; }
    else if (classification === 'outsource_services') { q += ` AND oe.type='services'`; }
    else if (classification === 'outsource_vehicle_supplier') { q += ` AND oe.type='vehicle_supplier'`; }
    else if (classification === 'outsource') { q += ` AND LOWER(TRIM(e.organization))<>'egypro' AND oe.type IS NULL`; }
    q += outsourceScopeClause(req, params);
    const empProjects = await getProjectFilter(req.user);
    if (empProjects !== null) {
      if (empProjects.length === 0) { return res.json(paginate ? { rows: [], total: 0, page: pageNum, pageSize: limit } : []); }
      params.push(empProjects); q += ` AND e.project = ANY($${params.length})`;
    }
    const empClients = await getClientFilter(req.user);
    if (empClients !== null) {
      if (empClients.length === 0) { return res.json(paginate ? { rows: [], total: 0, page: pageNum, pageSize: limit } : []); }
      params.push(empClients); q += ` AND e.client = ANY($${params.length})`;
    }
    q += ` GROUP BY e.id, u.full_name, ued.full_name, uc.full_name, ex.changed_by_name, ex.changed_at, oe.type`;
    // audit_age filters on an aggregate (days since the last audit), so it has
    // to be a HAVING clause -- can't reference the SELECT alias here.
    const auditAgeExpr = `CURRENT_DATE - MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE AND a.is_deleted IS NOT TRUE)`;
    if (audit_age === '1month') q += ` HAVING ${auditAgeExpr} <= 30`;
    else if (audit_age === '2months') q += ` HAVING ${auditAgeExpr} > 30 AND ${auditAgeExpr} <= 60`;
    else if (audit_age === 'over2months') q += ` HAVING (MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE AND a.is_deleted IS NOT TRUE) IS NULL OR ${auditAgeExpr} > 60)`;
    q += ` ORDER BY e.full_name`;
    if (paginate) { params.push(limit, offset); q += ` LIMIT $${params.length - 1} OFFSET $${params.length}`; }
    const { rows } = await pool.query(q, params);
    if (!paginate) return res.json(rows);
    const total = rows.length ? parseInt(rows[0].full_count) : 0;
    res.json({ rows, total, page: pageNum, pageSize: limit });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Filter-scoped stat card counts for the Employees page -- mirrors Audit
// History's pattern since these cards already reflected active filters
// before pagination (unlike PPE Tracker's global counts).
app.get('/api/employees/stats', auth, async (req, res) => {
  if (!['admin','hr','ehs_manager','ehs_officer','supervisor','fleet','project_director'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    const { status, search, national_id, employee_number, project, client, san, job_title, department, resource_type, classification, audit_age } = req.query;
    const zero = { total_active: 0, inhouse: 0, outsource: 0, interns: 0, exits: 0 };
    let q = `WITH scoped AS (
        SELECT e.employment_status, e.resource_type, e.job_title, oe.type as otype,
          CURRENT_DATE - MAX(a.audit_date) FILTER (WHERE a.employee_present = TRUE AND a.is_deleted IS NOT TRUE) as days_since_audit
        FROM employees e
        LEFT JOIN audits a ON a.employee_id=e.id
        LEFT JOIN outsource_entities oe ON LOWER(TRIM(oe.name))=LOWER(TRIM(e.organization))
        WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); q += ` AND e.employment_status=$${params.length}`; }
    if (search) { params.push(`%${search}%`); q += ` AND (e.full_name ILIKE $${params.length} OR e.employee_number ILIKE $${params.length})`; }
    if (national_id) { params.push(`%${national_id}%`); q += ` AND e.national_id ILIKE $${params.length}`; }
    if (employee_number) { params.push(`%${employee_number}%`); q += ` AND e.employee_number ILIKE $${params.length}`; }
    if (project) { params.push(project); q += ` AND e.project=$${params.length}`; }
    if (client) { params.push(client); q += ` AND e.client=$${params.length}`; }
    if (san === 'yes') { q += ` AND (e.san IS NULL OR e.san = TRUE)`; }
    if (san === 'no') { q += ` AND e.san = FALSE`; }
    if (job_title) { params.push(`%${job_title}%`); q += ` AND e.job_title ILIKE $${params.length}`; }
    if (department) { params.push(department); q += ` AND e.department=$${params.length}`; }
    // 'intern' isn't a real resource_type value -- interns are stored as
    // resource_type='inhouse' and identified by job title. 'inhouse' has to
    // explicitly exclude them so the two stat-card filters stay disjoint.
    if (resource_type === 'intern') { q += ` AND e.job_title ILIKE '%intern%'`; }
    else if (resource_type === 'inhouse') { q += ` AND e.resource_type='inhouse' AND e.job_title NOT ILIKE '%intern%'`; }
    else if (resource_type) { params.push(resource_type); q += ` AND e.resource_type=$${params.length}`; }
    // Classification filter (Inhouse/Intern derived from org+job title; the two
    // Outsource kinds from the organization's entity type via the oe join).
    if (classification === 'inhouse') { q += ` AND LOWER(TRIM(e.organization))='egypro' AND COALESCE(e.job_title,'') NOT ILIKE '%intern%'`; }
    else if (classification === 'intern') { q += ` AND LOWER(TRIM(e.organization))='egypro' AND e.job_title ILIKE '%intern%'`; }
    else if (classification === 'outsource_services') { q += ` AND oe.type='services'`; }
    else if (classification === 'outsource_vehicle_supplier') { q += ` AND oe.type='vehicle_supplier'`; }
    else if (classification === 'outsource') { q += ` AND LOWER(TRIM(e.organization))<>'egypro' AND oe.type IS NULL`; }
    q += outsourceScopeClause(req, params);
    const empProjects = await getProjectFilter(req.user);
    if (empProjects !== null) {
      if (empProjects.length === 0) return res.json(zero);
      params.push(empProjects); q += ` AND e.project = ANY($${params.length})`;
    }
    const empClients = await getClientFilter(req.user);
    if (empClients !== null) {
      if (empClients.length === 0) return res.json(zero);
      params.push(empClients); q += ` AND e.client = ANY($${params.length})`;
    }
    q += ` GROUP BY e.id, oe.type
      )
      SELECT
        COUNT(*) FILTER (WHERE employment_status='active') as total_active,
        COUNT(*) FILTER (WHERE resource_type='inhouse' AND job_title NOT ILIKE '%intern%') as inhouse,
        COUNT(*) FILTER (WHERE resource_type='outsource') as outsource,
        COUNT(*) FILTER (WHERE job_title ILIKE '%intern%') as interns,
        COUNT(*) FILTER (WHERE employment_status='active' AND otype='services') as services,
        COUNT(*) FILTER (WHERE employment_status='active' AND otype='vehicle_supplier') as vehicle_supplier,
        COUNT(*) FILTER (WHERE employment_status='exit') as exits
      FROM scoped WHERE 1=1`;
    if (audit_age === '1month') q += ` AND days_since_audit <= 30`;
    else if (audit_age === '2months') q += ` AND days_since_audit > 30 AND days_since_audit <= 60`;
    else if (audit_age === 'over2months') q += ` AND (days_since_audit IS NULL OR days_since_audit > 60)`;
    const { rows } = await pool.query(q, params);
    const r = rows[0];
    res.json({ total_active: parseInt(r.total_active)||0, inhouse: parseInt(r.inhouse)||0, outsource: parseInt(r.outsource)||0, interns: parseInt(r.interns)||0, services: parseInt(r.services)||0, vehicle_supplier: parseInt(r.vehicle_supplier)||0, exits: parseInt(r.exits)||0 });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Distinct department/project/client values for the Employees filter
// dropdowns -- needed now that the main list is paginated.
// A National ID must be globally unique across EVERY resource — employees of any
// resource_type (inhouse/intern/outsource) AND casuals. Returns a human label of
// the current owner, or null if free. Used by the manual add + casual add paths.
async function nationalIdConflict(nationalId, { excludeEmployeeId = null, excludeCasualId = null } = {}) {
  const nid = String(nationalId || '').trim();
  if (!nid) return null;
  const emp = await pool.query('SELECT full_name FROM employees WHERE national_id=$1 AND ($2::uuid IS NULL OR id<>$2) LIMIT 1', [nid, excludeEmployeeId]);
  if (emp.rows.length) return `an employee (${emp.rows[0].full_name})`;
  const cas = await pool.query('SELECT full_name FROM casuals WHERE national_id=$1 AND ($2::uuid IS NULL OR id<>$2) LIMIT 1', [nid, excludeCasualId]);
  if (cas.rows.length) return `a casual (${cas.rows[0].full_name})`;
  return null;
}

app.get('/api/employees/filter-options', auth, async (req, res) => {
  if (!['admin','hr','ehs_manager','ehs_officer','supervisor','project_director'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    let q = `SELECT
        ARRAY_AGG(DISTINCT e.department) FILTER (WHERE e.department IS NOT NULL) as departments,
        ARRAY_AGG(DISTINCT e.project) FILTER (WHERE e.project IS NOT NULL) as projects,
        ARRAY_AGG(DISTINCT e.client) FILTER (WHERE e.client IS NOT NULL) as clients,
        ARRAY_AGG(DISTINCT e.organization) FILTER (WHERE e.organization IS NOT NULL AND e.organization <> '') as organizations
      FROM employees e WHERE 1=1`;
    const params = [];
    const empProjects = await getProjectFilter(req.user);
    if (empProjects !== null) {
      if (empProjects.length === 0) return res.json({ departments: [], projects: [], clients: [], organizations: [] });
      params.push(empProjects); q += ` AND e.project = ANY($${params.length})`;
    }
    const empClients = await getClientFilter(req.user);
    if (empClients !== null) {
      if (empClients.length === 0) return res.json({ departments: [], projects: [], clients: [], organizations: [] });
      params.push(empClients); q += ` AND e.client = ANY($${params.length})`;
    }
    const { rows } = await pool.query(q, params);
    res.json({
      departments: (rows[0].departments || []).sort(),
      projects: (rows[0].projects || []).sort(),
      clients: (rows[0].clients || []).sort(),
      organizations: (rows[0].organizations || []).sort(),
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/audit-coverage', auth, async (req, res) => {
  try {
    const projectFilter = await getProjectFilter(req.user);
    const clientFilter = await getClientFilter(req.user);
    if ((projectFilter !== null && projectFilter.length === 0) || (clientFilter !== null && clientFilter.length === 0)) {
      return res.json({
        total_active: 0, san_count: 0, san_inhouse: 0, san_outsource: 0,
        non_san_count: 0, non_san_inhouse: 0, non_san_outsource: 0,
        bucket_0_30: 0, bucket_31_60: 0, bucket_61_90: 0, bucket_90_plus: 0, never_audited: 0,
        overdue_total: 0, audit_rate: null, avg_days_since_audit: null,
        this_month_audited: 0, last_month_audited: 0, by_project: []
      });
    }

    const requestedProjects = String(req.query.project || '').split(',').map(s => s.trim()).filter(Boolean);
    const requestedClients = String(req.query.client || '').split(',').map(s => s.trim()).filter(Boolean);
    const params = [];
    let whereExtra = '';
    if (projectFilter !== null) { params.push(projectFilter); whereExtra += ` AND e.project = ANY($${params.length})`; }
    if (clientFilter !== null) { params.push(clientFilter); whereExtra += ` AND e.client = ANY($${params.length})`; }
    if (requestedProjects.length) { params.push(requestedProjects); whereExtra += ` AND e.project = ANY($${params.length})`; }
    if (requestedClients.length) { params.push(requestedClients); whereExtra += ` AND e.client = ANY($${params.length})`; }

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
        COUNT(*) FILTER (WHERE e.employment_status='active' AND e.san=TRUE AND e.resource_type='inhouse' ${whereExtra}) as san_inhouse,
        COUNT(*) FILTER (WHERE e.employment_status='active' AND e.san=TRUE AND e.resource_type='outsource' ${whereExtra}) as san_outsource,
        COUNT(*) FILTER (WHERE e.employment_status='active' AND e.san=FALSE ${whereExtra}) as non_san_count,
        COUNT(*) FILTER (WHERE e.employment_status='active' AND e.san=FALSE AND e.resource_type='inhouse' ${whereExtra}) as non_san_inhouse,
        COUNT(*) FILTER (WHERE e.employment_status='active' AND e.san=FALSE AND e.resource_type='outsource' ${whereExtra}) as non_san_outsource
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
      SELECT project, client,
        COUNT(*) as san_total,
        COUNT(*) FILTER (WHERE days_since IS NULL OR days_since > 30) as overdue
      FROM san_emp
      GROUP BY project, client
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
      san_inhouse: parseInt(t.san_inhouse) || 0,
      san_outsource: parseInt(t.san_outsource) || 0,
      non_san_count: parseInt(t.non_san_count) || 0,
      non_san_inhouse: parseInt(t.non_san_inhouse) || 0,
      non_san_outsource: parseInt(t.non_san_outsource) || 0,
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
      by_project: byProject.rows.map(r => ({ project: r.project, client: r.client, san_total: parseInt(r.san_total), overdue: parseInt(r.overdue) }))
    });
  } catch(e) { sendError(res, e); }
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

// Every PPE/Tool allocation in one call: one row per employee-and-item, so it
// can be exported and pivoted. Only the per-employee view existed, which is no
// use for "what is everyone allocated" without 800 round trips.
//
// Employees with nothing allocated are included with a blank item -- an export
// that silently drops them would read as though everyone has PPE assigned.
app.get('/api/employees/ppe-allocations', auth, async (req, res) => {
  // Admin only. This is every employee's full PPE picture in one download, a
  // wider view than the page it is reached from, so it is gated more tightly.
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const params = [];
    let w = ` WHERE e.employment_status = $1`;
    params.push(req.query.employment_status || 'active');
    const projects = await getProjectFilter(req.user);
    if (projects !== null) {
      if (projects.length === 0) return res.json([]);
      params.push(projects); w += ` AND e.project = ANY($${params.length})`;
    }
    const clients = await getClientFilter(req.user);
    if (clients !== null) {
      if (clients.length === 0) return res.json([]);
      params.push(clients); w += ` AND e.client = ANY($${params.length})`;
    }
    const { rows } = await pool.query(`
      SELECT e.full_name AS employee_name, e.employee_number, e.national_id, e.job_title,
             e.department, e.project, e.client, e.organization, e.resource_type, e.employment_status,
             p.name AS ppe_item, p.category,
             (SELECT MAX(pr.date_distributed) FROM ppe_requests pr
               WHERE pr.employee_id = e.id AND pr.ppe_item_id = p.id AND pr.date_distributed IS NOT NULL
             ) AS last_distributed
        FROM employees e
        LEFT JOIN employee_ppe_assignments epa ON epa.employee_id = e.id
        LEFT JOIN ppe_items p ON p.id = epa.ppe_item_id AND p.is_active = TRUE
        ${w}
       ORDER BY e.full_name, p.sort_order NULLS LAST, p.name`, params);
    res.json(rows);
  } catch (e) { sendError(res, e); }
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
  const scope = await getPersonScope(req.params.id);
  if (!scope || !(await inScope(req.user, scope.project, scope.client))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const { rows } = await pool.query(`
    SELECT p.*,
      (SELECT MAX(pr.date_distributed) FROM ppe_requests pr WHERE pr.employee_id=$1 AND pr.ppe_item_id=p.id AND pr.date_distributed IS NOT NULL) as last_distributed
    FROM ppe_items p JOIN employee_ppe_assignments epa ON epa.ppe_item_id=p.id
    WHERE epa.employee_id=$1 AND p.is_active=true ORDER BY p.sort_order
  `, [req.params.id]);
  res.json(rows);
});


// PPE allocation is saved by replacing the whole set, so a change is only
// visible as the difference between what was there and what is now. Work that
// out and record one row per item added or removed -- otherwise the fact that
// someone's harness was taken off them leaves no trace at all.
const logPpeAssignmentDiff = async (client, { employeeId, casualId, beforeIds, afterIds, user }) => {
  const before = new Set(beforeIds);
  const after = new Set(afterIds);
  const added = [...after].filter(id => !before.has(id));
  const removed = [...before].filter(id => !after.has(id));
  if (!added.length && !removed.length) return;
  const { rows: [p] } = await client.query(
    employeeId
      ? 'SELECT full_name, national_id, organization, project, client FROM employees WHERE id=$1'
      : 'SELECT full_name, national_id, organization, project, client FROM casuals WHERE id=$1',
    [employeeId || casualId]
  );
  const ids = [...added, ...removed];
  const { rows: items } = await client.query('SELECT id, name FROM ppe_items WHERE id = ANY($1::uuid[])', [ids]);
  const nameOf = Object.fromEntries(items.map(i => [i.id, i.name]));
  for (const [list, action] of [[added, 'added'], [removed, 'removed']]) {
    for (const id of list) {
      await client.query(
        `INSERT INTO ppe_assignment_log (employee_id, casual_id, person_name, national_id, organization,
           project, client, ppe_item_id, ppe_item_name, action, changed_by, changed_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [employeeId || null, casualId || null, p?.full_name || null, p?.national_id || null, p?.organization || null,
         p?.project || null, p?.client || null, id, nameOf[id] || null, action, user.id, user.name || null]
      );
    }
  }
};

app.put('/api/employees/:id/ppe-assignments', auth, async (req, res) => {
  if (!['admin','ehs_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const employeeId = req.params.id;
  const scope = await getPersonScope(employeeId);
  if (!scope || !(await inScope(req.user, scope.project, scope.client))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const { ppe_item_ids } = req.body; // array of UUIDs
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: had } = await client.query('SELECT ppe_item_id FROM employee_ppe_assignments WHERE employee_id=$1', [employeeId]);
    await client.query('DELETE FROM employee_ppe_assignments WHERE employee_id=$1', [employeeId]);
    if (ppe_item_ids && ppe_item_ids.length > 0) {
      for (const ppeId of ppe_item_ids) {
        await client.query('INSERT INTO employee_ppe_assignments (employee_id, ppe_item_id) VALUES ($1,$2)', [employeeId, ppeId]);
      }
    }
    await logPpeAssignmentDiff(client, {
      employeeId, beforeIds: had.map(r => r.ppe_item_id), afterIds: ppe_item_ids || [], user: req.user,
    });
    await client.query('UPDATE employees SET ppe_last_edited_by=$1, ppe_last_edited_at=NOW() WHERE id=$2', [req.user.id, employeeId]);
    await client.query('COMMIT');
    broadcastEmployeesChanged();
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    sendError(res, e);
  } finally {
    client.release();
  }
});

app.post('/api/employees', auth, async (req, res) => {
  if (req.user.role === 'ehs_officer') return res.status(403).json({ error: 'Not authorized' });
  let { employee_number, full_name, national_id, job_title, department, project, client, organization, resource_type, employment_status } = req.body;
  resource_type = resource_type?.toLowerCase();
  employment_status = employment_status?.toLowerCase();
  // Employment ID is IN-HOUSE only. Never import/assign one from ETMS for
  // interns or outsource (word-boundary \bintern\b so "International" is safe).
  const noEmpId = ['outsource', 'intern'].includes(resource_type) || /\bintern\b/i.test(job_title || '');

  const dbClient = await pool.connect();
  try {
    // Upsert: if national_id exists, update instead of insert
    if (national_id) {
      const existing = await dbClient.query('SELECT id FROM employees WHERE national_id=$1', [national_id]);
      if (existing.rows.length > 0) {
        await dbClient.query('BEGIN');
        const { rows } = await dbClient.query(
          `UPDATE employees SET full_name=$1, job_title=$2, department=$3, project=$4, client=$5, organization=$6, resource_type=$7, employment_status=$8${noEmpId ? ', employee_number=NULL' : ''} WHERE national_id=$9 RETURNING *`,
          [full_name, job_title, department, project, client, organization, resource_type, employment_status || 'active', national_id]
        );
        const empId = rows[0].id;
        // Employment status can flip to 'exit' via automated sync (e.g. ETMS),
        // not just the admin exit dialog -- cascade the same way here so
        // synced exits also close out any open PPE requests.
        if (employment_status === 'exit') {
          await dbClient.query(`UPDATE ppe_requests SET status='exit', updated_at=NOW() WHERE employee_id=$1 AND status NOT IN ('distributed','canceled','exit')`, [empId]);
          await dbClient.query(`UPDATE ncr_items SET status='exit', updated_at=NOW() WHERE employee_id=$1 AND status NOT IN ('resolved','distributed','canceled','exit')`, [empId]);
        }
        await dbClient.query('COMMIT');
        broadcastEmployeesChanged();
        return res.json(rows[0]);
      }
    }
    const empNumber = noEmpId ? null : (employee_number || national_id || ('EMP-' + Date.now()));
    const { rows } = await dbClient.query(`INSERT INTO employees (employee_number,full_name,national_id,job_title,department,project,client,organization,resource_type,employment_status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [empNumber, full_name, national_id, job_title, department, project, client, organization, resource_type, employment_status || 'active', req.user.id]);
    broadcastEmployeesChanged();
    res.status(201).json(rows[0]);
  } catch(e) {
    await dbClient.query('ROLLBACK').catch(()=>{});
    if (e.code === '23505') return res.status(409).json({ error: 'Employee number exists' });
    res.status(500).json({ error: 'Server error' });
  } finally {
    dbClient.release();
  }
});

// Update employee status (admin only)
app.put('/api/employees/:id/status', auth, async (req, res) => {
  // Authorized after the row loads (below): HR with edit_employee may exit anyone;
  // an outsource subtype-manager may exit only outsource of their subtype.
  const { employment_status, exit_date } = req.body;
  if (employment_status && !['active', 'exit'].includes(employment_status)) {
    return res.status(400).json({ error: 'Invalid employment_status' });
  }
  if (exit_date && isNaN(Date.parse(exit_date))) return res.status(400).json({ error: 'Invalid exit_date' });
  const { reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM employees WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (!(await canManageEmployee(req.user, cur, 'edit_employee'))) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Not authorized' }); }
    await client.query('UPDATE employees SET employment_status=$1, exit_date=$2, updated_at=NOW() WHERE id=$3', [employment_status, exit_date || null, req.params.id]);
    if (employment_status === 'exit') {
      await client.query(`UPDATE ppe_requests SET status='exit', updated_at=NOW() WHERE employee_id=$1 AND status NOT IN ('distributed','canceled','exit')`, [req.params.id]);
      await client.query(`UPDATE ncr_items SET status='exit', updated_at=NOW() WHERE employee_id=$1 AND status NOT IN ('resolved','distributed','canceled','exit')`, [req.params.id]);
    }
    // Log a status change (exit / reactivate) to the employee history.
    if (employment_status && employment_status !== cur.employment_status) {
      const changes = [{ field: 'Status', before: cur.employment_status, after: employment_status }];
      await client.query(
        `INSERT INTO employee_change_log (employee_id, employee_name, national_id, employee_number, action, reason, changes, changed_by, changed_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [cur.id, cur.full_name, cur.national_id, cur.employee_number, employment_status === 'exit' ? 'exit' : 'reactivate', reason?.trim() || null, JSON.stringify(changes), req.user.id, req.user.name || null]
      );
    }
    await client.query('COMMIT');
    const { rows } = await pool.query('SELECT * FROM employees WHERE id=$1', [req.params.id]);
    broadcastEmployeesChanged();
    // Free any company mobile line this person was holding. The sweep also runs
    // on a schedule and on the Mobile Lines screens, because an exit can arrive
    // through the SharePoint sync instead of here -- this call just makes the
    // common case immediate. Deliberately not awaited into the response.
    if (employment_status === 'exit') mobileLines.releaseLinesForExitedEmployees().catch(() => {});
    res.json(rows[0]);
  } catch(e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Server error' }); }
  finally { client.release(); }
});

// Toggle SAN (admin only)
app.put('/api/employees/:id/san', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { san } = req.body;
  const { rows } = await pool.query('UPDATE employees SET san=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [san, req.params.id]);
  broadcastEmployeesChanged();
  res.json(rows[0]);
});

// Edit an employee's core details (admin, hr) — records who/when + a mandatory
// reason (mirrors the ETMS "Update Resource's Details" screen). employee_number,
// organization, resource_type and employment_status are NOT editable here.
// Every save writes an immutable field-level diff to employee_change_log.
const EMPLOYEE_EDITABLE = [
  { key: 'full_name', label: 'Employee Name' },
  { key: 'job_title', label: 'Job Title' },
  { key: 'department', label: 'Department' },
  { key: 'project', label: 'Project' },
  { key: 'client', label: 'Client' },
];
app.put('/api/employees/:id', auth, async (req, res) => {
  // Authorized after the row loads (below): HR with edit_employee may edit anyone;
  // an outsource subtype-manager may edit only outsource of their subtype.
  const { full_name, national_id, job_title, department, project, client, reason } = req.body;
  if (!full_name || !full_name.trim()) return res.status(400).json({ error: 'Employee name is required' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason for the update is required' });
  const next = {
    full_name: full_name.trim(),
    job_title: job_title?.trim() || null,
    department: department || null,
    project: project || null,
    client: client || null,
  };
  const client_db = await pool.connect();
  try {
    await client_db.query('BEGIN');
    const cur = (await client_db.query('SELECT * FROM employees WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!cur) { await client_db.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (!(await canManageEmployee(req.user, cur, 'edit_employee'))) { await client_db.query('ROLLBACK'); return res.status(403).json({ error: 'Not authorized' }); }
    // Field-level diff over the editable fields only (national_id is read-only).
    const norm = (v) => (v === undefined || v === null || v === '') ? null : v;
    const changes = EMPLOYEE_EDITABLE
      .filter(f => norm(cur[f.key]) !== norm(next[f.key]))
      .map(f => ({ field: f.label, before: cur[f.key] || null, after: next[f.key] || null }));
    const { rows } = await client_db.query(
      `UPDATE employees SET full_name=$1, national_id=$2, job_title=$3, department=$4, project=$5, client=$6,
         last_edit_reason=$7, last_edited_by=$8, last_edited_at=NOW(), updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [next.full_name, national_id || null, next.job_title, next.department, next.project, next.client, reason.trim(), req.user.id, req.params.id]
    );
    // Only record history when something actually changed.
    if (changes.length) {
      await client_db.query(
        `INSERT INTO employee_change_log (employee_id, employee_name, national_id, employee_number, action, reason, changes, changed_by, changed_by_name)
         VALUES ($1,$2,$3,$4,'update',$5,$6::jsonb,$7,$8)`,
        [cur.id, cur.full_name, cur.national_id, cur.employee_number, reason.trim(), JSON.stringify(changes), req.user.id, req.user.name || null]
      );
    }
    await client_db.query('COMMIT');
    broadcastEmployeesChanged();
    res.json({ ...rows[0], changed_fields: changes.length });
  } catch (e) { await client_db.query('ROLLBACK'); sendError(res, e); }
  finally { client_db.release(); }
});

// Convert an intern to a full in-house employee: assign a real Job Title + an
// Employment ID, mark the resource in-house, and set the Added date to the
// conversion date (they start as an employee today). Logged to the change history,
// so it flows into the daily employee-changes email automatically.
app.post('/api/employees/:id/promote', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM employees WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (!(await canManageEmployee(req.user, cur, 'edit_employee'))) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Not authorized' }); }
    if (!/\bintern\b/i.test(cur.job_title || '')) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only an intern can be converted to in-house.' }); }
    const job_title = String(req.body.job_title || '').trim();
    const employee_number = String(req.body.employee_number || '').trim();
    const reason = String(req.body.reason || '').trim() || 'Converted from Intern to In-House';
    if (!job_title) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Job Title is required' }); }
    if (/\bintern\b/i.test(job_title)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Pick a non-intern Job Title.' }); }
    if (!employee_number) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Employment ID is required' }); }
    const dup = await client.query('SELECT id FROM employees WHERE employee_number=$1 AND id<>$2', [employee_number, cur.id]);
    if (dup.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This Employment ID is already in use.' }); }
    await client.query(
      `UPDATE employees SET job_title=$1, employee_number=$2, resource_type='inhouse', added_on=CURRENT_DATE,
         last_edited_by=$3, last_edited_at=NOW(), last_edit_reason=$4, updated_at=NOW() WHERE id=$5`,
      [job_title, employee_number, req.user.id, reason, cur.id]);
    const changes = [
      { field: 'Job Title', before: cur.job_title || '—', after: job_title },
      { field: 'Employment Number', before: cur.employee_number || '—', after: employee_number },
      { field: 'Classification', before: 'Intern', after: 'In-House' },
    ];
    await client.query(
      `INSERT INTO employee_change_log (employee_id, employee_name, national_id, employee_number, action, reason, changes, changed_by, changed_by_name)
       VALUES ($1,$2,$3,$4,'update',$5,$6::jsonb,$7,$8)`,
      [cur.id, cur.full_name, cur.national_id, employee_number, reason, JSON.stringify(changes), req.user.id, req.user.name || null]);
    await client.query('COMMIT');
    broadcastEmployeesChanged();
    const { rows } = await pool.query('SELECT * FROM employees WHERE id=$1', [cur.id]);
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'This Employment ID is already in use.' });
    sendError(res, e);
  } finally { client.release(); }
});

// Employee change history (admin, hr) — the written record of who changed what,
// when, for which employee. Filterable by date range / action / employee, so the
// "what changed yesterday" digest and an on-demand review both read from here.
app.get('/api/employee-change-log', auth, async (req, res) => {
  if (!['admin', 'hr'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  try {
    const { from, to, action, search, page, pageSize } = req.query;
    const limit = Math.min(Math.max(parseInt(pageSize) || 50, 1), 200);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const offset = (pageNum - 1) * limit;
    // The log keeps a name/ID snapshot but no organization, so it is read from
    // the employee record. That is their CURRENT organization rather than the one
    // they had at the time -- the log has no history of it to offer.
    let q = `SELECT l.id, l.employee_id, l.employee_name, l.national_id, l.employee_number,
                    l.action, l.reason, l.changes, l.changed_by_name, l.changed_at,
                    e.organization, COUNT(*) OVER() as full_count
             FROM employee_change_log l
             LEFT JOIN employees e ON e.id = l.employee_id
             WHERE 1=1`;
    const params = [];
    if (from) { params.push(from); q += ` AND l.changed_at >= $${params.length}::date`; }
    if (to) { params.push(to); q += ` AND l.changed_at < ($${params.length}::date + INTERVAL '1 day')`; }
    if (action) { params.push(action); q += ` AND l.action = $${params.length}`; }
    if (search) { params.push(`%${search}%`); q += ` AND (l.employee_name ILIKE $${params.length} OR l.national_id ILIKE $${params.length} OR l.employee_number ILIKE $${params.length} OR e.organization ILIKE $${params.length})`; }
    q += ` ORDER BY l.changed_at DESC`;
    params.push(limit); q += ` LIMIT $${params.length}`;
    params.push(offset); q += ` OFFSET $${params.length}`;
    const { rows } = await pool.query(q, params);
    const total = rows.length ? parseInt(rows[0].full_count) : 0;
    res.json({ rows: rows.map(({ full_count, ...r }) => r), total, page: pageNum, pageSize: limit });
  } catch (e) { sendError(res, e); }
});

// PPE allocation history: one row per item added or removed, newest first.
// Same audience as the assignment screen itself.
app.get('/api/ppe-assignment-log', auth, async (req, res) => {
  if (!['admin','ehs_manager','hr'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  try {
    const { from, to, action, search, employee_id, page, pageSize } = req.query;
    const limit = Math.min(Math.max(parseInt(pageSize) || 50, 1), 200);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const params = [];
    let w = ' WHERE 1=1';
    if (from) { params.push(from); w += ` AND l.changed_at >= $${params.length}::date`; }
    if (to) { params.push(to); w += ` AND l.changed_at < ($${params.length}::date + INTERVAL '1 day')`; }
    if (action) { params.push(action); w += ` AND l.action = $${params.length}`; }
    if (employee_id) { params.push(employee_id); w += ` AND (l.employee_id = $${params.length} OR l.casual_id = $${params.length})`; }
    if (search) {
      params.push(`%${search}%`);
      w += ` AND (l.person_name ILIKE $${params.length} OR l.national_id ILIKE $${params.length}
                  OR l.ppe_item_name ILIKE $${params.length} OR l.organization ILIKE $${params.length})`;
    }
    // Scoped like every other person-linked list.
    const projects = await getProjectFilter(req.user);
    if (projects !== null) {
      if (projects.length === 0) return res.json({ rows: [], total: 0, page: 1, pageSize: limit });
      params.push(projects); w += ` AND l.project = ANY($${params.length})`;
    }
    const clients = await getClientFilter(req.user);
    if (clients !== null) {
      if (clients.length === 0) return res.json({ rows: [], total: 0, page: 1, pageSize: limit });
      params.push(clients); w += ` AND l.client = ANY($${params.length})`;
    }
    const { rows } = await pool.query(`
      SELECT l.*, (l.casual_id IS NOT NULL) AS is_casual, COUNT(*) OVER() AS full_count
        FROM ppe_assignment_log l ${w}
       ORDER BY l.changed_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (pageNum - 1) * limit]);
    const total = rows.length ? parseInt(rows[0].full_count) : 0;
    res.json({ rows: rows.map(({ full_count, ...r }) => r), total, page: pageNum, pageSize: limit });
  } catch (e) { sendError(res, e); }
});

// Hard-delete a single change-history record (admin only) — for correcting an
// erroneous entry. The log is otherwise append-only.
app.delete('/api/employee-change-log/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rowCount } = await pool.query('DELETE FROM employee_change_log WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

// ── Casuals ──────────────────────────────────────────────────
const CASUAL_EDIT_ROLES = ['admin', 'supervisor'];
const CASUAL_VIEW_ROLES = ['admin', 'supervisor', 'ehs_officer', 'ehs_manager', 'project_director'];

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
    q += ' GROUP BY c.id, u.full_name, u2.full_name ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { sendError(res, e); }
});

// Append one casual_events row per casual, inside the caller's transaction, so the
// event log is atomic with the add/reactivate. `actor` is { id, name }.
async function logCasualEvents(db, action, casualRows, actor) {
  if (!casualRows || !casualRows.length) return;
  await db.query(
    `INSERT INTO casual_events (casual_id, action, project, client, actor_id, actor_name)
     SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::text[], $4::text[], $5::uuid[], $6::text[])`,
    [
      casualRows.map(c => c.id),
      casualRows.map(() => action),
      casualRows.map(c => c.project || null),
      casualRows.map(c => c.client || null),
      casualRows.map(() => actor.id),
      casualRows.map(() => actor.name),
    ]
  );
}

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

    // One lookup for the whole batch instead of one SELECT per casual.
    const nationalIds = casuals.map(c => c.national_id).filter(Boolean);
    const namesLower = casuals.map(c => (c.full_name || '').toLowerCase()).filter(Boolean);
    const { rows: existingRows } = (nationalIds.length || namesLower.length)
      ? await client_db.query('SELECT * FROM casuals WHERE national_id = ANY($1::text[]) OR LOWER(full_name) = ANY($2::text[])', [nationalIds, namesLower])
      : { rows: [] };
    const existingByNationalId = new Map(existingRows.map(r => [r.national_id, r]));
    const existingByName = new Map(existingRows.map(r => [(r.full_name || '').toLowerCase(), r]));

    for (const c of casuals) {
      if (!c.full_name || !c.national_id) {
        skipped.push({ full_name: c.full_name || '(no name)', reason: 'Full name and National ID are required' });
        continue;
      }
      // Global uniqueness: a National ID already held by an employee can't be a casual.
      const empOwner = await client_db.query('SELECT full_name FROM employees WHERE national_id=$1 LIMIT 1', [c.national_id]);
      if (empOwner.rows.length) {
        skipped.push({ full_name: c.full_name, reason: `National ID ${c.national_id} already belongs to an employee (${empOwner.rows[0].full_name})` });
        continue;
      }
      const match = existingByNationalId.get(c.national_id);
      if (match) {
        if (match.employment_status === 'active') {
          skipped.push({ full_name: c.full_name, reason: `National ID ${c.national_id} already exists as an active casual (${match.full_name})` });
          continue;
        } else {
          const { rows } = await client_db.query(
            `UPDATE casuals SET full_name=$1, project=$2, client=$3, organization=$4, employment_status='active', exit_date=NULL, updated_at=NOW(), last_edited_by=$5
             WHERE id=$6 RETURNING *`,
            [c.full_name, project, client, organization || 'Egypro', req.user.id, match.id]
          );
          existingByNationalId.set(c.national_id, rows[0]); // catch duplicate national_ids within this same batch
          existingByName.set((c.full_name || '').toLowerCase(), rows[0]);
          reactivated.push(rows[0]);
          continue;
        }
      }
      // Full name must be unique too (a different national ID with the same name = a duplicate person).
      const nameMatch = existingByName.get((c.full_name || '').toLowerCase());
      if (nameMatch) {
        skipped.push({ full_name: c.full_name, reason: `Full name "${c.full_name}" already exists as another casual (National ID ${nameMatch.national_id})` });
        continue;
      }
      const { rows } = await client_db.query(
        `INSERT INTO casuals (full_name, national_id, job_title, project, client, organization, created_by, last_edited_by)
         VALUES ($1,$2,'Casual',$3,$4,$5,$6,$6) RETURNING *`,
        [c.full_name, c.national_id, project, client, organization || 'Egypro', req.user.id]
      );
      existingByNationalId.set(c.national_id, rows[0]); // catch duplicate national_ids within this same batch
      existingByName.set((c.full_name || '').toLowerCase(), rows[0]);
      inserted.push(rows[0]);
    }
    // Log events (new inserts, and re-adds of exited casuals) for the hourly digest.
    const actor = { id: req.user.id, name: req.user.name || req.user.email };
    await logCasualEvents(client_db, 'added', inserted, actor);
    await logCasualEvents(client_db, 'reactivated', reactivated, actor);
    await client_db.query('COMMIT');
    res.json({ inserted, reactivated, skipped });
  } catch(e) { await client_db.query('ROLLBACK'); sendError(res, e); }
  finally { client_db.release(); }
});

// Reactivate exited casuals in bulk (admin, supervisor only)
app.post('/api/casuals/reactivate', auth, async (req, res) => {
  if (!CASUAL_EDIT_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'At least one casual id is required' });
  }
  const client_db = await pool.connect();
  try {
    await client_db.query('BEGIN');
    // Only exited casuals can be reactivated.
    const { rows: candidates } = await client_db.query(
      `SELECT * FROM casuals WHERE id = ANY($1::uuid[]) AND employment_status = 'exit'`,
      [ids]
    );
    const reactivated = [];
    const skipped = [];
    for (const c of candidates) {
      // Respect the supervisor's project/client scope, same as edit/exit.
      if (!(await inScope(req.user, c.project, c.client))) {
        skipped.push({ full_name: c.full_name, reason: 'Outside your project/client access' });
        continue;
      }
      const { rows } = await client_db.query(
        `UPDATE casuals SET employment_status='active', exit_date=NULL, updated_at=NOW(), last_edited_by=$1
         WHERE id=$2 RETURNING *`,
        [req.user.id, c.id]
      );
      reactivated.push(rows[0]);
    }
    await logCasualEvents(client_db, 'reactivated', reactivated, { id: req.user.id, name: req.user.name || req.user.email });
    await client_db.query('COMMIT');
    res.json({ reactivated, skipped });
  } catch(e) { await client_db.query('ROLLBACK'); sendError(res, e); }
  finally { client_db.release(); }
});

// Edit a casual (admin, supervisor only)
app.put('/api/casuals/:id', auth, async (req, res) => {
  if (!CASUAL_EDIT_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const scope = await getPersonScope(req.params.id);
  if (!scope || !(await inScope(req.user, scope.project, scope.client))) {
    return res.status(404).json({ error: 'Not found' });
  }
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
  const scope = await getPersonScope(req.params.id);
  if (!scope || !(await inScope(req.user, scope.project, scope.client))) {
    return res.status(404).json({ error: 'Not found' });
  }
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
      await client_db.query(`UPDATE ppe_requests SET status='exit' WHERE casual_id=$1 AND status NOT IN ('distributed','resolved','canceled','exit')`, [req.params.id]);
      await client_db.query(`UPDATE ncr_items SET status='exit', updated_at=NOW() WHERE casual_id=$1 AND status NOT IN ('resolved','distributed','canceled','exit')`, [req.params.id]);
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
  const scope = await getPersonScope(req.params.id);
  if (!scope || !(await inScope(req.user, scope.project, scope.client))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const { rows } = await pool.query(`
    SELECT p.*,
      (SELECT MAX(pr.date_distributed) FROM ppe_requests pr WHERE pr.casual_id=$1 AND pr.ppe_item_id=p.id AND pr.date_distributed IS NOT NULL) as last_distributed
    FROM ppe_items p JOIN casual_ppe_assignments cpa ON cpa.ppe_item_id=p.id
    WHERE cpa.casual_id=$1 AND p.is_active=true ORDER BY p.sort_order
  `, [req.params.id]);
  res.json(rows);
});
// Set casual PPE assignments (admin, ehs_manager only)
app.put('/api/casuals/:id/ppe-assignments', auth, async (req, res) => {
  if (!['admin','ehs_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const casualId = req.params.id;
  const scope = await getPersonScope(casualId);
  if (!scope || !(await inScope(req.user, scope.project, scope.client))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const { ppe_item_ids } = req.body;
  const client_db = await pool.connect();
  try {
    await client_db.query('BEGIN');
    const { rows: had } = await client_db.query('SELECT ppe_item_id FROM casual_ppe_assignments WHERE casual_id=$1', [casualId]);
    await client_db.query('DELETE FROM casual_ppe_assignments WHERE casual_id=$1', [casualId]);
    if (ppe_item_ids && ppe_item_ids.length > 0) {
      for (const ppeId of ppe_item_ids) {
        await client_db.query('INSERT INTO casual_ppe_assignments (casual_id, ppe_item_id) VALUES ($1,$2)', [casualId, ppeId]);
      }
    }
    // Casuals are issued PPE the same way, so they are logged the same way.
    await logPpeAssignmentDiff(client_db, {
      casualId, beforeIds: had.map(r => r.ppe_item_id), afterIds: ppe_item_ids || [], user: req.user,
    });
    await client_db.query('UPDATE casuals SET ppe_last_edited_by=$1, ppe_last_edited_at=NOW() WHERE id=$2', [req.user.id, casualId]);
    await client_db.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client_db.query('ROLLBACK');
    console.error('Casual PPE assignment error:', e.message);
    sendError(res, e);
  } finally { client_db.release(); }
});

// Delete employee (admin only)
app.delete('/api/employees/all/purge', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM employees');
    broadcastEmployeesChanged();
    res.json({ message: 'All employees deleted' });
  } catch (e) { sendError(res, e); }
});

app.delete('/api/employees/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Hard delete removes the person entirely — including their change history
    // (otherwise the log rows would linger with a null employee_id).
    await client.query('DELETE FROM employee_change_log WHERE employee_id=$1', [req.params.id]);
    await client.query('DELETE FROM employees WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    broadcastEmployeesChanged();
    res.json({ message: 'Deleted' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23503') return res.status(400).json({ error: 'Cannot delete: employee has existing audits or records. Deactivate them instead.' });
    sendError(res, e);
  } finally { client.release(); }
});

// Delete a casual (admin only)
app.delete('/api/casuals/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM casuals WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Cannot delete: this casual has existing audits, NCR items, or PPE requests. Exit them instead.' });
    sendError(res, e);
  }
});

// PPE Items
app.get('/api/ppe', auth, async (req, res) => {
  // pda_projects: the projects for which this item needs Project Director Approval.
  // ['*'] means all projects; [] means it never needs PDA.
  const { rows } = await pool.query(`
    SELECT pi.*,
      COALESCE((SELECT array_agg(project ORDER BY project) FROM ppe_item_pda_projects WHERE ppe_item_id = pi.id), ARRAY[]::varchar[]) AS pda_projects
    FROM ppe_items pi WHERE is_active=true ORDER BY sort_order`);
  res.json(rows);
});

// Audits
app.get('/api/audits', auth, async (req, res) => {
  try {
    const { search, national_id, resource_type, project, client, status, audited_by, page, pageSize, export: isExport } = req.query;
    // CSV export needs every matching row, not just one page -- bypass the cap for that one case.
    const limit = isExport === 'true' ? 100000 : Math.min(Math.max(parseInt(pageSize) || 25, 1), 100);
    const pageNum = isExport === 'true' ? 1 : Math.max(parseInt(page) || 1, 1);
    const offset = (pageNum - 1) * limit;
    let q = `SELECT a.*,
        COALESCE(e.full_name, c.full_name) as employee_name,
        e.employee_number,
        COALESCE(e.national_id, c.national_id) as national_id,
        COALESCE(e.job_title, c.job_title) as job_title,
        e.department,
        COALESCE(e.project, c.project) as project,
        COALESCE(e.client, c.client) as client,
        COALESCE(e.organization, c.organization) as organization,
        e.resource_type,
        (a.casual_id IS NOT NULL) as is_casual,
        u.full_name as audited_by_name,
        ud.full_name as deleted_by_name,
        COUNT(ai.id) as total_items, COUNT(CASE WHEN ai.condition!='good' THEN 1 END) as issues_count,
        COUNT(*) OVER() as full_count
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
      if (auditProjects.length === 0) { return res.json({ rows: [], total: 0, page: pageNum, pageSize: limit }); }
      params.push(auditProjects); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`;
    }
    const auditClients = await getClientFilter(req.user);
    if (auditClients !== null) {
      if (auditClients.length === 0) { return res.json({ rows: [], total: 0, page: pageNum, pageSize: limit }); }
      params.push(auditClients); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`;
    }
    q += ` GROUP BY a.id,e.full_name,c.full_name,e.employee_number,e.national_id,c.national_id,e.job_title,c.job_title,e.department,e.project,c.project,e.client,c.client,e.organization,c.organization,e.resource_type,u.full_name,a.employee_present,a.casual_id,ud.full_name ORDER BY a.created_at DESC`;
    params.push(limit, offset);
    q += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(q, params);
    const total = rows.length ? parseInt(rows[0].full_count) : 0;
    res.json({ rows, total, page: pageNum, pageSize: limit });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Distinct project/client values for the history filter dropdowns -- needed
// as a separate call now that the main list is paginated and can't be relied
// on to enumerate every value itself.
app.get('/api/audits/filter-options', auth, async (req, res) => {
  try {
    const scopedProjects = await getProjectFilter(req.user);
    const scopedClients = await getClientFilter(req.user);
    const projects = scopedProjects !== null ? scopedProjects : await getAllProjects();
    const clients = scopedClients !== null ? scopedClients : await getAllClients();
    res.json({ projects: projects.sort(), clients: clients.sort() });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/audits/stats', auth, async (req, res) => {
  try {
    const { search, national_id, resource_type, project, client, status, audited_by } = req.query;
    let q = `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE overall_status='compliant') as compliant,
        COUNT(*) FILTER (WHERE overall_status='partial') as partial,
        COUNT(*) FILTER (WHERE overall_status='non_compliant') as non_compliant,
        COUNT(*) FILTER (WHERE date_trunc('month', a.audit_date) = date_trunc('month', NOW())) as this_month,
        COUNT(*) FILTER (WHERE date_trunc('month', a.audit_date) = date_trunc('month', NOW() - INTERVAL '1 month')) as last_month
      FROM audits a
      LEFT JOIN employees e ON e.id=a.employee_id
      LEFT JOIN casuals c ON c.id=a.casual_id
      WHERE a.is_deleted IS NOT TRUE`;
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND COALESCE(e.full_name, c.full_name) ILIKE $${params.length}`; }
    if (national_id) { params.push(`%${national_id}%`); q += ` AND COALESCE(e.national_id, c.national_id) ILIKE $${params.length}`; }
    if (resource_type === 'casual') { q += ` AND a.casual_id IS NOT NULL`; }
    else if (resource_type) { params.push(resource_type); q += ` AND e.resource_type=$${params.length}`; }
    if (project) { params.push(project); q += ` AND COALESCE(e.project, c.project)=$${params.length}`; }
    if (client) { params.push(client); q += ` AND COALESCE(e.client, c.client)=$${params.length}`; }
    if (status) { params.push(status); q += ` AND COALESCE(e.employment_status, c.employment_status)=$${params.length}`; }
    if (audited_by) { params.push(audited_by); q += ` AND a.audited_by=$${params.length}`; }
    const statsProjects = await getProjectFilter(req.user);
    if (statsProjects !== null) {
      if (statsProjects.length === 0) return res.json({ total:0, compliant:0, partial:0, non_compliant:0, this_month:0, last_month:0 });
      params.push(statsProjects); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`;
    }
    const statsClients = await getClientFilter(req.user);
    if (statsClients !== null) {
      if (statsClients.length === 0) return res.json({ total:0, compliant:0, partial:0, non_compliant:0, this_month:0, last_month:0 });
      params.push(statsClients); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`;
    }
    const { rows } = await pool.query(q, params);
    res.json(rows[0]);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/audits/:id', auth, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { delete_reason } = req.body;
  if (!delete_reason || !delete_reason.trim()) {
    return res.status(400).json({ error: 'A reason is required to delete an audit.' });
  }
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
      'UPDATE audits SET is_deleted=TRUE, deleted_at=NOW(), deleted_by=$1, delete_reason=$2 WHERE id=$3',
      [req.user.id, delete_reason.trim(), req.params.id]
    );
    // Cancel all linked PPE requests and NCR items (2 queries total, not 2 per item)
    await client.query(
      `UPDATE ppe_requests SET status='canceled' WHERE ncr_item_id IN (
         SELECT id FROM ncr_items WHERE audit_item_id IN (SELECT id FROM audit_items WHERE audit_id=$1)
       )`,
      [req.params.id]
    );
    // Carry the deletion onto the items it closes, so they explain themselves
    // instead of reading as anonymous cancellations.
    await client.query(
      `UPDATE ncr_items SET status='canceled', cancelled_by=$2, cancelled_at=NOW(),
         cancel_reason=$3, updated_at=NOW()
        WHERE audit_item_id IN (SELECT id FROM audit_items WHERE audit_id=$1)`,
      [req.params.id, req.user.id, 'Audit deleted — ' + delete_reason.trim()]
    );
    await client.query('COMMIT');
    res.json({ message: 'Deleted' });
  } catch(e) { await client.query('ROLLBACK'); sendError(res, e); }
  finally { client.release(); }
});

app.get('/api/audits/leaderboard', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.full_name, u.role, u.profile_picture,
        COUNT(a.id) as total_audits,
        COUNT(a.id) FILTER (WHERE date_trunc('month', a.audit_date) = date_trunc('month', NOW())) as this_month,
        COUNT(a.id) FILTER (WHERE date_trunc('month', a.audit_date) = date_trunc('month', NOW()) - interval '1 month') as last_month
      FROM users u
      LEFT JOIN audits a ON a.audited_by = u.id AND a.is_deleted IS NOT TRUE AND a.employee_present = TRUE
      WHERE u.is_active = true
        AND u.email NOT IN ('admin@egypro.com', 'sync@egypro.com', 'eats-sync@egypro.app')
        AND u.role != 'scm_officer'
      GROUP BY u.id
      HAVING COUNT(a.id) > 0
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
        u2.full_name as last_edited_by_name,
        ud.full_name as deleted_by_name
      FROM audits a
      LEFT JOIN employees e ON e.id=a.employee_id
      LEFT JOIN casuals c ON c.id=a.casual_id
      JOIN users u ON u.id=a.audited_by
      LEFT JOIN locations l ON l.id=a.location_id
      LEFT JOIN users u2 ON u2.id=a.last_edited_by
      LEFT JOIN users ud ON ud.id=a.deleted_by
      WHERE a.id=$1
    `, [req.params.id]);
    if (!audit) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(req.user, audit.project, audit.client))) {
      return res.status(404).json({ error: 'Not found' });
    }
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
  const requiredCommentError = await validateRequiredPpeComments(items);
  if (requiredCommentError) return res.status(400).json({ error: requiredCommentError });
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
            ? `SELECT id FROM ppe_requests WHERE employee_id=$1 AND ppe_item_id=$2 AND status NOT IN ('distributed','resolved','canceled','exit')`
            : `SELECT id FROM ppe_requests WHERE casual_id=$1 AND ppe_item_id=$2 AND status NOT IN ('distributed','resolved','canceled','exit')`,
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
       WHERE ai.audit_id=$1 AND pr.status NOT IN ('pending','canceled','exit')`,
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
  const requiredCommentError = await validateRequiredPpeComments(items);
  if (requiredCommentError) return res.status(400).json({ error: requiredCommentError });

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

    // Items present in the DB but dropped from the submitted list are being
    // removed outright — admin only, since it deletes the line (and any
    // linked NCR/PPE request) everywhere, not just marks it resolved.
    const submittedIds = new Set(items.map(i => i.ppe_item_id));
    const removedItems = existingItems.filter(ai => !submittedIds.has(ai.ppe_item_id));
    if (removedItems.length > 0 && !isAdmin) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only an admin can remove a line item from an audit.' });
    }
    for (const removedAI of removedItems) {
      const { rows: ncrRows } = await client.query(
        'SELECT n.id, pr.id as pr_id FROM ncr_items n LEFT JOIN ppe_requests pr ON pr.ncr_item_id=n.id WHERE n.audit_item_id=$1',
        [removedAI.id]
      );
      for (const ncr of ncrRows) {
        if (ncr.pr_id) await client.query('DELETE FROM ppe_requests WHERE id=$1', [ncr.pr_id]);
        await client.query('DELETE FROM ncr_items WHERE id=$1', [ncr.id]);
      }
      await client.query('DELETE FROM audit_items WHERE id=$1', [removedAI.id]);
    }

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
            if (!isAdmin && ncr.status && !['pending','canceled','exit'].includes(ncr.status)) {
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
            `SELECT id FROM ppe_requests WHERE ${personCol}=$1 AND ppe_item_id=$2 AND status NOT IN ('distributed','resolved','canceled','exit')`,
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
            `SELECT id FROM ppe_requests WHERE ${personCol}=$1 AND ppe_item_id=$2 AND status NOT IN ('distributed','resolved','canceled','exit')`,
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
    sendError(res, e, 400);
  } finally { client.release(); }
});

// NCR
app.get('/api/ncr', auth, async (req, res) => {
  try {
    const { search, project, projects, clients, ppe, period, status, page, pageSize, export: isExport } = req.query;
    // project/client filters are multi-select (CSV); `project` kept for back-compat.
    const projectsCsv = String(projects ?? project ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const clientsCsv = String(clients ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const limit = isExport === 'true' ? 100000 : Math.min(Math.max(parseInt(pageSize) || 25, 1), 100);
    const pageNum = isExport === 'true' ? 1 : Math.max(parseInt(page) || 1, 1);
    const offset = (pageNum - 1) * limit;
    const ncrProjects = await getProjectFilter(req.user);
    const ncrClients = await getClientFilter(req.user);
    if ((ncrProjects !== null && ncrProjects.length === 0) || (ncrClients !== null && ncrClients.length === 0)) {
      return res.json({ rows: [], total: 0, page: pageNum, pageSize: limit });
    }
    let q = `SELECT n.*,
        COALESCE(e.full_name, c.full_name) as employee_name,
        e.employee_number,
        COALESCE(e.national_id, c.national_id) as employee_national_id,
        COALESCE(e.job_title, c.job_title) as job_title,
        COALESCE(e.project, c.project) as project,
        COALESCE(e.client, c.client) as client,
        COALESCE(e.organization, c.organization) as organization,
        (n.casual_id IS NOT NULL) as is_casual,
        p.name as ppe_name,p.category,ppe_needs_pda(p.id, COALESCE(e.project, c.project)) as needs_pda,u.full_name as audited_by_name,
        n.reject_reason, n.rejected_at, n.rejected_stage, ru.full_name as rejected_by_name,
        n.cancel_reason, n.cancelled_at, cu.full_name as cancelled_by_name,
        COALESCE(ai.quantity,1) as quantity,
        (SELECT MAX(pr.date_distributed) FROM ppe_requests pr
         WHERE pr.ppe_item_id=n.ppe_item_id AND pr.date_distributed IS NOT NULL
           AND ((n.employee_id IS NOT NULL AND pr.employee_id=n.employee_id) OR (n.casual_id IS NOT NULL AND pr.casual_id=n.casual_id))
        ) as last_distributed,
        COUNT(*) OVER() as full_count
      FROM ncr_items n
      LEFT JOIN employees e ON e.id=n.employee_id
      LEFT JOIN casuals c ON c.id=n.casual_id
      JOIN ppe_items p ON p.id=n.ppe_item_id
      -- who rejected it, so the list can say more than "Rejected"
      LEFT JOIN users ru ON ru.id=n.rejected_by
      LEFT JOIN users cu ON cu.id=n.cancelled_by
      LEFT JOIN audit_items ai ON ai.id=n.audit_item_id
      LEFT JOIN audits a ON a.id=ai.audit_id
      LEFT JOIN users u ON u.id=a.audited_by WHERE 1=1`;
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND (COALESCE(e.full_name, c.full_name) ILIKE $${params.length} OR COALESCE(e.national_id, c.national_id) ILIKE $${params.length})`; }
    if (ppe) { params.push(ppe); q += ` AND p.name=$${params.length}`; }
    if (projectsCsv.length) { params.push(projectsCsv); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`; }
    if (clientsCsv.length) { params.push(clientsCsv); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`; }
    if (period === 'current') { q += ` AND date_trunc('month', n.created_at) = date_trunc('month', NOW())`; }
    else if (period === 'previous') { q += ` AND date_trunc('month', n.created_at) = date_trunc('month', NOW() - INTERVAL '1 month')`; }
    if (status === 'pda_pending') { q += ` AND n.status='ehs_purchase_requested' AND ppe_needs_pda(p.id, COALESCE(e.project, c.project))`; }
    else if (status === 'ehs_purchase_requested') { q += ` AND n.status='ehs_purchase_requested' AND NOT ppe_needs_pda(p.id, COALESCE(e.project, c.project))`; }
    else if (status === 'distributed_this_month') { q += ` AND n.status IN ('resolved','distributed') AND date_trunc('month', n.updated_at) = date_trunc('month', NOW())`; }
    else if (status) { params.push(status); q += ` AND n.status=$${params.length}`; }
    if (ncrProjects !== null) { params.push(ncrProjects); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`; }
    if (ncrClients !== null) { params.push(ncrClients); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`; }
    q += ` ORDER BY n.created_at DESC`;
    params.push(limit, offset);
    q += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(q, params);
    const total = rows.length ? parseInt(rows[0].full_count) : 0;
    res.json({ rows, total, page: pageNum, pageSize: limit });
  } catch(e) { sendError(res, e); }
});

// Distinct PPE item / project values for the NCR filter dropdowns -- needed
// now that the main list is paginated. No client dropdown exists in the UI
// for this page, so only these two are exposed.
app.get('/api/ncr/filter-options', auth, async (req, res) => {
  try {
    let q = `SELECT
        ARRAY_AGG(DISTINCT p.name) FILTER (WHERE p.name IS NOT NULL) as ppe_names,
        ARRAY_AGG(DISTINCT COALESCE(e.project, c.project)) FILTER (WHERE COALESCE(e.project, c.project) IS NOT NULL) as projects,
        ARRAY_AGG(DISTINCT COALESCE(e.client, c.client)) FILTER (WHERE COALESCE(e.client, c.client) IS NOT NULL) as clients
      FROM ncr_items n
      JOIN ppe_items p ON p.id=n.ppe_item_id
      LEFT JOIN employees e ON e.id=n.employee_id
      LEFT JOIN casuals c ON c.id=n.casual_id
      WHERE 1=1`;
    const params = [];
    const ncrProjects = await getProjectFilter(req.user);
    if (ncrProjects !== null) {
      if (ncrProjects.length === 0) return res.json({ ppe_names: [], projects: [], clients: [] });
      params.push(ncrProjects); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`;
    }
    const ncrClients = await getClientFilter(req.user);
    if (ncrClients !== null) {
      if (ncrClients.length === 0) return res.json({ ppe_names: [], projects: [], clients: [] });
      params.push(ncrClients); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`;
    }
    const { rows } = await pool.query(q, params);
    res.json({
      ppe_names: (rows[0].ppe_names || []).sort(),
      projects: (rows[0].projects || []).sort(),
      clients: (rows[0].clients || []).sort(),
    });
  } catch(e) { sendError(res, e); }
});

// Global (unfiltered) bucket counts for the stat cards -- these were already
// computed from the full unfiltered item list client-side before pagination
// (only clickable as row filters, not reflecting the search/period/ppe/project
// filters), so this keeps that behavior. Only project/client access scoping applies.
app.get('/api/ncr/stats', auth, async (req, res) => {
  try {
    let q = `SELECT
        COUNT(*) FILTER (WHERE n.status NOT IN ('resolved','distributed','canceled','exit')) as total_open,
        COUNT(*) FILTER (WHERE n.status='pending') as pending,
        COUNT(*) FILTER (WHERE n.status='ehs_purchase_requested' AND ppe_needs_pda(p.id, COALESCE(e.project, c.project))) as pending_pm,
        COUNT(*) FILTER (WHERE n.status IN ('resolved','distributed') AND date_trunc('month', n.updated_at) = date_trunc('month', NOW())) as resolved_this_month
      FROM ncr_items n
      JOIN ppe_items p ON p.id = n.ppe_item_id
      LEFT JOIN employees e ON e.id = n.employee_id
      LEFT JOIN casuals c ON c.id = n.casual_id
      WHERE 1=1`;
    const params = [];
    const zero = { total_open: 0, pending: 0, pending_pm: 0, resolved_this_month: 0 };
    const ncrProjects = await getProjectFilter(req.user);
    if (ncrProjects !== null) {
      if (ncrProjects.length === 0) return res.json(zero);
      params.push(ncrProjects); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`;
    }
    const ncrClients = await getClientFilter(req.user);
    if (ncrClients !== null) {
      if (ncrClients.length === 0) return res.json(zero);
      params.push(ncrClients); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`;
    }
    const { rows } = await pool.query(q, params);
    const r = rows[0];
    res.json({ total_open: parseInt(r.total_open)||0, pending: parseInt(r.pending)||0, pending_pm: parseInt(r.pending_pm)||0, resolved_this_month: parseInt(r.resolved_this_month)||0 });
  } catch(e) { sendError(res, e); }
});

app.put('/api/ncr/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const allowedRoles = ['admin', 'ehs_manager', 'project_director'];
  if (!allowedRoles.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  if (req.user.role === 'project_director' && !['pda_approved', 'rejected'].includes(status)) {
    return res.status(403).json({ error: 'Project Director can only approve or reject at the PM stage' });
  }
  const { rows: [ncrPerson] } = await pool.query('SELECT COALESCE(employee_id, casual_id) as person_id FROM ncr_items WHERE id=$1', [req.params.id]);
  if (!ncrPerson) return res.status(404).json({ error: 'NCR item not found' });
  const ncrScope = await getPersonScope(ncrPerson.person_id);
  if (!ncrScope || !(await inScope(req.user, ncrScope.project, ncrScope.client))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      `SELECT n.status, pr.id as ppe_request_id, pr.pda_approved_date, ppe_needs_pda(pi.id, $2) as needs_pda
       FROM ncr_items n
       LEFT JOIN ppe_requests pr ON pr.ncr_item_id = n.id
       LEFT JOIN ppe_items pi ON pi.id = n.ppe_item_id
       WHERE n.id = $1`,
      [req.params.id, ncrScope.project || null]
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
      && ['scm_ordered', 'warehouse_available', 'warehouse_unavailable', 'distributed'].includes(status);
    if (skippingPda) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This PPE item requires Project Director Approval before it can move to SCM Ordered' });
    }
    // Reject (Safety or PM): close the NCR out with a mandatory reason. Stored as
    // 'canceled' (already excluded from every open/count query) but distinguished — and
    // shown as "Rejected" — via reject_reason. The linked PPE/Tool request is cancelled too.
    if (status === 'rejected') {
      const reason = (req.body.reason || '').trim();
      if (!reason) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A rejection reason is required' }); }
      // Stage rules: Safety (EHS) rejects only Flagged items; PM (PD) rejects only
      // Pending PM items (needs PDA, at EHS Purchase Requested). Admin may do either.
      const isFlagged = current.status === 'pending';
      const isPendingPm = current.needs_pda && current.status === 'ehs_purchase_requested';
      const canReject = req.user.role === 'ehs_manager' ? isFlagged
        : req.user.role === 'project_director' ? isPendingPm
        : (isFlagged || isPendingPm);
      if (!canReject) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: req.user.role === 'ehs_manager' ? 'Safety can only reject Flagged items.'
          : req.user.role === 'project_director' ? 'PM can only reject Pending PM items.'
          : 'This item is not at a stage that can be rejected.' });
      }
      // isFlagged / isPendingPm above already decided which gate this is, so
      // store it rather than leaving it to be inferred later.
      const stage = isFlagged ? 'safety' : 'pm';
      const { rows: [rej] } = await client.query(
        `UPDATE ncr_items SET status='canceled', reject_reason=$1, rejected_by=$2, rejected_at=NOW(),
           rejected_stage=$3, resolved_at=NULL, updated_at=NOW() WHERE id=$4 RETURNING *`,
        [reason, req.user.id, stage, req.params.id]
      );
      await client.query(`UPDATE ppe_requests SET status='canceled', updated_at=NOW() WHERE ncr_item_id=$1`, [req.params.id]);
      await client.query('COMMIT');
      return res.json(rej);
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
  } catch(e) { await client.query('ROLLBACK'); sendError(res, e); }
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
  } catch(e) { sendError(res, e); }
});

// Delete NCR item (admin only)
app.delete('/api/ncr/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM ppe_requests WHERE ncr_item_id=$1', [req.params.id]);
    await pool.query('DELETE FROM ncr_items WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch(e) { sendError(res, e); }
});

// PPE Request Tracker

app.delete('/api/ppe/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM ppe_items WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Cannot delete: this PPE item is referenced in existing audits. Set it to Inactive instead.' });
    sendError(res, e);
  }
});

// Normalise the pda_projects the client sends: an array of project names, or ['*'] for
// all projects. '*' wins (collapses to just ['*']); blanks/dupes dropped.
const normalizePdaProjects = (input) => {
  const arr = Array.isArray(input) ? input.map(p => String(p == null ? '' : p).trim()).filter(Boolean) : [];
  if (arr.includes('*')) return ['*'];
  return [...new Set(arr)];
};
// Replace an item's PDA-project rows inside the given client/transaction.
const writePdaProjects = async (client, itemId, projects) => {
  await client.query('DELETE FROM ppe_item_pda_projects WHERE ppe_item_id=$1', [itemId]);
  for (const project of projects) {
    await client.query('INSERT INTO ppe_item_pda_projects (ppe_item_id, project) VALUES ($1,$2) ON CONFLICT DO NOTHING', [itemId, project]);
  }
};

app.post('/api/ppe', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { name, category, has_size, size_type, sort_order } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'name and category required' });
  const pdaProjects = normalizePdaProjects(req.body.pda_projects);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      // needs_pda kept in sync as a coarse "has any PDA rule" flag for legacy/display.
      'INSERT INTO ppe_items (name, category, has_size, size_type, sort_order, is_active, needs_pda) VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING *',
      [name, category, has_size || false, size_type || null, sort_order || 99, pdaProjects.length > 0]
    );
    await writePdaProjects(client, rows[0].id, pdaProjects);
    await client.query('COMMIT');
    res.json({ ...rows[0], pda_projects: pdaProjects });
  } catch (e) { await client.query('ROLLBACK'); sendError(res, e); }
  finally { client.release(); }
});

app.put('/api/ppe/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { name, category, has_size, size_type, sort_order, is_active } = req.body;
  const pdaProjects = normalizePdaProjects(req.body.pda_projects);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE ppe_items SET name=$1, category=$2, has_size=$3, size_type=$4, sort_order=$5, is_active=$6, needs_pda=$7 WHERE id=$8 RETURNING *',
      [name, category, has_size, size_type || null, sort_order, is_active, pdaProjects.length > 0, req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    await writePdaProjects(client, req.params.id, pdaProjects);
    await client.query('COMMIT');
    res.json({ ...rows[0], pda_projects: pdaProjects });
  } catch (e) { await client.query('ROLLBACK'); sendError(res, e); }
  finally { client.release(); }
});

app.get('/api/ppe-requests', auth, async (req, res) => {
  try {
    const { status, search, national_id, job_title, resource_type, department, po_number, warehouse, location, ppe, period, page, pageSize, export: isExport } = req.query;
    const projects = req.query.projects ? req.query.projects.split(',').filter(Boolean) : [];
    const clients = req.query.clients ? req.query.clients.split(',').filter(Boolean) : [];

    let q = `SELECT r.*,
        COALESCE(e.full_name, c.full_name) as employee_name,
        e.employee_number,
        COALESCE(e.national_id, c.national_id) as employee_national_id,
        COALESCE(e.employment_status, c.employment_status) as employment_status,
        COALESCE(e.job_title, c.job_title) as job_title,
        COALESCE(e.project, c.project) as project,
        COALESCE(e.client, c.client) as client,
        (r.casual_id IS NOT NULL) as is_casual,
        p.name as ppe_name, p.category, ppe_needs_pda(p.id, COALESCE(e.project, c.project)) as needs_pda,
        n.comment,
        u0.full_name as flagged_by_name,
        u1.full_name as purchase_requested_by_name,
        u2.full_name as ordered_by_name,
        u3.full_name as available_by_name,
        u4.full_name as distributed_by_name,
        u5.full_name as pda_approved_by_name,
        l.name as location_name,
        COALESCE(ai.quantity, 1) as quantity,
        (SELECT MAX(pr2.date_distributed) FROM ppe_requests pr2
         WHERE pr2.ppe_item_id=r.ppe_item_id AND pr2.date_distributed IS NOT NULL AND pr2.id != r.id
           AND ((r.employee_id IS NOT NULL AND pr2.employee_id=r.employee_id) OR (r.casual_id IS NOT NULL AND pr2.casual_id=r.casual_id))
        ) as last_distributed,
        COUNT(*) OVER() as full_count
      FROM ppe_requests r
      LEFT JOIN employees e ON e.id=r.employee_id
      LEFT JOIN casuals c ON c.id=r.casual_id
      JOIN ppe_items p ON p.id=r.ppe_item_id
      LEFT JOIN ncr_items n ON n.id=r.ncr_item_id
      LEFT JOIN audit_items ai ON ai.id=n.audit_item_id
      LEFT JOIN audits a ON a.id=ai.audit_id
      LEFT JOIN locations l ON l.id=a.location_id
      LEFT JOIN users u0 ON u0.id=r.flagged_by
      LEFT JOIN users u1 ON u1.id=r.purchase_requested_by
      LEFT JOIN users u2 ON u2.id=r.ordered_by
      LEFT JOIN users u3 ON u3.id=r.available_by
      LEFT JOIN users u4 ON u4.id=r.distributed_by
      LEFT JOIN users u5 ON u5.id=r.pda_approved_by
      WHERE 1=1`;
    const params = [];

    if (status === 'pda_pending') { q += ` AND r.status='ehs_purchase_requested' AND ppe_needs_pda(p.id, COALESCE(e.project, c.project))`; }
    else if (status === 'pending_scm') { q += ` AND (r.status='pda_approved' OR (r.status='ehs_purchase_requested' AND NOT (ppe_needs_pda(p.id, COALESCE(e.project, c.project)) AND r.pda_approved_date IS NULL)))`; }
    else if (status === 'ehs_purchase_requested') { q += ` AND r.status='ehs_purchase_requested' AND NOT (ppe_needs_pda(p.id, COALESCE(e.project, c.project)) AND r.pda_approved_date IS NULL)`; }
    else if (status) { params.push(status); q += ` AND r.status=$${params.length}`; }

    // Mirrors the tracker's Warehouse column logic: real pipeline outcomes
    // (available/distributed) win; otherwise the pre-check flag or a legacy
    // warehouse_unavailable status counts as unavailable; everything else
    // hasn't been checked yet. Canceled/exited requests are excluded outright
    // -- they're dead requests, not pending warehouse work.
    if (warehouse) { q += ` AND r.status NOT IN ('canceled', 'exit')`; }
    if (warehouse === 'available') { q += ` AND r.status IN ('warehouse_available', 'distributed')`; }
    else if (warehouse === 'unavailable') { q += ` AND r.status NOT IN ('warehouse_available', 'distributed') AND (r.status = 'warehouse_unavailable' OR r.warehouse_unavailable_flagged_at IS NOT NULL)`; }
    else if (warehouse === 'not_checked') { q += ` AND r.status NOT IN ('warehouse_available', 'distributed', 'warehouse_unavailable') AND r.warehouse_unavailable_flagged_at IS NULL`; }

    if (search) { params.push(`%${search}%`); q += ` AND COALESCE(e.full_name, c.full_name) ILIKE $${params.length}`; }
    if (national_id) { params.push(`%${national_id}%`); q += ` AND COALESCE(e.national_id, c.national_id) ILIKE $${params.length}`; }
    if (job_title) { params.push(`%${job_title}%`); q += ` AND COALESCE(e.job_title, c.job_title) ILIKE $${params.length}`; }
    if (po_number) { params.push(`%${po_number}%`); q += ` AND r.po_number ILIKE $${params.length}`; }
    if (location) { params.push(location); q += ` AND l.name=$${params.length}`; }
    if (ppe) { params.push(ppe); q += ` AND p.name=$${params.length}`; }
    // Casuals have no resource_type of their own -- 'casual' just means the
    // request is for a casual worker at all, same convention as Audit History.
    if (resource_type === 'casual') { q += ` AND r.casual_id IS NOT NULL`; }
    else if (resource_type) { params.push(resource_type); q += ` AND e.resource_type=$${params.length}`; }
    // Only employees carry a department; casual-linked requests never match.
    if (department) { params.push(department); q += ` AND e.department=$${params.length}`; }
    if (projects.length) { params.push(projects); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`; }
    if (clients.length) { params.push(clients); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`; }
    if (period === 'current') { q += ` AND date_trunc('month', r.date_flagged) = date_trunc('month', NOW())`; }
    else if (period === 'previous') { q += ` AND date_trunc('month', r.date_flagged) = date_trunc('month', NOW() - INTERVAL '1 month')`; }

    const ppeProjects = await getProjectFilter(req.user);
    if (ppeProjects !== null) {
      if (ppeProjects.length === 0) return res.json({ rows: [], total: 0, page: 1, pageSize: 0 });
      params.push(ppeProjects); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`;
    }
    const ppeClients = await getClientFilter(req.user);
    if (ppeClients !== null) {
      if (ppeClients.length === 0) return res.json({ rows: [], total: 0, page: 1, pageSize: 0 });
      params.push(ppeClients); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`;
    }

    q += ` ORDER BY
        CASE r.status
          WHEN 'pending' THEN 1
          WHEN 'ehs_purchase_requested' THEN 2
          WHEN 'scm_ordered' THEN 3
          WHEN 'warehouse_available' THEN 4
          WHEN 'warehouse_unavailable' THEN 4
          WHEN 'distributed' THEN 5
          WHEN 'canceled' THEN 6
          WHEN 'exit' THEN 6
          ELSE 7
        END,
        r.date_flagged DESC`;

    // Pagination only applies to the flat/ungrouped view -- grouped views and
    // CSV export need every matching row to compute correct subtotals/exports,
    // so they simply omit `page` and get everything back.
    let limit = null, offset = 0, pageNum = 1;
    if (isExport !== 'true' && page) {
      limit = Math.min(Math.max(parseInt(pageSize) || 25, 1), 100);
      pageNum = Math.max(parseInt(page) || 1, 1);
      offset = (pageNum - 1) * limit;
      params.push(limit, offset);
      q += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }

    const { rows } = await pool.query(q, params);
    const total = rows.length ? parseInt(rows[0].full_count) : 0;
    res.json({ rows, total, page: pageNum, pageSize: limit || total });
  } catch(e) { sendError(res, e); }
});

// Global (unfiltered) bucket counts + oldest-item age for the stat cards --
// intentionally ignores whatever filters are active in the UI so the cards
// always reflect the true overall pending counts, not the current search.
app.get('/api/ppe-requests/stats', auth, async (req, res) => {
  try {
    let q = `SELECT
        COUNT(*) FILTER (WHERE r.status='pending') as pending_ehs,
        MIN(r.date_flagged) FILTER (WHERE r.status='pending') as pending_ehs_oldest,
        COUNT(*) FILTER (WHERE r.status='ehs_purchase_requested' AND ppe_needs_pda(p.id, COALESCE(e.project, c.project))) as pending_pm,
        MIN(r.date_purchase_requested) FILTER (WHERE r.status='ehs_purchase_requested' AND ppe_needs_pda(p.id, COALESCE(e.project, c.project))) as pending_pm_oldest,
        COUNT(*) FILTER (WHERE r.status='pda_approved' OR (r.status='ehs_purchase_requested' AND NOT (ppe_needs_pda(p.id, COALESCE(e.project, c.project)) AND r.pda_approved_date IS NULL))) as pending_scm,
        MIN(CASE WHEN ppe_needs_pda(p.id, COALESCE(e.project, c.project)) THEN r.pda_approved_date ELSE r.date_purchase_requested END)
          FILTER (WHERE r.status='pda_approved' OR (r.status='ehs_purchase_requested' AND NOT (ppe_needs_pda(p.id, COALESCE(e.project, c.project)) AND r.pda_approved_date IS NULL))) as pending_scm_oldest,
        COUNT(*) FILTER (WHERE r.status='scm_ordered') as pending_suppliers,
        MIN(r.date_ordered) FILTER (WHERE r.status='scm_ordered') as pending_suppliers_oldest,
        COUNT(*) FILTER (WHERE r.status='warehouse_available') as pending_projects,
        MIN(r.date_available) FILTER (WHERE r.status='warehouse_available') as pending_projects_oldest
      FROM ppe_requests r
      JOIN ppe_items p ON p.id=r.ppe_item_id
      LEFT JOIN employees e ON e.id=r.employee_id
      LEFT JOIN casuals c ON c.id=r.casual_id
      WHERE 1=1`;
    const params = [];
    const zero = { pending_ehs:0, pending_ehs_oldest:null, pending_pm:0, pending_pm_oldest:null, pending_scm:0, pending_scm_oldest:null, pending_suppliers:0, pending_suppliers_oldest:null, pending_projects:0, pending_projects_oldest:null };
    const ppeProjects = await getProjectFilter(req.user);
    if (ppeProjects !== null) {
      if (ppeProjects.length === 0) return res.json(zero);
      params.push(ppeProjects); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`;
    }
    const ppeClients = await getClientFilter(req.user);
    if (ppeClients !== null) {
      if (ppeClients.length === 0) return res.json(zero);
      params.push(ppeClients); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`;
    }
    const { rows } = await pool.query(q, params);
    const toDays = (d) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null;
    const r = rows[0];
    res.json({
      pending_ehs: parseInt(r.pending_ehs), pending_ehs_oldest: toDays(r.pending_ehs_oldest),
      pending_pm: parseInt(r.pending_pm), pending_pm_oldest: toDays(r.pending_pm_oldest),
      pending_scm: parseInt(r.pending_scm), pending_scm_oldest: toDays(r.pending_scm_oldest),
      pending_suppliers: parseInt(r.pending_suppliers), pending_suppliers_oldest: toDays(r.pending_suppliers_oldest),
      pending_projects: parseInt(r.pending_projects), pending_projects_oldest: toDays(r.pending_projects_oldest),
    });
  } catch(e) { sendError(res, e); }
});

// Distinct PPE item / project / client values actually present in ppe_requests,
// for the filter dropdowns -- needed now that the main list is paginated.
app.get('/api/ppe-requests/filter-options', auth, async (req, res) => {
  try {
    let q = `SELECT
        ARRAY_AGG(DISTINCT p.name) FILTER (WHERE p.name IS NOT NULL) as ppe_names,
        ARRAY_AGG(DISTINCT COALESCE(e.project, c.project)) FILTER (WHERE COALESCE(e.project, c.project) IS NOT NULL) as projects,
        ARRAY_AGG(DISTINCT COALESCE(e.client, c.client)) FILTER (WHERE COALESCE(e.client, c.client) IS NOT NULL) as clients,
        ARRAY_AGG(DISTINCT e.department) FILTER (WHERE e.department IS NOT NULL) as departments
      FROM ppe_requests r
      JOIN ppe_items p ON p.id=r.ppe_item_id
      LEFT JOIN employees e ON e.id=r.employee_id
      LEFT JOIN casuals c ON c.id=r.casual_id
      WHERE 1=1`;
    const params = [];
    const zero = { ppe_names: [], projects: [], clients: [], departments: [] };
    const ppeProjects = await getProjectFilter(req.user);
    if (ppeProjects !== null) {
      if (ppeProjects.length === 0) return res.json(zero);
      params.push(ppeProjects); q += ` AND COALESCE(e.project, c.project) = ANY($${params.length})`;
    }
    const ppeClients = await getClientFilter(req.user);
    if (ppeClients !== null) {
      if (ppeClients.length === 0) return res.json(zero);
      params.push(ppeClients); q += ` AND COALESCE(e.client, c.client) = ANY($${params.length})`;
    }
    const { rows } = await pool.query(q, params);
    res.json({
      ppe_names: (rows[0].ppe_names || []).sort(),
      projects: (rows[0].projects || []).sort(),
      clients: (rows[0].clients || []).sort(),
      departments: (rows[0].departments || []).sort(),
    });
  } catch(e) { sendError(res, e); }
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
  const { rows: [reqPerson] } = await pool.query('SELECT COALESCE(employee_id, casual_id) as person_id FROM ppe_requests WHERE id=$1', [req.params.id]);
  if (!reqPerson) return res.status(404).json({ error: 'PPE request not found' });
  const reqScope = await getPersonScope(reqPerson.person_id);
  if (!reqScope || !(await inScope(req.user, reqScope.project, reqScope.client))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      'SELECT pr.status, pr.pda_approved_date, ppe_needs_pda(pi.id, $2) as needs_pda FROM ppe_requests pr JOIN ppe_items pi ON pr.ppe_item_id = pi.id WHERE pr.id = $1',
      [req.params.id, reqScope.project || null]
    );
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'PPE request not found' });
    }
    const skippingPda = current.needs_pda
      && current.status === 'ehs_purchase_requested'
      && !current.pda_approved_date
      && ['scm_ordered', 'warehouse_available', 'warehouse_unavailable', 'distributed'].includes(status);
    if (skippingPda) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This PPE item requires Project Director Approval before it can move to SCM Ordered' });
    }
    if (req.user.role === 'project_director' && current.status !== 'ehs_purchase_requested') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Can only approve items currently at EHS Purchase Requested' });
    }
    // Warehouse Unavailable here is a pre-check flag, not a real pipeline
    // transition -- it only applies before SCM has ordered the item, and
    // deliberately leaves `status` (and the Status column) untouched.
    if (status === 'warehouse_unavailable') {
      if (!['ehs_purchase_requested', 'pda_approved'].includes(current.status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Warehouse Unavailable can only be flagged on items at EHS Purchase Requested or Approved (PM)' });
      }
      const { rows: [flagged] } = await client.query(
        'UPDATE ppe_requests SET warehouse_unavailable_flagged_at=NOW(), warehouse_unavailable_flagged_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
        [req.user.id, req.params.id]
      );
      await client.query('COMMIT');
      return res.json(flagged);
    }
    let extraFields = '';
    let extraParams = [status, req.params.id];
    if (status === 'ehs_purchase_requested') extraFields = ', date_purchase_requested=NOW(), purchase_requested_by=$3';
    if (status === 'pda_approved') extraFields = ', pda_approved_date=NOW(), pda_approved_by=$3';
    if (status === 'scm_ordered') { extraParams.push(req.user.id); extraFields = ', date_ordered=NOW(), ordered_by=$3, po_number=$4'; extraParams.push(req.body.po_number || null); }
    // warehouse_unavailable never reaches here (handled above), so this only
    // ever fires for the genuine "found it" outcome.
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
  } catch(e) { await client.query('ROLLBACK'); sendError(res, e); }
  finally { client.release(); }
});

// Fix missing dates on existing PPE requests (admin only)
app.post('/api/admin/fix-ppe-dates', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query("UPDATE ppe_requests SET date_purchase_requested=updated_at WHERE status='ehs_purchase_requested' AND date_purchase_requested IS NULL");
    res.json({ message: 'Dates fixed' });
  } catch(e) { sendError(res, e); }
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
  } catch(e) { sendError(res, e); }
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

// ── Training (ETMS migration, Phase 1) ─────────────────────
// Roles mirror ETMS: EHS managers raise training requests; HR record the
// outcome later (that screen is not built yet).
const TRAINING_REQUEST_ROLES = ['admin', 'ehs_manager'];
// HR record the outcome of a request (complete / pending / schedule / not eligible).
const TRAINING_UPDATE_ROLES = ['admin', 'hr'];

app.get('/api/training-courses', auth, async (req, res) => {
  try {
    const cols = 'id, name, validity_months, no_expiry, is_credential, needs_certificate, is_sensitive, icon';
    // ?manage=1 → only the courses this user may manage on the Update page.
    // Admin manages all; a non-admin sees only the courses granted to them
    // (an empty grant = none, so they must be assigned in Admin first).
    if (req.query.manage && req.user.role !== 'admin') {
      const { rows } = await pool.query(
        `SELECT ${cols} FROM training_courses
          WHERE is_active = TRUE
            AND id IN (SELECT unnest(COALESCE(training_course_access, '{}'::uuid[])) FROM users WHERE id = $1)
          ORDER BY sort_order ASC, name ASC`, [req.user.id]);
      return res.json(rows);
    }
    const { rows } = await pool.query(
      `SELECT ${cols} FROM training_courses WHERE is_active = TRUE ORDER BY sort_order ASC, name ASC`
    );
    res.json(rows);
  } catch(e) { sendError(res, e); }
});

// Whether a user may record/update outcomes for a course. Admin → always.
// Others → the course must be in their (live, DB-read) training_course_access,
// so an admin's change takes effect without the HR re-logging in.
const canManageCourse = async (user, courseId) => {
  if (user.role === 'admin') return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM users WHERE id = $1 AND $2::uuid = ANY(COALESCE(training_course_access,'{}'))`,
    [user.id, courseId]);
  return rows.length > 0;
};

// Admin: set exactly which HR users manage a given course (many-to-many, stored
// per user in training_course_access).
app.put('/api/training-courses/:id/managers', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const courseId = req.params.id;
  const userIds = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
  try {
    const c = await pool.query('SELECT id FROM training_courses WHERE id = $1', [courseId]);
    if (!c.rows.length) return res.status(404).json({ error: 'Training not found' });
    // Drop the course from any HR who is no longer selected.
    await pool.query(
      `UPDATE users SET training_course_access = array_remove(training_course_access, $1::uuid), updated_at = NOW()
        WHERE role = 'hr' AND $1::uuid = ANY(training_course_access) AND NOT (id = ANY($2::uuid[]))`,
      [courseId, userIds]);
    // Grant it to the selected HR who don't have it yet.
    if (userIds.length) {
      await pool.query(
        `UPDATE users SET training_course_access = array_append(COALESCE(training_course_access,'{}'), $1::uuid), updated_at = NOW()
          WHERE role = 'hr' AND id = ANY($2::uuid[]) AND NOT ($1::uuid = ANY(COALESCE(training_course_access,'{}')))`,
        [courseId, userIds]);
    }
    res.json({ ok: true });
  } catch(e) { sendError(res, e); }
});

// ── HR task access (Add Employee / Edit Employee) — Admin → HR Tasks Managers ──
const HR_TASKS = ['add_employee', 'edit_employee'];
// Admins always have every task; HR needs it in their (live) hr_task_access.
const hasHrTask = async (user, task) => {
  if (user.role === 'admin') return true;
  if (user.role !== 'hr') return false;
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE id=$1 AND $2 = ANY(COALESCE(hr_task_access,'{}'))`, [user.id, task]);
  return rows.length > 0;
};
app.put('/api/hr-tasks/:task/managers', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const task = req.params.task;
  if (!HR_TASKS.includes(task)) return res.status(400).json({ error: 'Unknown task' });
  const userIds = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
  try {
    await pool.query(
      `UPDATE users SET hr_task_access = array_remove(hr_task_access, $1), updated_at = NOW()
        WHERE role='hr' AND $1 = ANY(hr_task_access) AND NOT (id = ANY($2::uuid[]))`,
      [task, userIds]);
    if (userIds.length) {
      await pool.query(
        `UPDATE users SET hr_task_access = array_append(COALESCE(hr_task_access,'{}'), $1), updated_at = NOW()
          WHERE role='hr' AND id = ANY($2::uuid[]) AND NOT ($1 = ANY(COALESCE(hr_task_access,'{}')))`,
        [task, userIds]);
    }
    res.json({ ok: true });
  } catch(e) { sendError(res, e); }
});

// ── Outsource access (manage Services / Vehicle Supplier) — Admin → Outsource Managers ──
// Each grant = add + edit + exit for that outsource subtype. Admins always have both.
// Assignable to the two outsource-facing roles: fleet and supervisor.
const OUTSOURCE_SUBTYPES = ['services', 'vehicle_supplier'];
const OUTSOURCE_MANAGER_ROLES = ['fleet', 'supervisor'];
const hasOutsourceAccess = async (user, subtype) => {
  if (user.role === 'admin') return true;
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE id=$1 AND $2 = ANY(COALESCE(outsource_access,'{}'))`, [user.id, subtype]);
  return rows.length > 0;
};
// The outsource subtype ('services' | 'vehicle_supplier' | null) an org maps to.
const outsourceSubtypeOfOrg = async (org) => {
  if (!org || !String(org).trim()) return null;
  const { rows } = await pool.query(`SELECT type FROM outsource_entities WHERE LOWER(TRIM(name))=LOWER(TRIM($1)) LIMIT 1`, [org]);
  return rows.length ? rows[0].type : null;
};
// Can this user add/edit/exit the given employee row? HR (with the task) can manage
// anyone; an outsource subtype-manager can manage only outsource of their subtype.
const canManageEmployee = async (user, emp, hrTask) => {
  if (await hasHrTask(user, hrTask)) return true;
  if (emp && emp.resource_type === 'outsource') {
    const sub = await outsourceSubtypeOfOrg(emp.organization);
    if (sub && await hasOutsourceAccess(user, sub)) return true;
  }
  return false;
};
app.put('/api/outsource-tasks/:subtype/managers', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const subtype = req.params.subtype;
  if (!OUTSOURCE_SUBTYPES.includes(subtype)) return res.status(400).json({ error: 'Unknown subtype' });
  const userIds = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
  try {
    await pool.query(
      `UPDATE users SET outsource_access = array_remove(outsource_access, $1), updated_at = NOW()
        WHERE role = ANY($3::text[]) AND $1 = ANY(outsource_access) AND NOT (id = ANY($2::uuid[]))`,
      [subtype, userIds, OUTSOURCE_MANAGER_ROLES]);
    if (userIds.length) {
      await pool.query(
        `UPDATE users SET outsource_access = array_append(COALESCE(outsource_access,'{}'), $1), updated_at = NOW()
          WHERE role = ANY($3::text[]) AND id = ANY($2::uuid[]) AND NOT ($1 = ANY(COALESCE(outsource_access,'{}')))`,
        [subtype, userIds, OUTSOURCE_MANAGER_ROLES]);
    }
    res.json({ ok: true });
  } catch(e) { sendError(res, e); }
});

// ── App settings (simple key/value, admin-toggleable) ───────
const ALLOWED_SETTINGS = ['require_training_certificate'];
const getBoolSetting = async (key) => {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value === 'true';
};
const readAllSettings = async () => {
  const { rows } = await pool.query('SELECT key, value FROM app_settings');
  const out = {};
  rows.forEach(r => { out[r.key] = r.value === 'true'; });
  return out;
};
app.get('/api/app-settings', auth, async (req, res) => {
  try { res.json(await readAllSettings()); } catch(e) { sendError(res, e); }
});
app.put('/api/app-settings', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!ALLOWED_SETTINGS.includes(k)) continue;
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [k, (v === true || v === 'true') ? 'true' : 'false']);
    }
    res.json(await readAllSettings());
  } catch(e) { sendError(res, e); }
});

// ── Admin: manage training course types ─────────────────────
// Full list incl. inactive, and create/edit/delete — for the Admin panel.
app.get('/api/training-courses/all', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows } = await pool.query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM training_records r WHERE r.course_id = c.id AND r.is_deleted IS NOT TRUE) AS record_count
       FROM training_courses c ORDER BY c.sort_order ASC, c.name ASC`
    );
    res.json(rows);
  } catch(e) { sendError(res, e); }
});

app.post('/api/training-courses', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, validity_months, no_expiry, needs_certificate, is_credential, is_sensitive, sort_order, icon } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Training name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO training_courses (name, validity_months, no_expiry, needs_certificate, is_credential, is_sensitive, sort_order, icon)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name.trim(), (no_expiry ? null : (validity_months || null)), !!no_expiry, needs_certificate !== false, is_credential || false, is_sensitive || false, sort_order || 99, icon || null]
    );
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'A training with this name already exists' });
    sendError(res, e);
  }
});

// Expects the full course object (like PUT /api/ppe/:id) -- every field is
// written, so the Admin form and the activate/deactivate toggle both send the
// whole record. This is what lets validity_months be cleared back to NULL.
app.put('/api/training-courses/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, validity_months, no_expiry, needs_certificate, is_credential, is_sensitive, is_active, sort_order, icon } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Training name is required' });
  try {
    const { rows } = await pool.query(
      `UPDATE training_courses SET
         name=$1, validity_months=$2, no_expiry=$3, needs_certificate=$4, is_credential=$5,
         is_sensitive=$6, is_active=$7, sort_order=$8, icon=$9
       WHERE id=$10 RETURNING *`,
      [name.trim(), (no_expiry ? null : (validity_months || null)), !!no_expiry, needs_certificate !== false,
       is_credential || false, is_sensitive || false, is_active !== false,
       sort_order || 99, icon || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'A training with this name already exists' });
    sendError(res, e);
  }
});

app.delete('/api/training-courses/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    // Refuse to delete a course that has training records -- deactivate instead,
    // so historical records keep a valid course reference.
    const { rows: [used] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM training_records WHERE course_id = $1', [req.params.id]
    );
    if (used.n > 0) {
      return res.status(400).json({ error: `Cannot delete: ${used.n} training record(s) use this type. Deactivate it instead.` });
    }
    const { rowCount } = await pool.query('DELETE FROM training_courses WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch(e) { sendError(res, e); }
});

// ── Pending reasons (admin-managed list for the Update screen) ──
app.get('/api/training-pending-reasons', auth, async (req, res) => {
  try {
    // Active-only for the dropdown; admins get everything via ?all=1 for the panel.
    const all = req.query.all === '1' && req.user.role === 'admin';
    const { rows } = await pool.query(
      `SELECT id, label, is_active, sort_order FROM training_pending_reasons
       ${all ? '' : 'WHERE is_active = TRUE'} ORDER BY sort_order ASC, label ASC`
    );
    res.json(rows);
  } catch(e) { sendError(res, e); }
});

app.post('/api/training-pending-reasons', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { label, sort_order } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'Reason is required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO training_pending_reasons (label, sort_order) VALUES ($1,$2) RETURNING *',
      [label.trim(), sort_order || 99]
    );
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That reason already exists' });
    sendError(res, e);
  }
});

app.put('/api/training-pending-reasons/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { label, is_active, sort_order } = req.body;
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'Reason is required' });
  try {
    const { rows } = await pool.query(
      'UPDATE training_pending_reasons SET label=$1, is_active=$2, sort_order=$3 WHERE id=$4 RETURNING *',
      [label.trim(), is_active !== false, sort_order || 99, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That reason already exists' });
    sendError(res, e);
  }
});

app.delete('/api/training-pending-reasons/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    // pending_reason is stored as free text on the record, so deleting a reason
    // never orphans history -- a hard delete is safe.
    const { rowCount } = await pool.query('DELETE FROM training_pending_reasons WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch(e) { sendError(res, e); }
});

// ── Admin-managed option lists: Department / Project / Client ────────────────
const ORG_LIST_TYPES = ['department', 'project', 'client'];
// Any authenticated user reads them (to fill the Add/Edit dropdowns). No `type`
// → all active items across every list; admins pass ?all=1 for the panel.
app.get('/api/org-lists', auth, async (req, res) => {
  try {
    const { type } = req.query;
    const all = req.query.all === '1' && req.user.role === 'admin';
    const params = [];
    let where = all ? '1=1' : 'is_active = TRUE';
    if (type) { params.push(type); where += ` AND list_type = $${params.length}`; }
    const { rows } = await pool.query(`SELECT id, list_type, name, is_active, sort_order FROM org_lists WHERE ${where} ORDER BY list_type ASC, sort_order ASC, name ASC`, params);
    res.json(rows);
  } catch(e) { sendError(res, e); }
});
app.post('/api/org-lists', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { list_type, name, sort_order } = req.body;
  if (!ORG_LIST_TYPES.includes(list_type)) return res.status(400).json({ error: 'Invalid list type' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const { rows } = await pool.query('INSERT INTO org_lists (list_type, name, sort_order) VALUES ($1,$2,$3) RETURNING *', [list_type, name.trim(), sort_order || 0]);
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That value already exists in this list' });
    sendError(res, e);
  }
});
app.put('/api/org-lists/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, is_active, sort_order } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const { rows } = await pool.query('UPDATE org_lists SET name=$1, is_active=$2, sort_order=$3 WHERE id=$4 RETURNING *', [name.trim(), is_active !== false, sort_order || 0, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That value already exists in this list' });
    sendError(res, e);
  }
});
app.delete('/api/org-lists/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    // Values live as free text on employee rows, so deleting an option never
    // orphans existing records — a hard delete is safe (it just stops offering it).
    const { rowCount } = await pool.query('DELETE FROM org_lists WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch(e) { sendError(res, e); }
});

// ── Outsource entities (contractors / vehicle suppliers) ─────────────────────
// The organization of an outsource employee maps here to a type, which drives the
// "Outsource (Services)" / "Outsource (Vehicle Supplier)" classification.
const OUTSOURCE_TYPES = ['services', 'vehicle_supplier'];
app.get('/api/outsource-entities', auth, async (req, res) => {
  try {
    const all = req.query.all === '1' && req.user.role === 'admin';
    const where = all ? '1=1' : 'is_active = TRUE';
    const { rows } = await pool.query(`SELECT id, name, type, is_active, sort_order FROM outsource_entities WHERE ${where} ORDER BY sort_order ASC, name ASC`);
    res.json(rows);
  } catch(e) { sendError(res, e); }
});
app.post('/api/outsource-entities', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, type, sort_order } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!OUTSOURCE_TYPES.includes(type)) return res.status(400).json({ error: 'Type must be services or vehicle_supplier' });
  try {
    const { rows } = await pool.query('INSERT INTO outsource_entities (name, type, sort_order) VALUES ($1,$2,$3) RETURNING *', [name.trim(), type, sort_order || 0]);
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That entity already exists' });
    sendError(res, e);
  }
});
app.put('/api/outsource-entities/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, type, is_active, sort_order } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!OUTSOURCE_TYPES.includes(type)) return res.status(400).json({ error: 'Type must be services or vehicle_supplier' });
  try {
    const { rows } = await pool.query('UPDATE outsource_entities SET name=$1, type=$2, is_active=$3, sort_order=$4 WHERE id=$5 RETURNING *', [name.trim(), type, is_active !== false, sort_order || 0, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That entity already exists' });
    sendError(res, e);
  }
});
app.delete('/api/outsource-entities/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    // Employees carry the organization as free text, so deleting an entity just
    // drops those employees back to a plain "Outsource" classification — no orphaning.
    const { rowCount } = await pool.query('DELETE FROM outsource_entities WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch(e) { sendError(res, e); }
});

// Open requests for a person -- used by the request form to show what's already
// outstanding, so the user sees why a duplicate is refused.
app.get('/api/training-records', auth, async (req, res) => {
  try {
    const { employee_id, status } = req.query;
    const params = [];
    let q = `SELECT t.*, c.name as course_name, c.icon as course_icon, e.full_name as employee_name,
               e.national_id, e.employee_number, u.full_name as requested_by_name,
               cu.full_name as cancelled_by_name
             FROM training_records t
             JOIN training_courses c ON c.id = t.course_id
             LEFT JOIN employees e ON e.id = t.employee_id
             LEFT JOIN users u ON u.id = t.requested_by
             LEFT JOIN users cu ON cu.id = t.cancelled_by
             WHERE t.is_deleted IS NOT TRUE`;
    if (employee_id) { params.push(employee_id); q += ` AND t.employee_id = $${params.length}`; }
    if (status) { params.push(status.split(',')); q += ` AND t.status = ANY($${params.length})`; }
    const projects = await getProjectFilter(req.user);
    if (projects !== null) {
      if (projects.length === 0) return res.json([]);
      params.push(projects); q += ` AND e.project = ANY($${params.length})`;
    }
    const clients = await getClientFilter(req.user);
    if (clients !== null) {
      if (clients.length === 0) return res.json([]);
      params.push(clients); q += ` AND e.client = ANY($${params.length})`;
    }
    q += ' ORDER BY t.requested_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { sendError(res, e); }
});

// ── Trainings Tracker (read-only monitor) ───────────────────
// Paginated, scoped list of every employee training record with a computed
// expiry state. Employees only (casual training has no UI yet). Expiry is
// derived at query time, never stored -- matches ESAT's overdue-metric rule.
const EXPIRY_SOON_DAYS = 60;

// A completed record is SUPERSEDED once a later completion exists for the same
// person+course -- i.e. the certificate was renewed. Superseded rows are kept as
// history but must never count as expired, or every renewal would permanently
// inflate the expired figures. Derived at query time, never stored (same rule as
// the expiry state itself). Correlates on `t`, so it drops into any query below.
const SUPERSEDED_SQL = `EXISTS (
      SELECT 1 FROM training_records tx
       WHERE tx.course_id = t.course_id AND tx.id <> t.id
         AND tx.is_deleted IS NOT TRUE AND tx.status = 'completed'
         AND (tx.employee_id = t.employee_id OR tx.casual_id = t.casual_id)
         AND (tx.completed_at > t.completed_at
              OR (tx.completed_at = t.completed_at AND tx.id > t.id)))`;
// The current (latest) completed certificate for a person+course.
const CURRENT_CERT_SQL = `t.status='completed' AND NOT ${SUPERSEDED_SQL}`;

// The "Expired" view is really the actionable renewal: the auto-opened request
// (Status Requested/…) carrying `prior_expiry_date` (the "Expired on <date>"
// note). The raw expired certificate itself is a reference line, shown only in
// the full "All records" dump.
const RENEWAL_DUE_SQL = `t.prior_expiry_date IS NOT NULL AND t.status IN ('requested','scheduled','pending')`;
// A current expired certificate (the reference line hidden outside All records).
const EXPIRED_CERT_SQL = `${CURRENT_CERT_SQL} AND t.expiry_date < CURRENT_DATE`;

// ── Certificate lifecycle groups (Update page filter) ───────
// Every record falls into exactly one bucket. Active-employee records split by
// certificate state; anything expired / replaced / cancelled / belonging to an
// exited employee is Archived.
const GRP_ARCHIVED_SQL = `(e.employment_status = 'exit'
      OR t.status = 'cancelled'
      OR (t.status = 'completed' AND (t.expiry_date < CURRENT_DATE OR ${SUPERSEDED_SQL})))`;
// A no-expiry certificate (expiry_date IS NULL) is always valid.
const GRP_VALID_SQL = `e.employment_status <> 'exit' AND ${CURRENT_CERT_SQL} AND (t.expiry_date IS NULL OR t.expiry_date > CURRENT_DATE + ${EXPIRY_SOON_DAYS})`;
const GRP_EXPIRING_SQL = `e.employment_status <> 'exit' AND ${CURRENT_CERT_SQL} AND t.expiry_date >= CURRENT_DATE AND t.expiry_date <= CURRENT_DATE + ${EXPIRY_SOON_DAYS}`;
const GRP_OUTSTANDING_SQL = `e.employment_status <> 'exit' AND t.status IN ('requested','scheduled','pending','not_eligible')`;
const GROUP_SQL = { valid: GRP_VALID_SQL, expiring: GRP_EXPIRING_SQL, outstanding: GRP_OUTSTANDING_SQL, archived: GRP_ARCHIVED_SQL };

// Who owns chasing a training, derived from the resource's own classification:
// in-house (incl. interns) -> HR; outsource vehicle supplier -> Fleet; outsource
// services -> Operation. Correlates on `e` (employees) + `oe` (outsource_entities),
// so any query joining both can drop it in. An outsource org that isn't registered
// in outsource_entities has no owning team, so it falls back to HR.
const PENDING_TEAM_REASON_SQL = `CASE
        WHEN e.resource_type = 'outsource' AND oe.type = 'vehicle_supplier' THEN 'Pending Fleet Training Approval'
        WHEN e.resource_type = 'outsource' AND oe.type = 'services' THEN 'Pending Operation Dept.'
        ELSE 'Pending HR Dept.' END`;

// Append one line to a training record's history. `user` is the acting req.user,
// or null for the system (the expiry sweep). Logging must never be the reason an
// action fails, so a broken insert is reported and swallowed -- a missing history
// line is a smaller problem than a refused update.
const logTrainingEvent = async ({ recordId, action, from, to, detail, user }) => {
  try {
    await pool.query(
      `INSERT INTO training_record_events
         (training_record_id, action, from_status, to_status, detail, changed_by, changed_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [recordId, action, from || null, to || null, detail || null, user?.id || null, user ? (user.name || null) : 'System']
    );
  } catch (e) { console.error('training event log failed:', e.message); }
};

// When a certificate expires, a renewal has to happen -- so we auto-open a
// `pending` record for it, which then flows through the normal Update process
// (scheduled / completed) like any other request. It opens as Pending (not
// Requested) because nobody has to raise it: the expiry itself is the trigger,
// and the pending reason names the team that owns the renewal. The expired
// certificate itself is left untouched (still reads "Expired"); the new record
// carries `prior_expiry_date` so the UI can show "Expired on <date>".
//
// This is idempotent and lazy: it inserts a record only for a CURRENT expired
// certificate (not superseded history) belonging to an ACTIVE employee that does
// not already have an open request. The partial unique index is the final guard
// against duplicates, so concurrent calls are safe (23505 is swallowed).
//
// A renewal that was CANCELLED or marked NOT ELIGIBLE is a decision that this
// person no longer needs the course, so the sweep must not raise it again the
// next time a page loads. The decline is tied to the expired certificate it was
// made against (`prior_expiry_date` = that cert's `expiry_date`), so it retires
// that certificate for good without muzzling anything else: a human can still
// request the course manually at any time, and once a NEW certificate is earned
// and later expires, that fresh cycle carries a different date and opens
// normally.
const ensureRenewalRequests = async (courseId) => {
  const params = [];
  let courseClause = '';
  if (courseId) { params.push(courseId); courseClause = ` AND t.course_id = $${params.length}`; }
  try {
    const { rows: opened } = await pool.query(`
      INSERT INTO training_records (employee_id, course_id, status, pending_reason, requested_at, prior_expiry_date, created_at, updated_at)
      SELECT t.employee_id, t.course_id, 'pending', ${PENDING_TEAM_REASON_SQL}, NOW(), t.expiry_date, NOW(), NOW()
      FROM training_records t
      JOIN employees e ON e.id = t.employee_id
      LEFT JOIN outsource_entities oe ON LOWER(TRIM(oe.name)) = LOWER(TRIM(e.organization))
      WHERE t.status = 'completed'
        AND t.expiry_date < CURRENT_DATE
        AND t.is_deleted IS NOT TRUE
        AND t.employee_id IS NOT NULL
        AND e.employment_status = 'active'
        ${courseClause}
        AND NOT ${SUPERSEDED_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM training_records o
           WHERE o.employee_id = t.employee_id AND o.course_id = t.course_id
             AND o.is_deleted IS NOT TRUE
             AND o.status IN ('requested','scheduled','pending'))
        AND NOT EXISTS (
          SELECT 1 FROM training_records d
           WHERE d.employee_id = t.employee_id AND d.course_id = t.course_id
             AND d.is_deleted IS NOT TRUE
             AND d.status IN ('cancelled','not_eligible')
             AND d.prior_expiry_date = t.expiry_date)
      RETURNING id, prior_expiry_date, pending_reason
    `, params);
    for (const r of opened) {
      await logTrainingEvent({
        recordId: r.id, action: 'opened', to: 'pending', user: null,
        detail: `Renewal opened automatically — certificate expired ${r.prior_expiry_date.toISOString().slice(0, 10)} (${r.pending_reason})`,
      });
    }
  } catch (e) {
    if (e.code !== '23505') throw e; // unique index caught a race -- already exists
  }
};

// Shared WHERE builder so /tracker and /stats always filter identically.
const trainingTrackerWhere = async (req, params) => {
  const { status, search, national_id, job_title, course_id, resource_type, department, organization, expiry, employment_status, hide_expired_cert, new_only, group, pending_reason } = req.query;
  const projectsCsv = req.query.projects ? req.query.projects.split(',').filter(Boolean) : [];
  const clientsCsv = req.query.clients ? req.query.clients.split(',').filter(Boolean) : [];
  let w = ` WHERE t.is_deleted IS NOT TRUE AND t.employee_id IS NOT NULL`;
  if (status) { params.push(status.split(',')); w += ` AND t.status = ANY($${params.length})`; }
  if (employment_status) { params.push(employment_status); w += ` AND e.employment_status = $${params.length}`; }
  if (search) { params.push(`%${search}%`); w += ` AND (e.full_name ILIKE $${params.length} OR e.employee_number ILIKE $${params.length})`; }
  if (national_id) { params.push(`%${national_id}%`); w += ` AND e.national_id ILIKE $${params.length}`; }
  if (job_title) { params.push(`%${job_title}%`); w += ` AND e.job_title ILIKE $${params.length}`; }
  if (course_id) { params.push(course_id); w += ` AND t.course_id = $${params.length}`; }
  if (department) { params.push(department); w += ` AND e.department = $${params.length}`; }
  if (organization) { params.push(organization); w += ` AND e.organization = $${params.length}`; }
  // Same intern/inhouse disjointness as the employees list.
  if (resource_type === 'intern') { w += ` AND e.job_title ILIKE '%intern%'`; }
  else if (resource_type === 'inhouse') { w += ` AND e.resource_type='inhouse' AND e.job_title NOT ILIKE '%intern%'`; }
  else if (resource_type) { params.push(resource_type); w += ` AND e.resource_type = $${params.length}`; }
  if (projectsCsv.length) { params.push(projectsCsv); w += ` AND e.project = ANY($${params.length})`; }
  if (clientsCsv.length) { params.push(clientsCsv); w += ` AND e.client = ANY($${params.length})`; }
  // Only pending records carry a reason, so this also narrows to Pending.
  if (pending_reason) { params.push(pending_reason); w += ` AND t.pending_reason = $${params.length}`; }
  // Expiry buckets apply only to completed records that carry an expiry date.
  // A renewed (superseded) certificate is history, so it lands in none of them.
  // 'expired' = the expired CERTIFICATE (the Tracker's compliance view).
  // 'renewal_due' = the actionable RENEWAL REQUEST that expiry auto-opens (the
  // Update page's "Expired" view); the cert itself is hidden there.
  if (expiry === 'expiring') { w += ` AND ${CURRENT_CERT_SQL} AND t.expiry_date >= CURRENT_DATE AND t.expiry_date <= CURRENT_DATE + ${EXPIRY_SOON_DAYS}`; }
  else if (expiry === 'expired') { w += ` AND ${EXPIRED_CERT_SQL}`; }
  else if (expiry === 'renewal_due') { w += ` AND ${RENEWAL_DUE_SQL}`; }
  else if (expiry === 'valid') { w += ` AND ${CURRENT_CERT_SQL} AND (t.expiry_date IS NULL OR t.expiry_date > CURRENT_DATE + ${EXPIRY_SOON_DAYS})`; }
  else if (expiry === 'superseded') { w += ` AND t.status='completed' AND ${SUPERSEDED_SQL}`; }
  // Everywhere except the full "All records" view, the raw expired certificate
  // is hidden -- its renewal request stands in for it in the working views.
  if (hide_expired_cert) { w += ` AND NOT (${EXPIRED_CERT_SQL})`; }
  // The default open-requests worklist shows only genuine new requests; renewals
  // (which carry prior_expiry_date) live under the Expired view instead.
  if (new_only) { w += ` AND t.prior_expiry_date IS NULL`; }
  // Certificate-lifecycle group (Update page). One bucket per record.
  if (GROUP_SQL[group]) { w += ` AND (${GROUP_SQL[group]})`; }
  // Project/client scope -- returns null (no restriction) or an allow-list.
  const projects = await getProjectFilter(req.user);
  if (projects !== null) {
    if (projects.length === 0) return { blocked: true };
    params.push(projects); w += ` AND e.project = ANY($${params.length})`;
  }
  const clients = await getClientFilter(req.user);
  if (clients !== null) {
    if (clients.length === 0) return { blocked: true };
    params.push(clients); w += ` AND e.client = ANY($${params.length})`;
  }
  return { where: w };
};

app.get('/api/training-records/tracker', auth, async (req, res) => {
  try {
    await ensureRenewalRequests(req.query.course_id); // materialise renewals for newly-expired certs
    const params = [];
    const built = await trainingTrackerWhere(req, params);
    if (built.blocked) return res.json({ rows: [], total: 0, page: 1, pageSize: 25 });
    const limit = Math.min(Math.max(parseInt(req.query.pageSize) || 25, 1), 100);
    const pageNum = Math.max(parseInt(req.query.page) || 1, 1);
    const offset = (pageNum - 1) * limit;
    const q = `
      SELECT t.id, t.status, t.requested_at, t.scheduled_date, t.completed_at,
             t.expiry_date, t.prior_expiry_date, t.pending_reason, t.not_eligible_reason, t.cancel_reason,
             (t.cloudinary_public_id IS NOT NULL) AS has_certificate, t.original_filename,
             c.name AS course_name, c.validity_months, c.no_expiry, c.needs_certificate,
             e.full_name AS employee_name, e.national_id, e.employee_number,
             e.job_title, e.department, e.project, e.client, e.organization, e.employment_status,
             u.full_name AS requested_by_name, ru.full_name AS recorded_by_name, t.recorded_at,
             (t.expiry_date - CURRENT_DATE) AS days_to_expiry,
             CASE WHEN t.status='completed' AND ${SUPERSEDED_SQL} THEN 'superseded'
                  WHEN t.status='completed' AND t.expiry_date IS NOT NULL THEN
               CASE WHEN t.expiry_date < CURRENT_DATE THEN 'expired'
                    WHEN t.expiry_date <= CURRENT_DATE + ${EXPIRY_SOON_DAYS} THEN 'expiring'
                    ELSE 'valid' END
                  WHEN t.status='completed' THEN 'valid'
             END AS expiry_state,
             COUNT(*) OVER() AS full_count
      FROM training_records t
      JOIN training_courses c ON c.id = t.course_id
      LEFT JOIN employees e ON e.id = t.employee_id
      LEFT JOIN users u ON u.id = t.requested_by
      LEFT JOIN users ru ON ru.id = t.recorded_by
      ${built.where}
      ORDER BY t.requested_at DESC, t.id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const { rows } = await pool.query(q, params);
    const total = rows.length ? parseInt(rows[0].full_count) : 0;
    res.json({ rows, total, page: pageNum, pageSize: limit });
  } catch(e) { sendError(res, e); }
});

app.get('/api/training-records/stats', auth, async (req, res) => {
  try {
    await ensureRenewalRequests(req.query.course_id); // keep counts in step with the list
    // Stats ignore the status/expiry filters (they ARE the buckets) but keep the
    // people-filters, so counts always match the list the user is looking at.
    const statReq = { user: req.user, query: { ...req.query, status: undefined, expiry: undefined, hide_expired_cert: undefined, new_only: undefined, group: undefined } };
    const params = [];
    const built = await trainingTrackerWhere(statReq, params);
    if (built.blocked) return res.json({ total:0, requested:0, scheduled:0, pending:0, completed:0, open:0, expiring:0, expired:0, renewal_due:0, superseded:0, grp_valid:0, grp_outstanding:0, grp_expiring:0, grp_archived:0 });
    const q = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE t.status='requested')::int AS requested,
        COUNT(*) FILTER (WHERE t.status='scheduled')::int AS scheduled,
        COUNT(*) FILTER (WHERE t.status='pending')::int AS pending,
        COUNT(*) FILTER (WHERE t.status='completed')::int AS completed,
        COUNT(*) FILTER (WHERE t.status IN ('requested','scheduled','pending') AND t.prior_expiry_date IS NULL)::int AS open,
        COUNT(*) FILTER (WHERE ${CURRENT_CERT_SQL} AND t.expiry_date >= CURRENT_DATE AND t.expiry_date <= CURRENT_DATE + ${EXPIRY_SOON_DAYS})::int AS expiring,
        COUNT(*) FILTER (WHERE ${EXPIRED_CERT_SQL})::int AS expired,
        COUNT(*) FILTER (WHERE ${RENEWAL_DUE_SQL})::int AS renewal_due,
        COUNT(*) FILTER (WHERE t.status='completed' AND ${SUPERSEDED_SQL})::int AS superseded,
        COUNT(*) FILTER (WHERE ${GRP_VALID_SQL})::int AS grp_valid,
        COUNT(*) FILTER (WHERE ${GRP_OUTSTANDING_SQL})::int AS grp_outstanding,
        COUNT(*) FILTER (WHERE ${GRP_EXPIRING_SQL})::int AS grp_expiring,
        COUNT(*) FILTER (WHERE ${GRP_ARCHIVED_SQL})::int AS grp_archived
      FROM training_records t
      JOIN training_courses c ON c.id = t.course_id
      LEFT JOIN employees e ON e.id = t.employee_id
      ${built.where}`;
    const { rows } = await pool.query(q, params);
    res.json(rows[0]);
  } catch(e) { sendError(res, e); }
});

// Per-course expired/expiring counts, so the Update page can show HR what needs
// renewing before a course is even picked. Ignores any course_id/status/expiry
// filter (it reports on every course) but keeps the people-filters and scope.
app.get('/api/training-records/expiry-summary', auth, async (req, res) => {
  try {
    await ensureRenewalRequests(); // Update page mount → sweep every course
    const sumReq = { user: req.user, query: { ...req.query, status: undefined, expiry: undefined, course_id: undefined, hide_expired_cert: undefined, new_only: undefined, group: undefined } };
    const params = [];
    const built = await trainingTrackerWhere(sumReq, params);
    if (built.blocked) return res.json([]);
    // 'expired' counts renewal requests (matching the Expired view); 'open' counts
    // only genuine new requests, so the two badges stay disjoint.
    const q = `
      SELECT t.course_id,
             COUNT(*) FILTER (WHERE ${GRP_OUTSTANDING_SQL})::int AS outstanding,
             COUNT(*) FILTER (WHERE ${GRP_EXPIRING_SQL})::int AS expiring,
             COUNT(*) FILTER (WHERE ${GRP_VALID_SQL})::int AS valid,
             COUNT(*) FILTER (WHERE ${GRP_ARCHIVED_SQL})::int AS archived
      FROM training_records t
      JOIN training_courses c ON c.id = t.course_id
      LEFT JOIN employees e ON e.id = t.employee_id
      ${built.where}
      GROUP BY t.course_id`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { sendError(res, e); }
});

// Training Dashboard aggregation (the ETMS "View Dashboard"): KPI totals, the
// pending-reason breakdown, and the valid/expiring/expired split per course and
// per project. The validity buckets ARE what the dashboard shows, so status/expiry
// filters are ignored here — only the people-filters (client/project/course/
// resource/employment status) + scope apply.
app.get('/api/training-records/dashboard', auth, async (req, res) => {
  try {
    // Note: no ensureRenewalRequests() here — the dashboard is a read-only report
    // and firing that write on every one of its 3 fetches is pure overhead. The
    // Tracker and Update pages still materialise renewals.
    // pending_reason is honoured here (unlike the other narrowing params) so the
    // dashboard's Pending Reason filter scopes the whole view to that reason —
    // valid/expiring then read 0 and the charts show the pending breakdown for it.
    const dashReq = { user: req.user, query: { ...req.query, status: undefined, expiry: undefined, group: undefined, hide_expired_cert: undefined, new_only: undefined } };
    const params = [];
    const built = await trainingTrackerWhere(dashReq, params);
    if (built.blocked) return res.json({ kpis: { requested: 0, valid: 0, expiring: 0, expired: 0, total: 0 }, pending_reasons: [], by_course: [], by_project: [] });
    const where = built.where;
    const VALID = `${CURRENT_CERT_SQL} AND (t.expiry_date IS NULL OR t.expiry_date > CURRENT_DATE + ${EXPIRY_SOON_DAYS})`;
    const EXPIRING = `${CURRENT_CERT_SQL} AND t.expiry_date >= CURRENT_DATE AND t.expiry_date <= CURRENT_DATE + ${EXPIRY_SOON_DAYS}`;
    // "Pending" on the dashboard = the whole Outstanding group (matches the
    // Trainings Tracker's "Pending" card): requested + scheduled + pending +
    // not_eligible. Records keep their distinct status; this only affects counts
    // and the pending-reason breakdown below.
    const PENDING = `t.status IN ('requested','scheduled','pending','not_eligible')`;
    const from = `FROM training_records t JOIN training_courses c ON c.id=t.course_id LEFT JOIN employees e ON e.id=t.employee_id`;
    const buckets = `
      COUNT(*) FILTER (WHERE ${VALID})::int AS valid,
      COUNT(*) FILTER (WHERE ${EXPIRING})::int AS expiring,
      COUNT(*) FILTER (WHERE ${PENDING})::int AS pending`;
    const grpOrder = `(COUNT(*) FILTER (WHERE ${VALID}) + COUNT(*) FILTER (WHERE ${EXPIRING}) + COUNT(*) FILTER (WHERE ${PENDING}))`;

    // Run the 4 independent aggregates concurrently (own pool connection each)
    // instead of sequentially — cuts wall-clock to ~one query's time.
    const [kpiR, prR, bcR, bpR] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS all_records,
        COUNT(*) FILTER (WHERE t.status IN ('requested','scheduled','pending'))::int AS requested,
        ${buckets} ${from} ${where}`, params),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(t.pending_reason),''), NULLIF(TRIM(t.not_eligible_reason),''), INITCAP(REPLACE(t.status,'_',' '))) AS reason, COUNT(*)::int AS count
        ${from} ${where} AND ${PENDING} GROUP BY 1 ORDER BY count DESC`, params),
      pool.query(`SELECT c.name AS course, ${buckets}
        ${from} ${where} GROUP BY c.name HAVING ${grpOrder} > 0 ORDER BY ${grpOrder} DESC`, params),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(e.project),''),'(none)') AS project,
        CASE WHEN COUNT(DISTINCT NULLIF(TRIM(e.client),'')) = 1 THEN MAX(NULLIF(TRIM(e.client),''))
             WHEN COUNT(DISTINCT NULLIF(TRIM(e.client),'')) > 1 THEN 'Multiple' ELSE NULL END AS client,
        ${buckets}
        ${from} ${where} GROUP BY 1 HAVING ${grpOrder} > 0 ORDER BY ${grpOrder} DESC`, params),
    ]);
    const kpi = kpiR.rows[0];
    // total = valid + about-to-expire + pending (drives the validity donut);
    // all_records = every training record for the filter (drives the top KPI card).
    kpi.total = kpi.valid + kpi.expiring + kpi.pending;
    const pending_reasons = prR.rows;
    const by_course = bcR.rows.map(r => ({ ...r, total: r.valid + r.expiring + r.pending }));
    const by_project = bpR.rows.map(r => ({ ...r, total: r.valid + r.expiring + r.pending }));

    res.json({ kpis: kpi, pending_reasons, by_course, by_project });
  } catch(e) { sendError(res, e); }
});

// ── Renew a training (new certificate, previous one kept) ───
// A renewal is a NEW record, never an overwrite: the expired certificate stays
// as history (with its own date, cost and -- later -- its PDF) and is marked
// superseded by the derived rule above. Correcting a mistake on the current
// certificate is the other endpoint (`/update`), which edits in place.
app.post('/api/training-records/:id/renew', auth, async (req, res) => {
  if (!TRAINING_UPDATE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized to update training records' });
  }
  const { completed_at, training_cost, partnership } = req.body;
  try {
    const { rows: [rec] } = await pool.query(
      `SELECT t.id, t.status, t.employee_id, t.casual_id, t.course_id, t.completed_at, t.expiry_date,
              c.validity_months, c.no_expiry, c.name AS course_name,
              e.project, e.client, e.organization, e.employment_status
       FROM training_records t
       JOIN training_courses c ON c.id = t.course_id
       LEFT JOIN employees e ON e.id = t.employee_id
       WHERE t.id = $1 AND t.is_deleted IS NOT TRUE`, [req.params.id]
    );
    if (!rec || !rec.employee_id) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(req.user, rec.project, rec.client))) return res.status(404).json({ error: 'Not found' });
    if (!(await canManageCourse(req.user, rec.course_id))) return res.status(403).json({ error: `You are not assigned to manage "${rec.course_name}".` });
    if (rec.status !== 'completed') {
      return res.status(400).json({ error: 'Only a completed training can be renewed — record this one first.' });
    }
    if (!completed_at) return res.status(400).json({ error: 'Completion date is required' });
    if (!rec.no_expiry && rec.validity_months == null) {
      return res.status(400).json({ error: `Set a validity period (or mark it "No expiry") for "${rec.course_name}" in Admin → Training Courses before renewing it.` });
    }
    if (rec.completed_at && new Date(completed_at) <= new Date(rec.completed_at)) {
      return res.status(400).json({ error: 'The renewal date must be after the previous completion date.' });
    }
    // If EHS already raised a fresh request for this training, that record is the
    // one to record against -- renewing separately would strand it open.
    const { rows: [open] } = await pool.query(
      `SELECT id FROM training_records
        WHERE employee_id=$1 AND course_id=$2 AND is_deleted IS NOT TRUE
          AND status IN ('requested','scheduled','pending') LIMIT 1`,
      [rec.employee_id, rec.course_id]
    );
    if (open) {
      return res.status(400).json({ error: 'This employee already has an open request for this training — record that one as completed instead of renewing.' });
    }
    const cost = (training_cost === '' || training_cost == null) ? null : Number(training_cost);
    if (cost != null && (isNaN(cost) || cost < 0)) return res.status(400).json({ error: 'Training cost must be a non-negative number' });
    const { rows } = await pool.query(
      `INSERT INTO training_records
         (employee_id, course_id, status, requested_by, requested_at,
          completed_at, expiry_date, validity_months_applied, training_cost, partnership,
          project_at_completion, client_at_completion, organization_at_completion,
          recorded_by, recorded_at)
       VALUES ($1, $2, 'completed', $3, NOW(),
               $4, ($4::date + ($5 * INTERVAL '1 month'))::date, $5, $6, $7,
               $8, $9, $10, $3, NOW())
       RETURNING *`,
      [rec.employee_id, rec.course_id, req.user.id,
       completed_at, (rec.no_expiry ? null : rec.validity_months), cost, partnership || null,
       rec.project || null, rec.client || null, rec.organization || null]
    );
    // A renewal is a NEW record, so its history starts here -- and the certificate
    // it supersedes gets a line too, since that is where anyone looking at the old
    // one would go to find out what happened to it.
    await logTrainingEvent({
      recordId: rows[0].id, action: 'renewed', to: 'completed', user: req.user,
      detail: `Renewed from the certificate completed ${rec.completed_at ? rec.completed_at.toISOString().slice(0, 10) : '—'}`
            + `, new completion ${completed_at}`
            + (rows[0].expiry_date ? `, expires ${rows[0].expiry_date.toISOString().slice(0, 10)}` : ' (no expiry)'),
    });
    await logTrainingEvent({
      recordId: rec.id, action: 'superseded', from: 'completed', to: 'completed', user: req.user,
      detail: `Renewed — replaced by the certificate completed ${completed_at}`,
    });
    res.status(201).json(rows[0]);
  } catch(e) { sendError(res, e); }
});

// ── Update Training Record (HR records the outcome) ─────────
// Transition an OPEN request (requested/scheduled/pending) to its outcome.
// PDF certificate upload is deliberately NOT here yet -- staged for next step.
app.put('/api/training-records/:id/update', auth, async (req, res) => {
  if (!TRAINING_UPDATE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized to update training records' });
  }
  const { status } = req.body;
  const ALLOWED = ['completed', 'pending', 'scheduled', 'not_eligible'];
  if (!ALLOWED.includes(status)) return res.status(400).json({ error: 'Invalid outcome status' });
  try {
    // Load the record with its course validity and the employee snapshot fields.
    const { rows: [rec] } = await pool.query(
      `SELECT t.id, t.status AS current_status, t.employee_id, t.course_id,
              t.completed_at AS current_completed_at, t.expiry_date AS current_expiry_date,
              c.validity_months, c.no_expiry, c.name AS course_name,
              e.project, e.client, e.organization
       FROM training_records t
       JOIN training_courses c ON c.id = t.course_id
       LEFT JOIN employees e ON e.id = t.employee_id
       WHERE t.id = $1 AND t.is_deleted IS NOT TRUE`, [req.params.id]
    );
    if (!rec || !rec.employee_id) return res.status(404).json({ error: 'Not found' });
    // Scope: out of scope reads as not-found (HR/admin are unrestricted anyway).
    if (!(await inScope(req.user, rec.project, rec.client))) return res.status(404).json({ error: 'Not found' });
    // Per-course management access (admin bypasses).
    if (!(await canManageCourse(req.user, rec.course_id))) return res.status(403).json({ error: `You are not assigned to manage "${rec.course_name}".` });
    // Open requests AND already-recorded ones (e.g. a valid certificate that needs
    // correcting) can be updated here. Moving a completed record back to an open
    // status can trip the one-open-request index if a renewal already exists --
    // that's surfaced as a friendly 23505 below.

    if (status === 'completed') {
      const { completed_at, training_cost, partnership } = req.body;
      if (!completed_at) return res.status(400).json({ error: 'Completion date is required' });
      // "No expiry" courses complete without a validity period (expiry stays NULL);
      // otherwise a validity is required to compute the expiry date.
      if (!rec.no_expiry && rec.validity_months == null) {
        return res.status(400).json({ error: `Set a validity period (or mark it "No expiry") for "${rec.course_name}" in Admin → Training Courses before completing it.` });
      }
      const validity = rec.no_expiry ? null : rec.validity_months;
      // Editing a completed record is a CORRECTION to that certificate. A date at
      // or beyond its expiry is a new training cycle, and saving it here would
      // silently erase the previous certificate -- that has to go through Renew.
      // (No-expiry certs have no expiry date, so this guard never applies.)
      if (rec.current_status === 'completed' && rec.current_expiry_date &&
          new Date(completed_at) >= new Date(rec.current_expiry_date)) {
        return res.status(400).json({ error: 'That date starts a new training cycle. Use Renew so the previous certificate is kept as history.' });
      }
      const cost = (training_cost === '' || training_cost == null) ? null : Number(training_cost);
      if (cost != null && (isNaN(cost) || cost < 0)) return res.status(400).json({ error: 'Training cost must be a non-negative number' });
      const { rows } = await pool.query(
        `UPDATE training_records SET
           status='completed', completed_at=$1,
           expiry_date=($1::date + ($2 * INTERVAL '1 month'))::date,
           validity_months_applied=$2, training_cost=$3, partnership=$4,
           project_at_completion=$5, client_at_completion=$6, organization_at_completion=$7,
           recorded_by=$8, recorded_at=NOW(), updated_at=NOW()
         WHERE id=$9 RETURNING *`,
        [completed_at, validity, cost, partnership || null,
         rec.project || null, rec.client || null, rec.organization || null,
         req.user.id, req.params.id]
      );
      // Recording an outcome overwrites the previous one, so note whether this was
      // the first record or a correction to an existing certificate.
      await logTrainingEvent({
        recordId: req.params.id, action: 'completed', from: rec.current_status, to: 'completed', user: req.user,
        detail: `${rec.current_status === 'completed' ? 'Corrected' : 'Recorded'} as completed ${completed_at}`
              + (rows[0].expiry_date ? `, expires ${rows[0].expiry_date.toISOString().slice(0, 10)}` : ' (no expiry)')
              + (partnership ? ` · ${partnership}` : ''),
      });
      return res.json(rows[0]);
    }

    if (status === 'pending') {
      const { pending_reason } = req.body;
      if (!pending_reason || !pending_reason.trim()) return res.status(400).json({ error: 'A pending reason is required' });
      const { rows } = await pool.query(
        `UPDATE training_records SET status='pending', pending_reason=$1, recorded_by=$2, recorded_at=NOW(), updated_at=NOW() WHERE id=$3 RETURNING *`,
        [pending_reason.trim(), req.user.id, req.params.id]
      );
      await logTrainingEvent({
        recordId: req.params.id, action: 'pending', from: rec.current_status, to: 'pending', user: req.user,
        detail: pending_reason.trim(),
      });
      return res.json(rows[0]);
    }

    if (status === 'scheduled') {
      const { scheduled_date } = req.body;
      if (!scheduled_date) return res.status(400).json({ error: 'A scheduled date is required' });
      const { rows } = await pool.query(
        `UPDATE training_records SET status='scheduled', scheduled_date=$1, recorded_by=$2, recorded_at=NOW(), updated_at=NOW() WHERE id=$3 RETURNING *`,
        [scheduled_date, req.user.id, req.params.id]
      );
      await logTrainingEvent({
        recordId: req.params.id, action: 'scheduled', from: rec.current_status, to: 'scheduled', user: req.user,
        detail: `Scheduled for ${scheduled_date}`,
      });
      return res.json(rows[0]);
    }

    // not_eligible
    const { not_eligible_reason } = req.body;
    if (!not_eligible_reason || !not_eligible_reason.trim()) return res.status(400).json({ error: 'A reason is required' });
    const { rows } = await pool.query(
      `UPDATE training_records SET status='not_eligible', not_eligible_reason=$1, recorded_by=$2, recorded_at=NOW(), updated_at=NOW() WHERE id=$3 RETURNING *`,
      [not_eligible_reason.trim(), req.user.id, req.params.id]
    );
    await logTrainingEvent({
      recordId: req.params.id, action: 'not_eligible', from: rec.current_status, to: 'not_eligible', user: req.user,
      detail: not_eligible_reason.trim(),
    });
    return res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'This employee already has an open request for this training — resolve that one first.' });
    sendError(res, e);
  }
});

app.post('/api/training-requests', auth, async (req, res) => {
  if (!TRAINING_REQUEST_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized to request training' });
  }
  const { employee_id, course_id } = req.body;
  if (!employee_id || !course_id) return res.status(400).json({ error: 'Employee and training type are required' });
  try {
    // Same scope rule as every other person-linked resource: out of scope reads
    // as "not found" rather than leaking that the employee exists.
    const scope = await getPersonScope(employee_id);
    if (!scope || !(await inScope(req.user, scope.project, scope.client))) {
      return res.status(404).json({ error: 'Not found' });
    }
    const { rows: [emp] } = await pool.query(
      "SELECT employment_status FROM employees WHERE id=$1", [employee_id]
    );
    if (!emp) return res.status(404).json({ error: 'Not found' });
    if (emp.employment_status !== 'active') {
      return res.status(400).json({ error: 'Cannot request training for a non-active employee' });
    }
    // Raising the request IS the action -- there is no separate "someone must
    // pick this up" step -- so it opens straight as Pending against the team that
    // owns the training (same rule as the expiry-opened renewals above).
    //
    // If the person already holds an EXPIRED certificate for this course, this is
    // a renewal however it was raised -- typically re-asking for one that was
    // cancelled earlier. Carry that certificate's expiry across as
    // `prior_expiry_date` so the record keeps its history ("Expired on <date>")
    // and files under Expired rather than posing as a brand-new request.
    const { rows: [rec] } = await pool.query(
      `INSERT INTO training_records (employee_id, course_id, status, pending_reason, prior_expiry_date, requested_by, requested_at)
       SELECT e.id, $2::uuid, 'pending', ${PENDING_TEAM_REASON_SQL},
              CASE WHEN prev.expiry_date < CURRENT_DATE THEN prev.expiry_date END, $3, NOW()
       FROM employees e
       LEFT JOIN outsource_entities oe ON LOWER(TRIM(oe.name)) = LOWER(TRIM(e.organization))
       LEFT JOIN LATERAL (
         SELECT p.expiry_date FROM training_records p
          WHERE p.employee_id = e.id AND p.course_id = $2::uuid
            AND p.status = 'completed' AND p.is_deleted IS NOT TRUE
          ORDER BY p.completed_at DESC, p.id DESC LIMIT 1
       ) prev ON TRUE
       WHERE e.id = $1
       RETURNING *`,
      [employee_id, course_id, req.user.id]
    );
    await logTrainingEvent({
      recordId: rec.id, action: 'opened', to: 'pending', user: req.user,
      detail: `Requested${rec.prior_expiry_date ? ` — renewal, certificate expired ${rec.prior_expiry_date.toISOString().slice(0, 10)}` : ''} (${rec.pending_reason})`,
    });
    res.json(rec);
  } catch(e) {
    // 23505 = the partial unique index: an open request already exists.
    if (e.code === '23505') {
      return res.status(400).json({ error: 'This employee already has an open request for this training' });
    }
    sendError(res, e);
  }
});

// Remove (cancel) an open training request -- EHS side, same roles as raising it.
// A reason is mandatory. Only open requests can be cancelled.
app.put('/api/training-records/:id/cancel', auth, async (req, res) => {
  if (!TRAINING_REQUEST_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorized to remove training requests' });
  }
  const { cancel_reason } = req.body;
  if (!cancel_reason || !cancel_reason.trim()) return res.status(400).json({ error: 'A reason is required to remove a request' });
  try {
    const { rows: [rec] } = await pool.query(
      `SELECT t.status AS current_status, e.project, e.client
       FROM training_records t LEFT JOIN employees e ON e.id = t.employee_id
       WHERE t.id = $1 AND t.is_deleted IS NOT TRUE AND t.employee_id IS NOT NULL`, [req.params.id]
    );
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(req.user, rec.project, rec.client))) return res.status(404).json({ error: 'Not found' });
    if (!['requested', 'scheduled', 'pending'].includes(rec.current_status)) {
      return res.status(400).json({ error: `This request is already ${rec.current_status} and can't be removed` });
    }
    const { rows: [updated] } = await pool.query(
      `UPDATE training_records SET status='cancelled', cancel_reason=$1, cancelled_by=$2, cancelled_at=NOW(), updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [cancel_reason.trim(), req.user.id, req.params.id]
    );
    await logTrainingEvent({
      recordId: req.params.id, action: 'removed', from: rec.current_status, to: 'cancelled', user: req.user,
      detail: cancel_reason.trim(),
    });
    res.json(updated);
  } catch(e) { sendError(res, e); }
});

// Undo a removal. Removing is easy to do by mistake and used to be permanent
// (the record could only be resurrected from the database), so a request removed
// in error comes straight back here: open again, keeping the pending reason and
// the "Expired on <date>" history it was carrying. It only fails if the person
// has since picked up another open record for the same course, which the
// one-open-request index would reject anyway.
//
// ADMIN ONLY -- narrower than /cancel, which EHS managers may also use. Restoring
// clears the removal outright (who removed it, when and why), and nothing else
// records that it ever happened, so it is deliberately held to the role that is
// accountable for the data.
app.put('/api/training-records/:id/restore', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    // The removal details are about to be cleared off the record, so read them
    // first -- the history line is the only place they will survive.
    const { rows: [rec] } = await pool.query(
      `SELECT t.status AS current_status, t.cancel_reason, t.cancelled_at, cu.full_name AS cancelled_by_name,
              e.project, e.client, e.employment_status
       FROM training_records t
       LEFT JOIN employees e ON e.id = t.employee_id
       LEFT JOIN users cu ON cu.id = t.cancelled_by
       WHERE t.id = $1 AND t.is_deleted IS NOT TRUE AND t.employee_id IS NOT NULL`, [req.params.id]
    );
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(req.user, rec.project, rec.client))) return res.status(404).json({ error: 'Not found' });
    if (rec.current_status !== 'cancelled') {
      return res.status(400).json({ error: `This request is ${rec.current_status}, so there is nothing to restore` });
    }
    if (rec.employment_status !== 'active') {
      return res.status(400).json({ error: 'Cannot restore a request for a non-active employee' });
    }
    // Keep whatever reason it was pending on before it was removed; fall back to
    // the owning team if it never carried one (an old 'requested' record).
    const { rows: [updated] } = await pool.query(
      `UPDATE training_records t
          SET status = 'pending',
              pending_reason = COALESCE(NULLIF(TRIM(t.pending_reason), ''), ${PENDING_TEAM_REASON_SQL}),
              cancel_reason = NULL, cancelled_by = NULL, cancelled_at = NULL, updated_at = NOW()
         FROM employees e
         LEFT JOIN outsource_entities oe ON LOWER(TRIM(oe.name)) = LOWER(TRIM(e.organization))
        WHERE e.id = t.employee_id AND t.id = $1
        RETURNING t.*`, [req.params.id]
    );
    await logTrainingEvent({
      recordId: req.params.id, action: 'restored', from: 'cancelled', to: 'pending', user: req.user,
      detail: `Undid the removal by ${rec.cancelled_by_name || 'unknown'}`
            + (rec.cancelled_at ? ` on ${rec.cancelled_at.toISOString().slice(0, 10)}` : '')
            + (rec.cancel_reason ? ` — "${rec.cancel_reason}"` : ''),
    });
    res.json(updated);
  } catch(e) {
    if (e.code === '23505') {
      return res.status(400).json({ error: 'This employee already has an open request for this training — resolve that one first.' });
    }
    sendError(res, e);
  }
});

// Delete a training record outright (admin only, soft delete). This is for rows
// that should never have existed -- a duplicate, a test, a mis-keyed entry --
// not for ordinary outcomes, which have their own statuses. A completed record
// is history (and may hold a certificate), so it can't be deleted here.
app.delete('/api/training-records/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows: [rec] } = await pool.query(
      `SELECT status FROM training_records WHERE id = $1 AND is_deleted IS NOT TRUE`, [req.params.id]
    );
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (rec.status === 'completed') {
      return res.status(400).json({ error: 'A completed record is certificate history and cannot be deleted' });
    }
    await pool.query('UPDATE training_records SET is_deleted = TRUE, updated_at = NOW() WHERE id = $1', [req.params.id]);
    await logTrainingEvent({
      recordId: req.params.id, action: 'deleted', from: rec.status, to: 'deleted', user: req.user,
      detail: 'Record deleted',
    });
    res.json({ ok: true });
  } catch(e) { sendError(res, e); }
});

// A training record's history, oldest first. Same visibility rule as the record
// itself -- out of scope reads as "not found". Records created before this log
// existed simply have no events; the record's own fields are still the state.
app.get('/api/training-records/:id/events', auth, async (req, res) => {
  try {
    const { rows: [rec] } = await pool.query(
      `SELECT e.project, e.client FROM training_records t
       LEFT JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`, [req.params.id]
    );
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(req.user, rec.project, rec.client))) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      `SELECT action, from_status, to_status, detail, changed_by_name, changed_at
         FROM training_record_events WHERE training_record_id = $1 ORDER BY changed_at, id`, [req.params.id]
    );
    res.json(rows);
  } catch(e) { sendError(res, e); }
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
  } catch(e) { sendError(res, e); }
});

app.post('/api/admin/backfill-page-access', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const fullPages = ['/','/employees','/audit/new','/history','/ncr','/ppe-tracker','/audits','/requests'];
    const { rowCount } = await pool.query(
      `UPDATE users SET page_access=$1, updated_at=NOW()
       WHERE role <> 'admin' AND (page_access IS NULL OR page_access = '{}')`,
      [fullPages]
    );
    res.json({ success: true, updated: rowCount });
  } catch(e) { sendError(res, e); }
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
  } catch(e) { await client.query('ROLLBACK'); sendError(res, e); }
  finally { client.release(); }
});


// ── Email / Resend ────────────────────────────────────────────
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Plain, personal-style email — no logo, no card, no button. Reads like a normal
// message a person would type. `inner` is the body HTML (<p>/<ul> etc.).
const FONT = "'Century Gothic', CenturyGothic, 'Apple Gothic', AppleGothic, 'URW Gothic', 'Avant Garde', sans-serif";
const mailWrap = (inner) => `<div style="font-family: ${FONT}; font-size: 11pt; font-weight: 400; line-height: 1.6; color: #222; max-width: 640px;">${inner}</div>`;
const MAIL_SIGNOFF = `<p style="margin-top: 16px;">Thanks,<br/>Maged Ezzat</p>`;
// "N days" with the number in red when it's been waiting (> 0 days), as before.
const redDays = (n) => `<span style="color:${n > 0 ? '#e53e3e' : 'inherit'};font-weight:600">${n} day${n !== 1 ? 's' : ''}</span>`;

// Unified "Casual Resources Updates" email — one table row per (action, project, client, actor)
// group. Shared by the casual batch-add and reactivate endpoints. `groups` is an array of
// { action: 'added' | 'reactivated', project, client, count, by }.
const CASUAL_ACTION_TAG = {
  added:       `<span style="background:#e6f4ea;color:#1d9e75;font-size:9pt;font-weight:700;padding:2px 8px;border-radius:10px;">ADDED</span>`,
  reactivated: `<span style="background:#eef2ff;color:#3730a3;font-size:9pt;font-weight:700;padding:2px 8px;border-radius:10px;">REACTIVATED</span>`,
};
function renderCasualUpdateTable(groups) {
  const rank = { added: 0, reactivated: 1 };
  const sorted = [...groups].sort((a, b) =>
    (rank[a.action] - rank[b.action]) || String(a.project || '').localeCompare(String(b.project || '')));
  const rows = sorted.map(g => `
    <tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">${CASUAL_ACTION_TAG[g.action] || escapeHtml(g.action)}</td>
      <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">
        <div style="font-weight:600;color:#111;">${escapeHtml(g.project || '—')}</div>
        <div style="color:#9ca3af;font-size:9pt;">${escapeHtml(g.client || '—')}</div>
      </td>
      <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;text-align:center;font-weight:700;color:#0f2a4a;vertical-align:top;">${g.count}</td>
      <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">
        ${escapeHtml(g.by || '—')}
        <div style="color:#9ca3af;font-size:9pt;">${escapeHtml(g.date || '')}</div>
      </td>
    </tr>`).join('');
  return mailWrap(`
      <p>Hello Team,</p>
      <p>Please find below casual resources records updates:</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:white;margin:8px 0 12px;font-family:${FONT};">
        <tr style="background:#f3f4f6;">
          <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Action</th>
          <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Project / Client</th>
          <th align="center" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Count</th>
          <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">By</th>
        </tr>
        ${rows}
      </table>
      ${MAIL_SIGNOFF}
  `);
}

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
    // Only email when something has actually been waiting (more than 0 days).
    if (oldestDays <= 0 && orderedOldestDays <= 0) return;

    await resend.emails.send({
        from: 'OneHub <esat@egypro.app>',
        to: 'e.maged@outlook.com',
        subject: `OneHub Daily SCM — ${count + orderedCount} Pending PPE/Tool Item${(count + orderedCount) > 1 ? 's' : ''} Awaiting Action`,
        html: mailWrap(`
          <p>Hello Supply Chain Team,</p>
          <ul>
            ${count > 0 ? `<li>We have <strong>${count} pending PPE/Tool item${count > 1 ? 's' : ''}</strong> to be ordered or to confirm availability. The oldest item has been waiting for ${redDays(oldestDays)}.</li>` : ''}
            ${orderedCount > 0 ? `<li>And our Suppliers have <strong>${orderedCount} pending PPE/Tool item${orderedCount > 1 ? 's' : ''}</strong> to be delivered to our warehouse. The oldest item has been waiting for ${redDays(orderedOldestDays)}.</li>` : ''}
          </ul>
          <p>Please check the OneHub system to clear the pending list.</p>
          ${MAIL_SIGNOFF}
        `)
      });
    console.log('SCM digest sent — ' + count + ' pending, ' + orderedCount + ' ordered');
  } catch(e) {
    console.error('SCM digest error:', e.message);
  }
}


async function sendDailyPMDigest() {
  try {
    const { rows: pending } = await pool.query(`
      SELECT COUNT(*) as count, MAX(CURRENT_DATE - r.date_purchase_requested::date) as oldest_days
      FROM ppe_requests r
      JOIN ppe_items p ON p.id = r.ppe_item_id
      LEFT JOIN employees e ON e.id = r.employee_id
      LEFT JOIN casuals c ON c.id = r.casual_id
      WHERE r.status = 'ehs_purchase_requested' AND ppe_needs_pda(p.id, COALESCE(e.project, c.project)) AND r.pda_approved_date IS NULL
    `);
    const count = parseInt(pending[0].count);
    const oldestDays = parseInt(pending[0].oldest_days) || 0;
    if (count === 0) return;
    // Only email when something has actually been waiting (more than 0 days).
    if (oldestDays <= 0) return;

    await resend.emails.send({
        from: 'OneHub <esat@egypro.app>',
        to: 'e.maged@outlook.com',
        subject: `OneHub Daily PM — ${count} Pending PPE/Tool Item${count > 1 ? 's' : ''} Awaiting Your Approval`,
        html: mailWrap(`
          <p>Hello Isaac,</p>
          <p>We have <strong>${count} pending PPE/Tool item${count > 1 ? 's' : ''}</strong> that require your approval. The oldest item has been waiting for ${redDays(oldestDays)}.</p>
          <p>Please check the OneHub system to clear the pending list.</p>
          ${MAIL_SIGNOFF}
        `)
      });
    console.log('PM digest sent — ' + count + ' pending');
  } catch(e) {
    console.error('PM digest error:', e.message);
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
    // Only email when something has actually been waiting (more than 0 days).
    if (oldestDays <= 0) return;
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
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-family: ${FONT}; font-size: 11pt; color: #374151;">${escapeHtml(p.project)}${p.client ? `<div style="font-family: ${FONT}; font-size: 9pt; color: #9ca3af; margin-top: 2px;">${escapeHtml(p.client)}</div>` : ''}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-family: ${FONT}; font-size: 11pt; color: #0f2a4a; font-weight: 600; text-align: center;">${p.count}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-family: ${FONT}; font-size: 11pt; text-align: center; color: ${parseInt(p.oldest_days) > 0 ? '#e53e3e' : '#374151'};">${parseInt(p.oldest_days) || 0}</td>
      </tr>`).join('');

    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Daily BTS Projects — ${count} Pending PPE/Tool Item${count > 1 ? 's' : ''} Awaiting Action`,
      html: mailWrap(`
          <p>Hello BTS Project Team,</p>
          <p>We have <strong>${count} available PPE/Tool item${count > 1 ? 's' : ''}</strong> at our warehouse to be collected. The oldest item has been waiting for ${redDays(oldestDays)}:</p>
          <table cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin: 8px 0 12px; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; font-family: ${FONT};">
            <tr style="background: #f3f4f6;">
              <th style="padding: 8px 12px; text-align: left; font-family: ${FONT}; font-size: 10pt; color: #6b7280; text-transform: uppercase;">Project</th>
              <th style="padding: 8px 12px; text-align: center; font-family: ${FONT}; font-size: 10pt; color: #6b7280; text-transform: uppercase;">Items</th>
              <th style="padding: 8px 12px; text-align: center; font-family: ${FONT}; font-size: 10pt; color: #6b7280; text-transform: uppercase;">Oldest (days)</th>
            </tr>
            ${projectRowsHtml}
          </table>
          <p>Please check the OneHub system to clear the pending list.</p>
          ${MAIL_SIGNOFF}
        `)
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
    // Only email when something has actually been waiting (more than 0 days).
    if (oldestDays <= 0) return;
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
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-family: ${FONT}; font-size: 11pt; color: #374151;">${escapeHtml(p.project)}${p.client ? `<div style="font-family: ${FONT}; font-size: 9pt; color: #9ca3af; margin-top: 2px;">${escapeHtml(p.client)}</div>` : ''}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-family: ${FONT}; font-size: 11pt; color: #0f2a4a; font-weight: 600; text-align: center;">${p.count}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-family: ${FONT}; font-size: 11pt; text-align: center; color: ${parseInt(p.oldest_days) > 0 ? '#e53e3e' : '#374151'};">${parseInt(p.oldest_days) || 0}</td>
      </tr>`).join('');

    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Daily Fibre Projects — ${count} Pending PPE/Tool Item${count > 1 ? 's' : ''} Awaiting Action`,
      html: mailWrap(`
          <p>Hello Fibre Project Team,</p>
          <p>We have <strong>${count} available PPE/Tool item${count > 1 ? 's' : ''}</strong> at our warehouse to be collected. The oldest item has been waiting for ${redDays(oldestDays)}:</p>
          <table cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin: 8px 0 12px; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; font-family: ${FONT};">
            <tr style="background: #f3f4f6;">
              <th style="padding: 8px 12px; text-align: left; font-family: ${FONT}; font-size: 10pt; color: #6b7280; text-transform: uppercase;">Project</th>
              <th style="padding: 8px 12px; text-align: center; font-family: ${FONT}; font-size: 10pt; color: #6b7280; text-transform: uppercase;">Items</th>
              <th style="padding: 8px 12px; text-align: center; font-family: ${FONT}; font-size: 10pt; color: #6b7280; text-transform: uppercase;">Oldest (days)</th>
            </tr>
            ${projectRowsHtml}
          </table>
          <p>Please check the OneHub system to clear the pending list.</p>
          ${MAIL_SIGNOFF}
        `)
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
    // Only email when something has actually been waiting (more than 0 days).
    if (oldestDays <= 0) return;

    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Daily EHS — ${count} Pending PPE/Tool Item${count > 1 ? 's' : ''} Awaiting Action`,
      html: mailWrap(`
          <p>Hello John,</p>
          <p>We have <strong>${count} pending PPE/Tool item${count > 1 ? 's' : ''}</strong> that require a purchase request. The oldest item has been waiting for ${redDays(oldestDays)}.</p>
          <p>Please check the OneHub system to clear the pending list.</p>
          ${MAIL_SIGNOFF}
        `)
    });
    console.log('EHS digest sent — ' + count + ' pending items');
  } catch(e) {
    console.error('EHS digest error:', e.message);
  }
}

// Schedule daily digests
// "What changed yesterday" — emailed each morning. Reads the append-only
// employee_change_log for the previous calendar day (Africa/Nairobi) so early-
// morning edits from yesterday aren't missed by a naive last-24h window.
// Shared body for the employee-change digests (in-house + outsourced fleet drivers).
// `intro` is the sentence shown after "Hello Team,"; `rows` are change_log rows joined
// to the employee's current org/project/client. Layout is identical across both digests.
function renderEmployeeChangesEmail(intro, rows) {
  const actionTag = (a) => a === 'exit'
    ? '<span style="background:#fde8e8;color:#c0392b;font-size:9pt;font-weight:700;padding:2px 8px;border-radius:10px;">EXIT</span>'
    : a === 'reactivate'
    ? '<span style="background:#e6f4ea;color:#1d9e75;font-size:9pt;font-weight:700;padding:2px 8px;border-radius:10px;">REACTIVATE</span>'
    : a === 'add'
    ? '<span style="background:#e6f4ea;color:#1d9e75;font-size:9pt;font-weight:700;padding:2px 8px;border-radius:10px;">ONBOARDED</span>'
    : '<span style="background:#eef2ff;color:#3730a3;font-size:9pt;font-weight:700;padding:2px 8px;border-radius:10px;">UPDATE</span>';

  // Prefer the current value on the employee record (which already reflects a change
  // that was applied yesterday); fall back to the change's "after" value for rows whose
  // employee was since deleted (employee_id → NULL, so the join yields nothing).
  const changeAfter = (r, field) => { const c = (r.changes || []).find(x => x.field === field); return c ? (c.after ?? null) : null; };
  let tableRows = '';
  rows.forEach(r => {
    const when = new Date(r.changed_at).toLocaleDateString('en-GB', { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short' });
    const org  = r.current_org     || changeAfter(r, 'Organization') || '—';
    const proj = r.current_project || changeAfter(r, 'Project')      || '—';
    const cli  = r.current_client  || changeAfter(r, 'Client')       || '—';
    // For an onboard (add) there is no before→after — just show the onboarding details (Project/Client).
    const diffs = (r.changes || []).map(c => r.action === 'add'
      ? `<div style="margin:1px 0;"><b>${escapeHtml(c.field)}:</b> <span style="color:#0f2a4a;font-weight:600;">${escapeHtml(String(c.after ?? '—'))}</span></div>`
      : `<div style="margin:1px 0;"><b>${escapeHtml(c.field)}:</b> <span style="color:#9ca3af;text-decoration:line-through;">${escapeHtml(String(c.before ?? '—'))}</span> &rarr; <span style="color:#0f2a4a;font-weight:600;">${escapeHtml(String(c.after ?? '—'))}</span></div>`
    ).join('');
    tableRows += `
      <tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">
          <div style="font-weight:600;color:#111;">${escapeHtml(r.employee_name || '—')}</div>
          <div style="color:#9ca3af;font-size:9pt;">${escapeHtml(r.national_id || r.employee_number || '')}</div>
        </td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">${escapeHtml(org)}</td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">
          <div style="font-weight:600;color:#111;">${escapeHtml(proj)}</div>
          <div style="color:#9ca3af;font-size:9pt;">${escapeHtml(cli)}</div>
        </td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">${actionTag(r.action)}<div style="margin-top:4px;">${diffs}</div></td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;white-space:nowrap;">${escapeHtml(r.changed_by_name || '—')}<div style="color:#9ca3af;font-size:9pt;">${when}</div></td>
      </tr>`;
  });

  return mailWrap(`
      <p>Hello Team,</p>
      ${intro}
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:white;margin:8px 0 12px;font-family:${FONT};">
        <tr style="background:#f3f4f6;">
          <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Employee</th>
          <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Organization</th>
          <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Current Project / Client</th>
          <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">What changed</th>
          <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">By / When</th>
        </tr>
        ${tableRows}
      </table>
      ${MAIL_SIGNOFF}
  `);
}

async function sendDailyEmployeeChangesDigest() {
  try {
    const { rows } = await pool.query(`
      SELECT l.employee_name, l.national_id, l.employee_number, l.action, l.reason, l.changes, l.changed_by_name, l.changed_at,
             e.organization AS current_org, e.project AS current_project, e.client AS current_client
      FROM employee_change_log l
      JOIN employees e ON e.id = l.employee_id
      WHERE l.changed_at >= (date_trunc('day', (now() AT TIME ZONE 'Africa/Nairobi')) - INTERVAL '1 day') AT TIME ZONE 'Africa/Nairobi'
        AND l.changed_at <  (date_trunc('day', (now() AT TIME ZONE 'Africa/Nairobi'))) AT TIME ZONE 'Africa/Nairobi'
        AND LOWER(TRIM(e.organization)) = 'egypro'  -- in-house only
      ORDER BY l.changed_at
    `);
    if (rows.length === 0) return; // nothing changed yesterday — no email

    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Daily HR In-house Updates — ${rows.length} Change${rows.length > 1 ? 's' : ''}`,
      html: renderEmployeeChangesEmail(
        `<p>Please find below our in-house employee records that have been changed yesterday: <strong>${rows.length} change${rows.length > 1 ? 's' : ''}</strong>.</p>`,
        rows)
    });
    console.log('Employee changes digest sent — ' + rows.length + ' changes');
  } catch(e) {
    console.error('Employee changes digest error:', e.message);
  }
}

// Same as the in-house digest, but for outsourced fleet drivers — employees whose
// organization is an outsource entity of type 'vehicle_supplier'.
async function sendDailyFleetDriverChangesDigest() {
  try {
    const { rows } = await pool.query(`
      SELECT l.employee_name, l.national_id, l.employee_number, l.action, l.reason, l.changes, l.changed_by_name, l.changed_at,
             e.organization AS current_org, e.project AS current_project, e.client AS current_client
      FROM employee_change_log l
      JOIN employees e ON e.id = l.employee_id
      JOIN outsource_entities oe ON LOWER(TRIM(oe.name)) = LOWER(TRIM(e.organization))
      WHERE l.changed_at >= (date_trunc('day', (now() AT TIME ZONE 'Africa/Nairobi')) - INTERVAL '1 day') AT TIME ZONE 'Africa/Nairobi'
        AND l.changed_at <  (date_trunc('day', (now() AT TIME ZONE 'Africa/Nairobi'))) AT TIME ZONE 'Africa/Nairobi'
        AND oe.type = 'vehicle_supplier'
      ORDER BY l.changed_at
    `);
    if (rows.length === 0) return; // nothing changed yesterday — no email

    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Daily Fleet Drivers Updates — ${rows.length} Change${rows.length > 1 ? 's' : ''}`,
      html: renderEmployeeChangesEmail(
        `<p>Please find below our outsourced fleet drivers records that have been changed yesterday: <strong>${rows.length} change${rows.length > 1 ? 's' : ''}</strong>.</p>`,
        rows)
    });
    console.log('Fleet drivers changes digest sent — ' + rows.length + ' changes');
  } catch(e) {
    console.error('Fleet drivers changes digest error:', e.message);
  }
}

// Same again, but for outsourced services — organizations that are outsource entities
// of type 'services'.
async function sendDailyOutsourceServicesChangesDigest() {
  try {
    const { rows } = await pool.query(`
      SELECT l.employee_name, l.national_id, l.employee_number, l.action, l.reason, l.changes, l.changed_by_name, l.changed_at,
             e.organization AS current_org, e.project AS current_project, e.client AS current_client
      FROM employee_change_log l
      JOIN employees e ON e.id = l.employee_id
      JOIN outsource_entities oe ON LOWER(TRIM(oe.name)) = LOWER(TRIM(e.organization))
      WHERE l.changed_at >= (date_trunc('day', (now() AT TIME ZONE 'Africa/Nairobi')) - INTERVAL '1 day') AT TIME ZONE 'Africa/Nairobi'
        AND l.changed_at <  (date_trunc('day', (now() AT TIME ZONE 'Africa/Nairobi'))) AT TIME ZONE 'Africa/Nairobi'
        AND oe.type = 'services'
      ORDER BY l.changed_at
    `);
    if (rows.length === 0) return; // nothing changed yesterday — no email

    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Daily Outsourced Services Updates — ${rows.length} Change${rows.length > 1 ? 's' : ''}`,
      html: renderEmployeeChangesEmail(
        `<p>Please find below our outsourced services records that have been changed yesterday: <strong>${rows.length} change${rows.length > 1 ? 's' : ''}</strong>.</p>`,
        rows)
    });
    console.log('Outsourced services changes digest sent — ' + rows.length + ' changes');
  } catch(e) {
    console.error('Outsourced services changes digest error:', e.message);
  }
}

// Daily digest of training certificates recorded yesterday (status flipped to
// 'completed' with recorded_at in yesterday's Africa/Nairobi window). Covers both
// employees and casuals; no records → no email.
async function sendDailyNewCertificatesDigest() {
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(e.full_name, c2.full_name)              AS person_name,
             COALESCE(e.national_id, c2.national_id)          AS national_id,
             e.employee_number,
             co.name                                          AS course_name,
             t.partnership,
             to_char(t.completed_at, 'DD Mon YYYY')           AS completed_label,
             CASE WHEN co.no_expiry THEN NULL
                  WHEN t.expiry_date IS NULL THEN NULL
                  ELSE to_char(t.expiry_date, 'DD Mon YYYY') END AS expiry_label,
             co.no_expiry,
             COALESCE(t.project_at_completion, e.project, c2.project) AS project,
             COALESCE(t.client_at_completion,  e.client,  c2.client) AS client,
             u.full_name                                      AS recorded_by_name,
             to_char((t.recorded_at AT TIME ZONE 'Africa/Nairobi'), 'DD/MM/YYYY') AS recorded_label
      FROM training_records t
      JOIN training_courses co ON co.id = t.course_id
      LEFT JOIN employees e ON e.id = t.employee_id
      LEFT JOIN casuals   c2 ON c2.id = t.casual_id
      LEFT JOIN users     u ON u.id = t.recorded_by
      WHERE t.status = 'completed' AND t.is_deleted IS NOT TRUE
        AND t.recorded_at >= (date_trunc('day', (now() AT TIME ZONE 'Africa/Nairobi')) - INTERVAL '1 day') AT TIME ZONE 'Africa/Nairobi'
        AND t.recorded_at <  (date_trunc('day', (now() AT TIME ZONE 'Africa/Nairobi'))) AT TIME ZONE 'Africa/Nairobi'
      ORDER BY co.name, person_name
    `);
    if (rows.length === 0) return; // nothing recorded yesterday — no email

    const N = rows.length;
    const recordedLabel = rows[0].recorded_label;
    const tableRows = rows.map(r => `
      <tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">
          <div style="font-weight:600;color:#111;">${escapeHtml(r.person_name || '—')}</div>
          <div style="color:#9ca3af;font-size:9pt;">${escapeHtml(r.national_id || r.employee_number || '')}</div>
        </td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">
          <div style="font-weight:600;color:#111;">${escapeHtml(r.course_name || '—')}</div>
          ${r.partnership ? `<div style="color:#9ca3af;font-size:9pt;">${escapeHtml(r.partnership)}</div>` : ''}
        </td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;white-space:nowrap;">
          <div style="color:#111;">${escapeHtml(r.completed_label || '—')}</div>
          <div style="color:#9ca3af;font-size:9pt;">${r.no_expiry ? 'No expiry' : (r.expiry_label ? 'Expires ' + escapeHtml(r.expiry_label) : '—')}</div>
        </td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">
          <div style="font-weight:600;color:#111;">${escapeHtml(r.project || '—')}</div>
          <div style="color:#9ca3af;font-size:9pt;">${escapeHtml(r.client || '—')}</div>
        </td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">${escapeHtml(r.recorded_by_name || '—')}</td>
      </tr>`).join('');

    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Daily New Certificates — ${N} Recorded`,
      html: mailWrap(`
          <p>Hello Egypro Team,</p>
          <p>Outlined below <strong>${N}</strong> new Acquired Certificate${N > 1 ? 's' : ''} ${N > 1 ? 'were' : 'was'} recorded on ${recordedLabel}:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:white;margin:8px 0 12px;font-family:${FONT};">
            <tr style="background:#f3f4f6;">
              <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Employee</th>
              <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Certificate</th>
              <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Completed / Expiry</th>
              <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Project / Client</th>
              <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Recorded By</th>
            </tr>
            ${tableRows}
          </table>
          ${MAIL_SIGNOFF}
        `)
    });
    console.log('New certificates digest sent — ' + N + ' recorded');
  } catch(e) {
    console.error('New certificates digest error:', e.message);
  }
}

// Daily digest of PPE/Tool items distributed to a person by courier yesterday
// (status 'distributed', distribution_method 'courier', date_distributed in
// yesterday's Africa/Nairobi window). Covers employees and casuals; none → no email.
// Projects covered by each courier-distribution digest. Items on other projects appear
// in neither email.
const COURIER_BTS_PROJECTS   = ['Active MS', 'BTS - MS', 'BTS - MS - MK', 'BTS - MS - NE', 'BTS - Rollout', 'Fuel', 'Workshop', 'TI'];
const COURIER_FIBRE_PROJECTS = ['FTTX Rollout', 'Fibre Home', 'Fibre MS', 'Fibre Rollout'];

// One courier-distribution digest for a named project group (e.g. "BTS" / "Fibre"):
// PPE/Tool items distributed by courier yesterday whose person's project is in `projects`.
async function sendCourierDigest(label, projects) {
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(e.full_name, c.full_name)     AS person_name,
             COALESCE(e.national_id, c.national_id) AS national_id,
             e.employee_number,
             pi.name                                AS item_name,
             pr.size_value,
             COALESCE(e.project, c.project)         AS project,
             COALESCE(e.client,  c.client)          AS client,
             pr.courier_tracking_number,
             u.full_name                            AS distributed_by_name,
             to_char((pr.date_distributed AT TIME ZONE 'Africa/Nairobi'), 'DD Mon, HH24:MI') AS distributed_label,
             to_char((pr.date_distributed AT TIME ZONE 'Africa/Nairobi'), 'DD/MM/YYYY')       AS date_label
      FROM ppe_requests pr
      JOIN ppe_items pi ON pi.id = pr.ppe_item_id
      LEFT JOIN employees e ON e.id = pr.employee_id
      LEFT JOIN casuals   c ON c.id = pr.casual_id
      LEFT JOIN users     u ON u.id = pr.distributed_by
      WHERE pr.status = 'distributed' AND pr.distribution_method = 'courier'
        AND pr.date_distributed >= (date_trunc('day', (now() AT TIME ZONE 'Africa/Nairobi')) - INTERVAL '1 day') AT TIME ZONE 'Africa/Nairobi'
        AND pr.date_distributed <  (date_trunc('day', (now() AT TIME ZONE 'Africa/Nairobi'))) AT TIME ZONE 'Africa/Nairobi'
        AND COALESCE(e.project, c.project) = ANY($1)
      ORDER BY person_name, pi.name
    `, [projects]);
    if (rows.length === 0) return; // nothing distributed by courier yesterday for this group — no email

    const N = rows.length;
    const dateLabel = rows[0].date_label;
    const tableRows = rows.map(r => `
      <tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">
          <div style="color:#111;">${escapeHtml(r.person_name || '—')}</div>
          <div style="color:#9ca3af;font-size:9pt;">${escapeHtml(r.national_id || r.employee_number || '')}</div>
        </td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">
          <div style="color:#111;">${escapeHtml(r.item_name || '—')}</div>
          ${r.size_value ? `<div style="color:#9ca3af;font-size:9pt;">Size: ${escapeHtml(r.size_value)}</div>` : ''}
        </td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">
          <div style="color:#111;">${escapeHtml(r.project || '—')}</div>
          <div style="color:#9ca3af;font-size:9pt;">${escapeHtml(r.client || '—')}</div>
        </td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;">${escapeHtml(r.courier_tracking_number || '—')}</td>
        <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;vertical-align:top;white-space:nowrap;">${escapeHtml(r.distributed_by_name || '—')}<div style="color:#9ca3af;font-size:9pt;">${escapeHtml(r.distributed_label || '')}</div></td>
      </tr>`).join('');

    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Daily ${label} Courier Distributions — ${N} Item${N > 1 ? 's' : ''}`,
      html: mailWrap(`
          <p>Hello Team,</p>
          <p>Outlined below <strong>${N}</strong> PPE/Tool item${N > 1 ? 's' : ''} ${N > 1 ? 'were' : 'was'} distributed to employees by courier on ${dateLabel}:</p>
          <p style="background:#fff8e1;border-left:4px solid #e65100;padding:10px 14px;margin:8px 0;">Please communicate the same to your teams to make sure they have confirmed receipt of these items. In case there is any issue receiving them, please escalate to our Supply Chain department.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:white;margin:8px 0 12px;font-family:${FONT};">
            <tr style="background:#f3f4f6;">
              <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Employee</th>
              <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Item</th>
              <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Project / Client</th>
              <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Courier Tracking #</th>
              <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:10pt;color:#6b7280;text-transform:uppercase;">Distributed By</th>
            </tr>
            ${tableRows}
          </table>
          ${MAIL_SIGNOFF}
        `)
    });
    console.log(label + ' courier distributions digest sent — ' + N + ' items');
  } catch(e) {
    console.error(label + ' courier distributions digest error:', e.message);
  }
}

async function sendDailyCourierDistributionDigest() {
  await sendCourierDigest('BTS', COURIER_BTS_PROJECTS);
  await sendCourierDigest('Fibre', COURIER_FIBRE_PROJECTS);
}

// Hourly digest of casual add/reactivate events from the previous clock hour. Groups by
// action + project/client + who did it; no events in that hour → no email.
async function sendHourlyCasualDigest() {
  try {
    const { rows } = await pool.query(`
      SELECT action, project, client, actor_name,
             COUNT(*)::int AS count,
             to_char(MAX(created_at) AT TIME ZONE 'Africa/Nairobi', 'DD Mon YYYY') AS last_date
      FROM casual_events
      WHERE created_at >= date_trunc('hour', now()) - interval '1 hour'
        AND created_at <  date_trunc('hour', now())
      GROUP BY action, project, client, actor_name
      ORDER BY action, project, client
    `);
    if (rows.length === 0) return; // nothing happened in the past hour — no email
    const groups = rows.map(r => ({
      action: r.action, project: r.project, client: r.client,
      count: r.count, by: r.actor_name, date: r.last_date,
    }));
    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: 'OneHub Casual Resources Updates',
      html: renderCasualUpdateTable(groups),
    });
    console.log('Casual updates digest sent — ' + rows.reduce((s, r) => s + r.count, 0) + ' event(s)');
  } catch(e) { console.error('Casual updates digest error:', e.message); }
}

function scheduleAt(utcHour, utcMin, label, fn) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(utcHour, utcMin, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next - now;
  console.log(label + ' scheduled in ' + Math.floor(ms/3600000) + 'h ' + Math.floor((ms%3600000)/60000) + 'm');
  setTimeout(() => { fn(); setInterval(fn, 24*60*60*1000); }, ms);
}

// Fire once at the next occurrence of the given UTC weekday+time (0=Sun..6=Sat), then weekly.
function scheduleWeekly(utcDay, utcHour, utcMin, label, fn) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(utcHour, utcMin, 0, 0);
  let addDays = (utcDay - next.getUTCDay() + 7) % 7;
  if (addDays === 0 && next <= now) addDays = 7;
  next.setUTCDate(next.getUTCDate() + addDays);
  const ms = next - now;
  console.log(label + ' scheduled in ' + Math.floor(ms/86400000) + 'd ' + Math.floor((ms%86400000)/3600000) + 'h ' + Math.floor((ms%3600000)/60000) + 'm');
  setTimeout(() => { fn(); setInterval(fn, 7*24*60*60*1000); }, ms);
}

// Fire at the top of the next hour, then every hour.
function scheduleHourly(label, fn) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  const ms = next - now;
  console.log(label + ' scheduled in ' + Math.floor(ms/60000) + 'm');
  setTimeout(() => { fn(); setInterval(fn, 60*60*1000); }, ms);
}


async function sendDailyOverdueDigest() {
  try {
    const { rows } = await pool.query(`
      SELECT client, project, total, overdue_count, audited_30
      FROM (
        SELECT
          e.client,
          e.project,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE COALESCE(CURRENT_DATE - a.audit_date::date, 9999) > 30) AS overdue_count,
          COUNT(*) FILTER (WHERE COALESCE(CURRENT_DATE - a.audit_date::date, 9999) <= 30) AS audited_30
        FROM employees e
        LEFT JOIN (
          SELECT DISTINCT ON (employee_id) employee_id, audit_date
          FROM audits WHERE employee_present = TRUE ORDER BY employee_id, audit_date DESC
        ) a ON a.employee_id = e.id
        WHERE e.employment_status = 'active' AND e.san = true
        GROUP BY e.client, e.project
      ) sub
      WHERE overdue_count > 0
      ORDER BY client, project
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
    // Fixed client display order; any others fall after, alphabetically.
    const CLIENT_ORDER = ['Safaricom', 'Huawei', 'Zuku', 'ATC', 'Airtel', 'Multiple'];
    const clientRank = (c) => { const i = CLIENT_ORDER.indexOf(c); return i === -1 ? CLIENT_ORDER.length : i; };
    Object.keys(byClient).sort((a, b) => clientRank(a) - clientRank(b) || a.localeCompare(b)).forEach(client => {
      const projects = byClient[client];
      tableRows += `<tr><td colspan="3" style="background:#0f2a4a;color:white;font-weight:700;font-family:${FONT};font-size:11pt;padding:8px 12px;">${escapeHtml(client)}</td></tr>`;
      projects.forEach(r => {
        const total = parseInt(r.total) || 0;
        const rate = total > 0 ? Math.round((parseInt(r.audited_30) || 0) / total * 100) : 0;
        const rateColor = rate >= 80 ? '#1d9e75' : rate >= 50 ? '#e65100' : '#e53e3e';
        tableRows += `
          <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;padding-left:24px;">${escapeHtml(r.project) || '—'}</td>
            <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;text-align:center;font-weight:700;color:#0f2a4a;">${r.overdue_count}</td>
            <td style="padding:8px 12px;font-family:${FONT};font-size:11pt;text-align:center;font-weight:700;color:${rateColor};">${rate}%</td>
          </tr>`;
      });
    });

    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Weekly Audit — ${totalOverdue} Overdue Audit${totalOverdue > 1 ? 's' : ''} Across Projects`,
      html: mailWrap(`
          <p>Hello John,</p>
          <p>Here is this week's overdue audit summary. <strong>${totalOverdue} employee${totalOverdue > 1 ? 's are' : ' is'}</strong> overdue for audit (more than 30 days).</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:white;margin:8px 0 12px;font-family:${FONT};">
            <tr style="background:#f3f4f6;">
              <th style="padding:8px 12px;text-align:left;font-family:${FONT};font-size:10pt;color:#6b7280;font-weight:600;">PROJECT</th>
              <th style="padding:8px 12px;text-align:center;font-family:${FONT};font-size:10pt;color:#6b7280;font-weight:600;">OVERDUE</th>
              <th style="padding:8px 12px;text-align:center;font-family:${FONT};font-size:10pt;color:#6b7280;font-weight:600;">AUDIT RATE</th>
            </tr>
            ${tableRows}
          </table>
          <p style="font-size:9pt;color:#9ca3af;">Audit Rate = share of SAN employees audited in the last 30 days.</p>
          ${MAIL_SIGNOFF}
        `)
    });
    console.log('Overdue digest sent — ' + totalOverdue + ' overdue');
  } catch(e) { console.error('Overdue digest error:', e.message); }
}

async function pruneOldRequestLogs() {
  try {
    const { rowCount } = await pool.query(`DELETE FROM request_logs WHERE created_at < NOW() - INTERVAL '30 days'`);
    console.log(`Pruned ${rowCount} request log(s) older than 30 days`);
  } catch(e) { console.error('Log prune error:', e.message); }
}

function scheduleDailyDigest() {
  scheduleAt(5, 30, 'Fibre digest', sendDailyFibreDigest);  // 8:30am EAT
  scheduleAt(5, 35, 'BTS digest', sendDailyBTSDigest);      // 8:35am EAT
  scheduleAt(5, 40, 'PM digest', sendDailyPMDigest);        // 8:40am EAT
  scheduleAt(5, 45, 'EHS digest', sendDailyEHSDigest);      // 8:45am EAT
  scheduleAt(6,  0, 'SCM digest', sendDailySCMDigest);      // 9:00am EAT
  scheduleWeekly(1, 6, 15, 'Overdue digest', sendDailyOverdueDigest); // Mondays 9:15am EAT
  scheduleAt(5, 15, 'Employee changes digest', sendDailyEmployeeChangesDigest); // 8:15am EAT
  scheduleAt(5, 20, 'Fleet drivers changes digest', sendDailyFleetDriverChangesDigest); // 8:20am EAT
  scheduleAt(5, 25, 'Outsourced services changes digest', sendDailyOutsourceServicesChangesDigest); // 8:25am EAT
  scheduleAt(5, 30, 'New certificates digest', sendDailyNewCertificatesDigest); // 8:30am EAT
  scheduleAt(6, 10, 'Courier distributions digest', sendDailyCourierDistributionDigest); // 9:10am EAT
  scheduleHourly('Casual updates digest', sendHourlyCasualDigest); // top of every hour
  scheduleAt(2,  0, 'Log prune', pruneOldRequestLogs);      // 5:00am EAT
  // Backstop for the mobile-line exit release. The register and Available Lines
  // both sweep on load, so this only matters if nobody opens either screen for a
  // day -- but that is exactly when a released line would go unnoticed.
  scheduleAt(5, 10, 'Mobile line exit release', mobileLines.releaseLinesForExitedEmployees); // 8:10am EAT
}

app.post('/api/admin/test-bts-digest', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await sendDailyBTSDigest();
    res.json({ success: true });
  } catch(e) { sendError(res, e); }
});

app.post('/api/admin/test-pm-digest', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await sendDailyPMDigest();
    res.json({ success: true });
  } catch(e) { sendError(res, e); }
});

app.post('/api/admin/test-fibre-digest', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await sendDailyFibreDigest();
    res.json({ success: true });
  } catch(e) { sendError(res, e); }
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
    if (oldestDays <= 0) return res.json({ success: true, count, oldestDays, message: 'Nothing waiting more than 0 days, email not sent' });
    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Daily EHS — ${count} Pending PPE/Tool Item${count > 1 ? 's' : ''} Awaiting Action`,
      html: mailWrap(`
          <p>Hello John,</p>
          <p>We have <strong>${count} pending PPE/Tool item${count > 1 ? 's' : ''}</strong> that require a purchase request. The oldest item has been waiting for ${redDays(oldestDays)}.</p>
          <p>Please check the OneHub system to clear the pending list.</p>
          ${MAIL_SIGNOFF}
        `)
    });
    res.json({ success: true, count, oldestDays });
  } catch(e) { sendError(res, e); }
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
    if (oldestDays <= 0 && orderedOldestDays <= 0) return res.json({ success: true, count, orderedCount, message: 'Nothing waiting more than 0 days, email not sent' });
    await resend.emails.send({
      from: 'OneHub <esat@egypro.app>',
      to: 'e.maged@outlook.com',
      subject: `OneHub Daily SCM — ${count + orderedCount} Pending PPE/Tool Item${(count + orderedCount) > 1 ? 's' : ''} Awaiting Action`,
      html: mailWrap(`
          <p>Hello Supply Chain Team,</p>
          <ul>
            ${count > 0 ? `<li>We have <strong>${count} pending PPE/Tool item${count > 1 ? 's' : ''}</strong> to be ordered or to confirm availability. The oldest item has been waiting for ${redDays(oldestDays)}.</li>` : ''}
            ${orderedCount > 0 ? `<li>And our Suppliers have <strong>${orderedCount} pending PPE/Tool item${orderedCount > 1 ? 's' : ''}</strong> to be delivered to our warehouse. The oldest item has been waiting for ${redDays(orderedOldestDays)}.</li>` : ''}
          </ul>
          <p>Please check the OneHub system to clear the pending list.</p>
          ${MAIL_SIGNOFF}
        `)
    });
    res.json({ success: true, count, oldestDays, orderedCount, orderedOldestDays });
  } catch(e) { sendError(res, e); }
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
// Training certificates are small scans/PDFs -- cap at 2MB (separate from the
// 10MB audit-document uploader).
const certUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Certificate must be a PDF.'));
  }
});
// National ID documents keep the original 1MB cap.
const idUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 }, // 1MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Document must be a PDF.'));
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

// Training certificates are stored in Cloudflare R2 (S3-compatible object store):
// native PDF support, zero egress, secure via short-lived presigned URLs. The
// bytes are served straight from R2 (we only 302-redirect), so downloads don't
// touch Render's bandwidth. Audit documents stay on Cloudinary.
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { PDFDocument, degrees } = require('pdf-lib');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const R2_BUCKET = process.env.R2_BUCKET;
const R2_CONFIGURED = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && R2_BUCKET);
const r2 = R2_CONFIGURED ? new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
}) : null;
// Keep certificate keys/filenames human-readable, mirroring the SharePoint
// TrainingCertificatesLibrary layout: "<NationalID> - <Name>/<Course>/<Name> (<date>).<ext>".
// Only collapse path-breaking/whitespace chars; spaces and () are fine in S3 keys.
const cleanKeyPart = (s) => String(s || '').replace(/[\\/\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() || '_';
const MIME_EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif' };
const certDateStr = (d) => (d ? new Date(d) : new Date()).toISOString().slice(0, 10);
const certExtFor = (filename, mime) => {
  const e = (String(filename || '').split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return e || MIME_EXT[mime] || 'pdf';
};

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
      const uploadScope = await getAuditScope(audit_id);
      if (!uploadScope || !(await inScope(req.user, uploadScope.project, uploadScope.client))) {
        return res.status(404).json({ message: 'Not found' });
      }

      const safeName = sanitizeForPublicId(employee_name);
      const safeNationalId = sanitizeForPublicId(national_id);
      const safeDate = sanitizeForPublicId(audit_date);
      const safeField = sanitizeForPublicId(field_name);
      const folder = `esat/${safeNationalId}_${safeName}/${safeDate}`;
      const publicId = `${folder}/${safeDate}_${safeName}_${safeField}`;

      // 'authenticated' delivery: the raw Cloudinary URL is useless without a
      // signed, expiring token (generated per-download below) — unlike the old
      // 'upload' type, it can't be accessed just by knowing/guessing the URL.
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { public_id: publicId, overwrite: true, resource_type: 'auto', type: 'authenticated' },
          (error, result) => { if (error) reject(error); else resolve(result); }
        );
        stream.end(req.file.buffer);
      });

      await pool.query(
        `INSERT INTO audit_documents (audit_id, employee_id, field_name, cloudinary_url, cloudinary_public_id, resource_type, delivery_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (audit_id, field_name) DO UPDATE SET cloudinary_url=EXCLUDED.cloudinary_url, cloudinary_public_id=EXCLUDED.cloudinary_public_id, resource_type=EXCLUDED.resource_type, delivery_type=EXCLUDED.delivery_type`,
        [audit_id, employee_id, field_name, result.secure_url, result.public_id, result.resource_type, 'authenticated']
      );

      res.json({ url: result.secure_url, public_id: result.public_id });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ message: 'Upload failed', error: GENERIC_ERROR_MESSAGE });
    }
  });
});


// ── Download / preview Audit Document (redirect — not proxied through Render) ──
// Not using the `auth` middleware here: a plain <img src> (used for inline
// previews) can't send an Authorization header, so the token is also accepted
// as a query param — same reasoning as the /api/events SSE endpoint.
app.get('/api/audit-documents/:id/download', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ message: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (!req.user.sync && req.user.iat < SERVER_BOOT_TIME) {
      return res.status(401).json({ message: 'Session expired, please log in again' });
    }
  } catch {
    return res.status(401).json({ message: 'Invalid token' });
  }

  try {
    const doc = await pool.query('SELECT * FROM audit_documents WHERE id = $1', [req.params.id]);
    if (!doc.rows.length) return res.status(404).json({ message: 'Not found' });
    const row = doc.rows[0];
    const scope = await getAuditScope(row.audit_id);
    if (!scope || !(await inScope(req.user, scope.project, scope.client))) {
      return res.status(404).json({ message: 'Not found' });
    }

    // Inline preview only needs a screen-sized image, not the full original —
    // same fix as the profile-picture/logo bandwidth issue, applied here too.
    // Real downloads (no ?preview) still get the untouched original file.
    const resourceType = row.resource_type || 'image';
    const previewTransform = (req.query.preview && resourceType === 'image')
      ? { width: 1200, crop: 'limit', quality: 'auto', fetch_format: 'auto' }
      : {};

    if (row.delivery_type === 'authenticated') {
      // Short-lived signed URL: valid for 5 minutes, useless to anyone it leaks to afterward.
      const signedUrl = cloudinary.url(row.cloudinary_public_id, {
        type: 'authenticated',
        resource_type: resourceType,
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + 300,
        ...previewTransform,
      });
      return res.redirect(signedUrl);
    }

    // Legacy documents were uploaded under the old public 'upload' type —
    // their URL was never protected by anything beyond this permission check,
    // so redirecting instead of proxying doesn't reduce their security.
    const legacyUrl = Object.keys(previewTransform).length
      ? cloudinary.url(row.cloudinary_public_id, { resource_type: resourceType, ...previewTransform })
      : row.cloudinary_url;
    res.redirect(legacyUrl);
  } catch (err) {
    res.status(500).json({ message: 'Download failed' });
  }
});

// ── Get Audit Documents ──────────────────────────────────────
app.get('/api/audit-documents/:audit_id', auth, async (req, res) => {
  try {
    const scope = await getAuditScope(req.params.audit_id);
    if (!scope || !(await inScope(req.user, scope.project, scope.client))) {
      return res.status(404).json({ message: 'Not found' });
    }
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
    const scope = await getAuditScope(doc.rows[0].audit_id);
    if (!scope || !(await inScope(req.user, scope.project, scope.client))) {
      return res.status(404).json({ message: 'Not found' });
    }
    await cloudinary.uploader.destroy(doc.rows[0].cloudinary_public_id, {
      resource_type: doc.rows[0].resource_type || 'image',
      type: doc.rows[0].delivery_type || 'upload',
    });
    await pool.query(`DELETE FROM audit_documents WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Delete failed' });
  }
});

// ── Training certificate: upload / download / remove ─────────
// Reuses the same Cloudinary account + 'authenticated' delivery as audit docs.
// Loads a training record with everything the three handlers need.
const loadTrainingRecordForCert = (id) => pool.query(
  `SELECT t.id, t.employee_id, t.course_id, t.cloudinary_public_id, t.certificate_url,
          t.resource_type, t.delivery_type, t.original_filename, t.completed_at,
          c.name AS course_name, e.full_name AS employee_name, e.national_id, e.project, e.client
     FROM training_records t
     JOIN training_courses c ON c.id = t.course_id
     LEFT JOIN employees e ON e.id = t.employee_id
    WHERE t.id = $1 AND t.is_deleted IS NOT TRUE`, [id]);

app.post('/api/training-records/:id/certificate', auth, (req, res) => {
  certUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Certificate must be 2MB or smaller.' : (err.message || 'Upload rejected') });
    if (!TRAINING_UPDATE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized to update training records' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!R2_CONFIGURED) return res.status(503).json({ error: 'Certificate storage is not configured yet.' });
    try {
      const { rows: [rec] } = await loadTrainingRecordForCert(req.params.id);
      if (!rec || !rec.employee_id) return res.status(404).json({ error: 'Not found' });
      if (!(await inScope(req.user, rec.project, rec.client))) return res.status(404).json({ error: 'Not found' });
      if (!(await canManageCourse(req.user, rec.course_id))) return res.status(403).json({ error: `You are not assigned to manage "${rec.course_name}".` });

      // Mirror the SharePoint layout: <NationalID> - <Name>/<Course>/<Name> (<date>).<ext>
      const ext = certExtFor(req.file.originalname, req.file.mimetype);
      const person = `${cleanKeyPart(rec.national_id)} - ${cleanKeyPart(rec.employee_name)}`;
      const base = `${person}/${cleanKeyPart(rec.course_name)}/${cleanKeyPart(rec.employee_name)} (${certDateStr(rec.completed_at)})`;
      let key = `${base}.${ext}`;
      // Same person+course+date on two different records is rare but possible;
      // append a short id so one never silently overwrites the other.
      const clash = await pool.query(
        `SELECT 1 FROM training_records WHERE cloudinary_public_id = $1 AND id <> $2 AND is_deleted IS NOT TRUE LIMIT 1`,
        [key, rec.id]);
      if (clash.rows.length) key = `${base} [${rec.id.slice(0, 8)}].${ext}`;
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype,
      }));
      // A replacement may land under a different key (extension changed); remove the
      // old object so it doesn't orphan.
      if (rec.cloudinary_public_id && rec.cloudinary_public_id !== key) {
        r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: rec.cloudinary_public_id })).catch(() => {});
      }
      // Reuse the existing columns: cloudinary_public_id = R2 object key,
      // resource_type = MIME type, delivery_type = 'r2'.
      await pool.query(
        `UPDATE training_records SET certificate_url=NULL, cloudinary_public_id=$1, resource_type=$2, delivery_type='r2', original_filename=$3, updated_at=NOW() WHERE id=$4`,
        [key, req.file.mimetype, req.file.originalname, rec.id]
      );
      res.json({ key, original_filename: req.file.originalname });
    } catch (e) {
      console.error('Certificate upload error:', e.message);
      res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
    }
  });
});

// Stream the certificate THROUGH the backend (not a redirect), so the R2
// presigned URL -- which exposes the account id, access-key id, and the
// employee's name/national-id in the object path -- is never seen by the
// browser. The browser only ever sees this endpoint (a record UUID + token).
// Token via header OR ?token= so a plain <img>/new-tab navigation works.
app.get('/api/training-records/:id/certificate/download', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (!req.user.sync && req.user.iat < SERVER_BOOT_TIME) return res.status(401).json({ error: 'Session expired, please log in again' });
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
  try {
    if (!R2_CONFIGURED) return res.status(503).json({ error: 'Certificate storage is not configured yet.' });
    const { rows: [rec] } = await loadTrainingRecordForCert(req.params.id);
    if (!rec || !rec.cloudinary_public_id) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(req.user, rec.project, rec.client))) return res.status(404).json({ error: 'Not found' });
    // Preview → inline (renders in <img>/PDF viewer); otherwise a named download
    // matching the SharePoint convention: "<Name> (<completion date>).<ext>".
    const ext = certExtFor(rec.cloudinary_public_id, rec.resource_type);
    const dlName = `${cleanKeyPart(rec.employee_name)} (${certDateStr(rec.completed_at)}).${ext}`;
    const asciiName = dlName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const disposition = req.query.preview
      ? 'inline'
      : `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(dlName)}`;
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: rec.cloudinary_public_id }));
    res.setHeader('Content-Type', rec.resource_type || obj.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Cache-Control', 'private, no-store');
    if (obj.ContentLength != null) res.setHeader('Content-Length', obj.ContentLength);
    obj.Body.on('error', () => { res.destroy(); });
    res.on('close', () => { try { obj.Body.destroy(); } catch { /* already closed */ } });
    obj.Body.pipe(res);
  } catch (e) {
    if (e.name === 'NoSuchKey') return res.status(404).json({ error: 'Not found' });
    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
  }
});

// Rotate a (PDF) certificate 90° and save it back to R2 under the SAME key, so the
// record stays linked and every viewer sees the corrected orientation. ?dir=ccw
// for counter-clockwise; default clockwise. Same auth/course-access as upload.
app.post('/api/training-records/:id/certificate/rotate', auth, async (req, res) => {
  if (!TRAINING_UPDATE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized to update training records' });
  if (!R2_CONFIGURED) return res.status(503).json({ error: 'Certificate storage is not configured yet.' });
  try {
    const { rows: [rec] } = await loadTrainingRecordForCert(req.params.id);
    if (!rec || !rec.cloudinary_public_id) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(req.user, rec.project, rec.client))) return res.status(404).json({ error: 'Not found' });
    if (!(await canManageCourse(req.user, rec.course_id))) return res.status(403).json({ error: `You are not assigned to manage "${rec.course_name}".` });
    const isPdf = (rec.resource_type === 'application/pdf') || /\.pdf$/i.test(rec.cloudinary_public_id);
    if (!isPdf) return res.status(400).json({ error: 'Only PDF certificates can be rotated.' });
    const step = req.query.dir === 'ccw' ? -90 : 90;
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: rec.cloudinary_public_id }));
    const pdf = await PDFDocument.load(await obj.Body.transformToByteArray());
    for (const page of pdf.getPages()) page.setRotation(degrees(((page.getRotation().angle + step) % 360 + 360) % 360));
    const out = await pdf.save();
    await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: rec.cloudinary_public_id, Body: Buffer.from(out), ContentType: 'application/pdf' }));
    res.json({ ok: true });
  } catch (e) {
    console.error('Certificate rotate error:', e.message);
    res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
  }
});

app.delete('/api/training-records/:id/certificate', auth, async (req, res) => {
  if (!TRAINING_UPDATE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Not authorized to update training records' });
  try {
    const { rows: [rec] } = await loadTrainingRecordForCert(req.params.id);
    if (!rec || !rec.employee_id) return res.status(404).json({ error: 'Not found' });
    if (!(await inScope(req.user, rec.project, rec.client))) return res.status(404).json({ error: 'Not found' });
    if (!(await canManageCourse(req.user, rec.course_id))) return res.status(403).json({ error: `You are not assigned to manage "${rec.course_name}".` });
    if (rec.cloudinary_public_id && r2) {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: rec.cloudinary_public_id })).catch(() => {});
    }
    await pool.query(`UPDATE training_records SET certificate_url=NULL, cloudinary_public_id=NULL, resource_type=NULL, delivery_type=NULL, original_filename=NULL, updated_at=NOW() WHERE id=$1`, [rec.id]);
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

// Add an employee manually (admin, hr) WITH a mandatory National ID PDF, stored
// in R2 in the same employee folder as the training certs, "National ID" subfolder:
//   "<NationalID> - <Name>/National ID/<Name> - National ID.pdf"
// Separate from POST /employees (which stays JSON for CSV import) because this one
// is multipart and must live after the R2 client is defined.
app.post('/api/employees/manual', auth, (req, res) => {
  idUpload.single('national_id_doc')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'National ID file must be 1MB or smaller.' : (err.message || 'Upload rejected') });
    if (!R2_CONFIGURED) return res.status(503).json({ error: 'Document storage is not configured yet.' });
    if (!req.file) return res.status(400).json({ error: 'National ID document (PDF) is required' });
    let { full_name, national_id, employee_number, job_title, department, project, client, organization, resource_type } = req.body;
    resource_type = (resource_type || '').toLowerCase();
    if (!['inhouse', 'intern', 'outsource'].includes(resource_type)) return res.status(400).json({ error: 'Invalid resource type' });
    const required = { full_name: 'Resource Name', national_id: 'National ID Number', department: 'Department', project: 'Project Name', client: 'Client', job_title: 'Job Title', organization: 'Organization' };
    for (const k in required) { if (!String(req.body[k] || '').trim()) return res.status(400).json({ error: `${required[k]} is required` }); }
    // Authorize: HR with add_employee may add anyone; an outsource subtype-manager
    // may add only an outsource resource whose organization maps to their subtype.
    if (resource_type === 'outsource') {
      const sub = await outsourceSubtypeOfOrg(organization);
      if (!sub) return res.status(400).json({ error: 'That organization is not a registered outsource entity. Add it in Admin → Outsource Entities first.' });
      if (!(await hasOutsourceAccess(req.user, sub) || await hasHrTask(req.user, 'add_employee'))) return res.status(403).json({ error: 'Not authorized' });
    } else {
      if (!(await hasHrTask(req.user, 'add_employee'))) return res.status(403).json({ error: 'Not authorized' });
    }
    // Only in-house employees carry an Employment ID; interns/outsource have none.
    const empNo = resource_type === 'inhouse' ? String(employee_number || '').trim() : null;
    if (resource_type === 'inhouse' && !empNo) return res.status(400).json({ error: 'Employment ID is required' });
    try {
      // A manual add must be a genuinely new person — no silent upsert here.
      // National ID must be unique across ALL resources (employees + casuals).
      const conflict = await nationalIdConflict(national_id.trim());
      if (conflict) return res.status(409).json({ error: `This National ID already belongs to ${conflict}.` });
      if (empNo) {
        const dupNo = await pool.query('SELECT id FROM employees WHERE employee_number=$1', [empNo]);
        if (dupNo.rows.length) return res.status(409).json({ error: 'This Employment ID is already in use.' });
      }

      const person = `${cleanKeyPart(national_id)} - ${cleanKeyPart(full_name)}`;
      const key = `${person}/National ID/${cleanKeyPart(full_name)} - National ID.pdf`;
      await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: req.file.buffer, ContentType: 'application/pdf' }));
      try {
        const { rows } = await pool.query(
          `INSERT INTO employees (employee_number, full_name, national_id, job_title, department, project, client, organization, resource_type, employment_status, created_by, national_id_doc_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11) RETURNING *`,
          [empNo, full_name.trim(), national_id.trim(), job_title.trim(), department.trim(), project.trim(), client.trim(), organization.trim(), resource_type, req.user.id, key]
        );
        // Record the onboarding in the employee history so it shows in the daily HR digest.
        const emp = rows[0];
        await pool.query(
          `INSERT INTO employee_change_log (employee_id, employee_name, national_id, employee_number, action, reason, changes, changed_by, changed_by_name)
           VALUES ($1,$2,$3,$4,'add',NULL,$5::jsonb,$6,$7)`,
          [emp.id, emp.full_name, emp.national_id, emp.employee_number, JSON.stringify([{ field: 'Project', after: emp.project }, { field: 'Client', after: emp.client }]), req.user.id, req.user.name || null]
        ).catch(e2 => console.error('onboard change-log error:', e2.message));
        broadcastEmployeesChanged();
        res.status(201).json(rows[0]);
      } catch (e) {
        r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })).catch(() => {}); // don't orphan the upload
        if (e.code === '23505') return res.status(409).json({ error: 'Employment ID or National ID already exists.' });
        throw e;
      }
    } catch (e) {
      console.error('Manual employee add error:', e.message);
      res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
    }
  });
});

// Stream an employee's National ID document through the backend (the R2 URL is
// never exposed). Token via header OR ?token=. admin/hr only.
app.get('/api/employees/:id/national-id/download', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (!req.user.sync && req.user.iat < SERVER_BOOT_TIME) return res.status(401).json({ error: 'Session expired, please log in again' });
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
  if (!['admin', 'hr'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  try {
    if (!R2_CONFIGURED) return res.status(503).json({ error: 'Document storage is not configured yet.' });
    const { rows: [emp] } = await pool.query('SELECT full_name, national_id_doc_key FROM employees WHERE id=$1', [req.params.id]);
    if (!emp || !emp.national_id_doc_key) return res.status(404).json({ error: 'Not found' });
    const dlName = `${cleanKeyPart(emp.full_name)} - National ID.pdf`;
    const asciiName = dlName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const disposition = req.query.preview ? 'inline' : `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(dlName)}`;
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: emp.national_id_doc_key }));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Cache-Control', 'private, no-store');
    if (obj.ContentLength != null) res.setHeader('Content-Length', obj.ContentLength);
    obj.Body.on('error', () => { res.destroy(); });
    res.on('close', () => { try { obj.Body.destroy(); } catch { /* closed */ } });
    obj.Body.pipe(res);
  } catch (e) {
    if (e.name === 'NoSuchKey') return res.status(404).json({ error: 'Not found' });
    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
  }
});

app.post('/api/admin/test-overdue-digest', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await sendDailyOverdueDigest();
    res.json({ success: true });
  } catch(e) { sendError(res, e); }
});

app.listen(PORT, () => {
  console.log(`ESAT running on port ${PORT}`);
  scheduleDailyDigest();
  // Open renewal requests for anything already expired at boot, then daily.
  ensureRenewalRequests().catch(e => console.error('ensureRenewalRequests (boot):', e.message));
  setInterval(() => ensureRenewalRequests().catch(e => console.error('ensureRenewalRequests (daily):', e.message)), 24 * 60 * 60 * 1000);
});
});

// ── User Management Routes ───────────────────────────────────

// GET all users (admin only)

app.get('/api/graphs', auth, async (req, res) => {
  try {
    const graphProjects = await getProjectFilter(req.user);
    const graphClients = await getClientFilter(req.user);
    const requestedProjects = String(req.query.project || '').split(',').map(s => s.trim()).filter(Boolean);
    const requestedClients = String(req.query.client || '').split(',').map(s => s.trim()).filter(Boolean);

    if (requestedProjects.length && graphProjects !== null && !requestedProjects.every(p => graphProjects.includes(p))) {
      return res.status(403).json({ error: 'Project is outside your permitted access' });
    }
    if (requestedClients.length && graphClients !== null && !requestedClients.every(c => graphClients.includes(c))) {
      return res.status(403).json({ error: 'Client is outside your permitted access' });
    }

    const scopeParams = [];
    const scopeConditions = [];
    if (requestedProjects.length) {
      scopeParams.push(requestedProjects);
      scopeConditions.push(`COALESCE(e.project, c.project) = ANY($${scopeParams.length}::text[])`);
    } else if (graphProjects !== null) {
      scopeParams.push(graphProjects);
      scopeConditions.push(`COALESCE(e.project, c.project) = ANY($${scopeParams.length}::text[])`);
    }
    if (requestedClients.length) {
      scopeParams.push(requestedClients);
      scopeConditions.push(`COALESCE(e.client, c.client) = ANY($${scopeParams.length}::text[])`);
    } else if (graphClients !== null) {
      scopeParams.push(graphClients);
      scopeConditions.push(`COALESCE(e.client, c.client) = ANY($${scopeParams.length}::text[])`);
    }
    const scopeWhere = scopeConditions.length ? `AND ${scopeConditions.join(' AND ')}` : '';

    const accessParams = [];
    const accessConditions = [];
    if (graphProjects !== null) {
      accessParams.push(graphProjects);
      accessConditions.push(`person.project = ANY($${accessParams.length}::text[])`);
    }
    if (graphClients !== null) {
      accessParams.push(graphClients);
      accessConditions.push(`person.client = ANY($${accessParams.length}::text[])`);
    }
    const accessWhere = accessConditions.length ? `WHERE ${accessConditions.join(' AND ')}` : '';

    const [ppeByEmployee, ppeRepeatedByEmployee, auditsByMonth, ncrByMonth, ppeStageDelays, filterOptions, auditsByAuditor, auditsByAuditorProject] = await Promise.all([
      pool.query(`
        SELECT COALESCE(e.full_name, c.full_name) as employee_name, COUNT(r.id) as ppe_count
        FROM ppe_requests r
        LEFT JOIN employees e ON e.id = r.employee_id
        LEFT JOIN casuals c ON c.id = r.casual_id
        WHERE COALESCE(e.employment_status, c.employment_status) = 'active'
        ${scopeWhere}
        GROUP BY COALESCE(e.id, c.id), COALESCE(e.full_name, c.full_name)
        ORDER BY ppe_count DESC
        LIMIT 20
      `, scopeParams),
      pool.query(`
        SELECT COALESCE(e.full_name, c.full_name) as employee_name,
               p.name as item_name,
               COUNT(r.id) as request_count,
               MAX(r.date_flagged) as last_flagged,
               ARRAY_AGG(r.date_flagged ORDER BY r.date_flagged DESC) as flagged_dates
        FROM ppe_requests r
        LEFT JOIN employees e ON e.id = r.employee_id
        LEFT JOIN casuals c ON c.id = r.casual_id
        LEFT JOIN ppe_items p ON p.id = r.ppe_item_id
        WHERE COALESCE(e.employment_status, c.employment_status) = 'active'
          AND r.date_flagged >= NOW() - INTERVAL '12 months'
          AND r.status != 'canceled'
        ${scopeWhere}
        GROUP BY COALESCE(e.id, c.id), COALESCE(e.full_name, c.full_name), p.id, p.name
        HAVING COUNT(r.id) > 1
        ORDER BY request_count DESC, employee_name ASC
        LIMIT 200
      `, scopeParams),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', a.audit_date), 'Mon YYYY') as month,
               DATE_TRUNC('month', a.audit_date) as month_date,
               COUNT(*) as count,
               COUNT(*) FILTER (WHERE a.employee_present = TRUE) as audits_count,
               COUNT(*) FILTER (WHERE a.employee_present = FALSE) as requests_count
        FROM audits a
        LEFT JOIN employees e ON e.id = a.employee_id
        LEFT JOIN casuals c ON c.id = a.casual_id
        WHERE a.audit_date >= NOW() - INTERVAL '6 months'
        ${scopeWhere}
        GROUP BY month_date, month
        ORDER BY month_date ASC
      `, scopeParams),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', n.created_at), 'Mon YYYY') as month,
               DATE_TRUNC('month', n.created_at) as month_date,
               COUNT(*) as created,
               COUNT(*) FILTER (WHERE n.status IN ('resolved','distributed')) as resolved
        FROM ncr_items n
        LEFT JOIN employees e ON e.id = n.employee_id
        LEFT JOIN casuals c ON c.id = n.casual_id
        WHERE n.created_at >= NOW() - INTERVAL '6 months'
        ${scopeWhere}
        GROUP BY month_date, month
        ORDER BY month_date ASC
      `, scopeParams),
      pool.query(`
        WITH scoped_requests AS (
          SELECT r.*, ppe_needs_pda(p.id, COALESCE(e.project, c.project)) as needs_pda
          FROM ppe_requests r
          LEFT JOIN employees e ON e.id = r.employee_id
          LEFT JOIN casuals c ON c.id = r.casual_id
          LEFT JOIN ppe_items p ON p.id = r.ppe_item_id
          WHERE 1=1 ${scopeWhere}
        ),
        stage_events AS (
          SELECT 'ehs' AS stage, date_purchase_requested AS completed_at,
                 EXTRACT(EPOCH FROM (date_purchase_requested - date_flagged)) / 86400.0 AS delay_days,
                 FALSE AS is_open
          FROM scoped_requests
          WHERE date_flagged IS NOT NULL AND date_purchase_requested IS NOT NULL
          UNION ALL
          SELECT 'pm', pda_approved_date,
                 EXTRACT(EPOCH FROM (pda_approved_date - date_purchase_requested)) / 86400.0,
                 FALSE
          FROM scoped_requests
          WHERE date_purchase_requested IS NOT NULL AND pda_approved_date IS NOT NULL
          UNION ALL
          SELECT 'scm', date_ordered,
                 EXTRACT(EPOCH FROM (date_ordered - COALESCE(pda_approved_date, date_purchase_requested))) / 86400.0,
                 FALSE
          FROM scoped_requests
          WHERE COALESCE(pda_approved_date, date_purchase_requested) IS NOT NULL AND date_ordered IS NOT NULL
          UNION ALL
          SELECT 'supplier', date_available,
                 EXTRACT(EPOCH FROM (date_available - date_ordered)) / 86400.0,
                 FALSE
          FROM scoped_requests
          WHERE date_ordered IS NOT NULL AND date_available IS NOT NULL
          UNION ALL
          SELECT 'project', date_distributed,
                 EXTRACT(EPOCH FROM (date_distributed - date_available)) / 86400.0,
                 FALSE
          FROM scoped_requests
          WHERE date_available IS NOT NULL AND date_distributed IS NOT NULL
          UNION ALL
          SELECT 'ehs', CURRENT_TIMESTAMP,
                 (CURRENT_DATE - date_flagged::date)::numeric,
                 TRUE
          FROM scoped_requests
          WHERE status = 'pending' AND date_flagged IS NOT NULL
          UNION ALL
          SELECT 'pm', CURRENT_TIMESTAMP,
                 (CURRENT_DATE - date_purchase_requested::date)::numeric,
                 TRUE
          FROM scoped_requests
          WHERE status = 'ehs_purchase_requested'
            AND needs_pda IS TRUE
            AND pda_approved_date IS NULL
            AND date_purchase_requested IS NOT NULL
          UNION ALL
          SELECT 'scm', CURRENT_TIMESTAMP,
                 (CURRENT_DATE - COALESCE(pda_approved_date, date_purchase_requested)::date)::numeric,
                 TRUE
          FROM scoped_requests
          WHERE status IN ('ehs_purchase_requested', 'pda_approved')
            AND (needs_pda IS NOT TRUE OR pda_approved_date IS NOT NULL)
            AND COALESCE(pda_approved_date, date_purchase_requested) IS NOT NULL
          UNION ALL
          SELECT 'supplier', CURRENT_TIMESTAMP,
                 (CURRENT_DATE - date_ordered::date)::numeric,
                 TRUE
          FROM scoped_requests
          WHERE status = 'scm_ordered' AND date_ordered IS NOT NULL
          UNION ALL
          SELECT 'project', CURRENT_TIMESTAMP,
                 (CURRENT_DATE - date_available::date)::numeric,
                 TRUE
          FROM scoped_requests
          WHERE status = 'warehouse_available' AND date_available IS NOT NULL
        )
        SELECT TO_CHAR(DATE_TRUNC('month', completed_at), 'Mon YYYY') AS month,
               ROUND(AVG(delay_days) FILTER (WHERE stage = 'ehs')::numeric, 1) AS ehs,
               ROUND(MAX(delay_days) FILTER (WHERE stage = 'ehs')::numeric, 1) AS ehs_max,
               COUNT(*) FILTER (WHERE stage = 'ehs')::int AS ehs_count,
               COUNT(*) FILTER (WHERE stage = 'ehs' AND is_open)::int AS ehs_open_count,
               ROUND(AVG(delay_days) FILTER (WHERE stage = 'pm')::numeric, 1) AS pm,
               ROUND(MAX(delay_days) FILTER (WHERE stage = 'pm')::numeric, 1) AS pm_max,
               COUNT(*) FILTER (WHERE stage = 'pm')::int AS pm_count,
               COUNT(*) FILTER (WHERE stage = 'pm' AND is_open)::int AS pm_open_count,
               ROUND(AVG(delay_days) FILTER (WHERE stage = 'scm')::numeric, 1) AS scm,
               ROUND(MAX(delay_days) FILTER (WHERE stage = 'scm')::numeric, 1) AS scm_max,
               COUNT(*) FILTER (WHERE stage = 'scm')::int AS scm_count,
               COUNT(*) FILTER (WHERE stage = 'scm' AND is_open)::int AS scm_open_count,
               ROUND(AVG(delay_days) FILTER (WHERE stage = 'supplier')::numeric, 1) AS supplier,
               ROUND(MAX(delay_days) FILTER (WHERE stage = 'supplier')::numeric, 1) AS supplier_max,
               COUNT(*) FILTER (WHERE stage = 'supplier')::int AS supplier_count,
               COUNT(*) FILTER (WHERE stage = 'supplier' AND is_open)::int AS supplier_open_count,
               ROUND(AVG(delay_days) FILTER (WHERE stage = 'project')::numeric, 1) AS project,
               ROUND(MAX(delay_days) FILTER (WHERE stage = 'project')::numeric, 1) AS project_max,
               COUNT(*) FILTER (WHERE stage = 'project')::int AS project_count,
               COUNT(*) FILTER (WHERE stage = 'project' AND is_open)::int AS project_open_count
        FROM stage_events
        WHERE completed_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months'
          AND completed_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
        GROUP BY DATE_TRUNC('month', completed_at)
        ORDER BY DATE_TRUNC('month', completed_at) ASC
      `, scopeParams),
      pool.query(`
        WITH person AS (
          SELECT project, client FROM employees
          UNION ALL
          SELECT project, client FROM casuals
        ),
        scoped_person AS (SELECT * FROM person ${accessWhere})
        SELECT
          (SELECT ARRAY_AGG(DISTINCT project ORDER BY project) FILTER (WHERE project IS NOT NULL AND project <> '') FROM scoped_person) AS projects,
          (SELECT ARRAY_AGG(DISTINCT client ORDER BY client) FILTER (WHERE client IS NOT NULL AND client <> '') FROM scoped_person) AS clients,
          (
            SELECT COALESCE(json_object_agg(client, projects), '{}'::json)
            FROM (
              SELECT client, ARRAY_AGG(DISTINCT project ORDER BY project) FILTER (WHERE project IS NOT NULL AND project <> '') AS projects
              FROM scoped_person
              WHERE client IS NOT NULL AND client <> ''
              GROUP BY client
            ) t
          ) AS client_projects
      `, accessParams),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', a.audit_date), 'Mon YYYY') as month,
               DATE_TRUNC('month', a.audit_date) as month_date,
               u.full_name as auditor,
               u.profile_picture as photo,
               COUNT(*) as count
        FROM audits a
        LEFT JOIN employees e ON e.id = a.employee_id
        LEFT JOIN casuals c ON c.id = a.casual_id
        JOIN users u ON u.id = a.audited_by
        WHERE a.audit_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months'
          AND a.employee_present = TRUE
        ${scopeWhere}
        GROUP BY month_date, month, u.id, u.full_name, u.profile_picture
        ORDER BY month_date ASC
      `, scopeParams),
      pool.query(`
        SELECT u.full_name as auditor,
               COALESCE(NULLIF(COALESCE(e.project, c.project), ''), 'Unassigned') as project,
               COUNT(*) as count
        FROM audits a
        LEFT JOIN employees e ON e.id = a.employee_id
        LEFT JOIN casuals c ON c.id = a.casual_id
        JOIN users u ON u.id = a.audited_by
        WHERE a.audit_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months'
          AND a.employee_present = TRUE
        ${scopeWhere}
        GROUP BY u.id, u.full_name, COALESCE(NULLIF(COALESCE(e.project, c.project), ''), 'Unassigned')
        ORDER BY u.full_name ASC
      `, scopeParams)
    ]);

    const counts = ppeByEmployee.rows.map(r => parseInt(r.ppe_count));
    const avg = counts.length > 0 ? Math.round(counts.reduce((a,b) => a+b, 0) / counts.length) : 0;

    // Pivot (month, auditor, count) rows into one row per month with each
    // auditor as its own key, e.g. { month: 'Jan 2026', 'Jane Doe': 5 }.
    const auditorMonthRows = {};
    const auditorNames = new Set();
    const auditorPhotos = {};
    auditsByAuditor.rows.forEach(r => {
      if (!auditorMonthRows[r.month]) auditorMonthRows[r.month] = { month: r.month, _sort: r.month_date };
      auditorMonthRows[r.month][r.auditor] = parseInt(r.count);
      auditorNames.add(r.auditor);
      if (r.photo) auditorPhotos[r.auditor] = r.photo;
    });
    const auditsByAuditorMonth = Object.values(auditorMonthRows)
      .sort((a, b) => new Date(a._sort) - new Date(b._sort))
      .map(({ _sort, ...rest }) => rest);
    const auditors = [...auditorNames].sort();

    // Pivot (auditor, project, count) rows into one row per auditor with each
    // project as its own key, e.g. { auditor: 'Jane Doe', 'Project A': 5 }.
    const auditorProjectRows = {};
    const auditProjectNames = new Set();
    auditsByAuditorProject.rows.forEach(r => {
      if (!auditorProjectRows[r.auditor]) auditorProjectRows[r.auditor] = { auditor: r.auditor };
      auditorProjectRows[r.auditor][r.project] = parseInt(r.count);
      auditProjectNames.add(r.project);
    });
    const auditsByAuditorProjectOut = Object.values(auditorProjectRows);
    const auditProjects = [...auditProjectNames].sort();

    res.json({
      ppe_by_employee: ppeByEmployee.rows.map(r => ({ name: r.employee_name, count: parseInt(r.ppe_count) })),
      ppe_average: avg,
      ppe_repeat_items: ppeRepeatedByEmployee.rows.map(r => ({
        employee: r.employee_name,
        item: r.item_name,
        count: parseInt(r.request_count),
        last_flagged: r.last_flagged,
        flagged_dates: r.flagged_dates,
      })),
      filter_options: {
        projects: filterOptions.rows[0]?.projects || [],
        clients: filterOptions.rows[0]?.clients || [],
        client_projects: filterOptions.rows[0]?.client_projects || {},
      },
      active_filters: { project: requestedProjects, client: requestedClients },
      audits_by_month: auditsByMonth.rows.map(r => ({ month: r.month, count: parseInt(r.count), audits_count: parseInt(r.audits_count), requests_count: parseInt(r.requests_count) })),
      ncr_by_month: ncrByMonth.rows.map(r => ({ month: r.month, created: parseInt(r.created), resolved: parseInt(r.resolved) })),
      ppe_stage_delays_by_month: ppeStageDelays.rows.map(r => ({
        month: r.month,
        ehs: r.ehs === null ? null : parseFloat(r.ehs),
        ehs_max: r.ehs_max === null ? null : parseFloat(r.ehs_max),
        ehs_count: parseInt(r.ehs_count),
        ehs_open_count: parseInt(r.ehs_open_count),
        pm: r.pm === null ? null : parseFloat(r.pm),
        pm_max: r.pm_max === null ? null : parseFloat(r.pm_max),
        pm_count: parseInt(r.pm_count),
        pm_open_count: parseInt(r.pm_open_count),
        scm: r.scm === null ? null : parseFloat(r.scm),
        scm_max: r.scm_max === null ? null : parseFloat(r.scm_max),
        scm_count: parseInt(r.scm_count),
        scm_open_count: parseInt(r.scm_open_count),
        supplier: r.supplier === null ? null : parseFloat(r.supplier),
        supplier_max: r.supplier_max === null ? null : parseFloat(r.supplier_max),
        supplier_count: parseInt(r.supplier_count),
        supplier_open_count: parseInt(r.supplier_open_count),
        project: r.project === null ? null : parseFloat(r.project),
        project_max: r.project_max === null ? null : parseFloat(r.project_max),
        project_count: parseInt(r.project_count),
        project_open_count: parseInt(r.project_open_count),
      })),
      audits_by_auditor_month: auditsByAuditorMonth,
      auditors,
      auditor_photos: auditorPhotos,
      audits_by_auditor_project: auditsByAuditorProjectOut,
      audit_projects: auditProjects,
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/users', auth, async (req, res) => {
  if (!['admin','ehs_manager','ehs_officer','supervisor'].includes(req.user.role)) return res.status(403).json({ error: 'Not authorized' });
  const { rows } = await pool.query('SELECT id, full_name, email, role, is_active, profile_picture, project_access, page_access, client_access, training_course_access, hr_task_access, outsource_access, must_reset_password, failed_login_attempts, locked_until, last_login, created_at FROM users ORDER BY created_at DESC');
  res.json(rows);
});

// Clear a locked-out account (admin only)
app.put('/api/users/:id/unlock', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { rows } = await pool.query(
    'UPDATE users SET failed_login_attempts=0, locked_until=NULL WHERE id=$1 RETURNING id, failed_login_attempts, locked_until',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// Force all non-service accounts to change their password on next login (admin only)
app.post('/api/admin/force-password-reset', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  // Excludes the acting admin (so they aren't immediately kicked into the reset
  // screen mid-session) and the long-lived sync service accounts.
  const { rows } = await pool.query(
    `UPDATE users SET must_reset_password=TRUE
     WHERE email NOT IN ('sync@egypro.com','eats-sync@egypro.app') AND id != $1
     RETURNING id`,
    [req.user.id]
  );
  res.json({ count: rows.length });
});

// System logs — timestamp, user, endpoint, IP, status, error detail (admin only)
app.get('/api/admin/logs', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { errorsOnly, search, limit } = req.query;
    const conditions = [];
    const params = [];
    if (errorsOnly === 'true') conditions.push('l.status_code >= 400');
    if (search) { params.push(`%${search}%`); conditions.push(`(l.endpoint ILIKE $${params.length} OR l.ip ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const capped = Math.min(parseInt(limit) || 200, 500);
    params.push(capped);
    const { rows } = await pool.query(`
      SELECT l.id, l.created_at, l.endpoint, l.ip, l.status_code, l.error_detail, l.duration_ms,
        u.full_name as user_name, u.email as user_email
      FROM request_logs l
      LEFT JOIN users u ON u.id = l.user_id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch(e) { sendError(res, e); }
});

// POST create new user (admin only)
app.post('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { full_name, email, password, role, project_access, page_access } = req.body;
  if (!full_name || !email || !password || !role) return res.status(400).json({ error: 'All fields required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
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
  const { full_name, email, role, is_active, password, profile_picture, project_access, page_access, must_reset_password } = req.body;
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password) {
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
  }
  if (profile_picture && !isValidProfilePicture(profile_picture)) return res.status(400).json({ error: 'Invalid profile picture' });
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET full_name=$1, email=$2, role=$3, is_active=$4, password_hash=$5, profile_picture=$6, project_access=$7, page_access=$8, client_access=$9, must_reset_password=$10, updated_at=NOW() WHERE id=$11',
        [full_name, email, role, is_active, hash, profile_picture || null, project_access || [], page_access || [], req.body.client_access || [], must_reset_password || false, req.params.id]);
    } else {
      await pool.query('UPDATE users SET full_name=$1, email=$2, role=$3, is_active=$4, profile_picture=$5, project_access=$6, page_access=$7, client_access=$8, must_reset_password=$9, updated_at=NOW() WHERE id=$10',
        [full_name, email, role, is_active, profile_picture || null, project_access || [], page_access || [], req.body.client_access || [], must_reset_password || false, req.params.id]);
    }
    const { rows } = await pool.query('SELECT id, full_name, email, role, is_active, profile_picture, project_access, page_access, client_access, must_reset_password FROM users WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch(e) { sendError(res, e); }
});

// Change own password
app.post('/api/auth/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Invalid password data' });
  const pwError = validatePassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!(await bcrypt.compare(currentPassword, rows[0].password_hash)))
      return res.status(401).json({ error: 'Current password incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1, must_reset_password=FALSE WHERE id=$2', [hash, req.user.id]);
    res.json({ message: 'Password updated' });
  } catch(e) { sendError(res, e); }
});

// Catch-all safety net for anything that reaches Express's default error
// handling (e.g. a synchronous throw in a route with no try/catch) — never
// let a raw stack trace or exception message reach the client.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('Unhandled error:', err);
  res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
});
