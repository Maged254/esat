// ── Mobile Lines ─────────────────────────────────────────────
// Company-owned mobile lines (Safaricom / Airtel): the line register, the
// telecom product catalogues, and the importer that brings the existing
// spreadsheet in. Assignment, change requests, operator email and
// implementation confirmation follow in later phases.
//
// This is the first module split out of server.js. It takes its dependencies by
// injection rather than importing them, so server.js stays the only place that
// builds the pool, the auth middleware and the scope helpers.
//
// THE RULE THIS MODULE EXISTS TO PROTECT: a line's current package / credit
// limit / CUG / roaming is what the OPERATOR is providing today. Only a
// confirmed implementation may change it. Nothing in a later phase gets to
// shortcut that, which is why the columns live here and not on a request.

const OPERATORS = ['safaricom', 'airtel'];
const LINE_STATUSES = ['available', 'assigned', 'terminated'];
// CUG is billed per line per month on top of the package. It is a checkbox
// rather than a catalogue product, so it would otherwise be missing from every
// cost figure the module reports.
const CUG_MONTHLY = 300;

module.exports = function mobileLinesModule({ express, pool, auth, inScope, getProjectFilter, getClientFilter, sendError, sendMail, mailWrap }) {
  const router = express.Router();

  // ── Schema ────────────────────────────────────────────────
  // Called from setupDB with its client, inside the same boot migration.
  const setup = async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS telecom_packages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        operator VARCHAR(20) NOT NULL CHECK (operator IN ('safaricom','airtel')),
        package_name VARCHAR(160) NOT NULL,
        description TEXT,
        monthly_price NUMERIC(12,2),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by UUID REFERENCES users(id),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (operator, package_name)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS telecom_credit_limits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        operator VARCHAR(20) NOT NULL CHECK (operator IN ('safaricom','airtel')),
        credit_limit NUMERIC(12,2) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by UUID REFERENCES users(id),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (operator, credit_limit)
      )`);

    // The line. `monthly_price_snapshot` is copied from the package at the moment
    // the configuration is set, so correcting a catalogue price later never
    // rewrites what past months actually cost.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mobile_lines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mobile_number VARCHAR(20) NOT NULL UNIQUE,
        operator VARCHAR(20) NOT NULL CHECK (operator IN ('safaricom','airtel')),
        status VARCHAR(20) NOT NULL DEFAULT 'available' CHECK (status IN ('available','assigned','terminated')),
        current_employee_id UUID REFERENCES employees(id),
        current_package_id UUID REFERENCES telecom_packages(id),
        current_credit_limit_id UUID REFERENCES telecom_credit_limits(id),
        monthly_price_snapshot NUMERIC(12,2),
        cug_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        roaming_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        current_assignment_date TIMESTAMPTZ,
        available_since TIMESTAMPTZ DEFAULT NOW(),
        terminated_at TIMESTAMPTZ,
        terminated_by UUID REFERENCES users(id),
        notes TEXT,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    // Not every line belongs to a person. Operational numbers are held by a
    // function -- BTS NOC, Fibre NOC, Zuku NOC -- which outlives whoever answers
    // it. A holder is an admin-managed record rather than free text, so the same
    // NOC cannot end up in reporting three times with three spellings.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mobile_line_holders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(120) NOT NULL UNIQUE,
        project TEXT,
        client TEXT,
        notes TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by UUID REFERENCES users(id),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('ALTER TABLE mobile_lines ADD COLUMN IF NOT EXISTS current_holder_id UUID REFERENCES mobile_line_holders(id)');

    // An assigned line must have exactly ONE holder -- a person or a function,
    // never both and never neither -- and an available or terminated line must
    // have none. Without this a release that half-ran would leave a line that is
    // "available" yet still shows someone's name. Replaces the employee-only
    // version of this constraint.
    await client.query('ALTER TABLE mobile_lines DROP CONSTRAINT IF EXISTS mobile_lines_holder_matches_status');
    await client.query(`DO $$ BEGIN
      ALTER TABLE mobile_lines ADD CONSTRAINT mobile_lines_one_holder_matches_status
        CHECK ((status = 'assigned' AND (current_employee_id IS NOT NULL) <> (current_holder_id IS NOT NULL))
            OR (status <> 'assigned' AND current_employee_id IS NULL AND current_holder_id IS NULL));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

    // One line per holder, matching the rule employees live under.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_line_per_holder
        ON mobile_lines (current_holder_id)
        WHERE status = 'assigned' AND current_holder_id IS NOT NULL`);
    await client.query('ALTER TABLE mobile_line_assignments ADD COLUMN IF NOT EXISTS holder_id UUID REFERENCES mobile_line_holders(id)');
    await client.query('ALTER TABLE mobile_line_assignments ADD COLUMN IF NOT EXISTS holder_name_snapshot TEXT');
    await client.query('ALTER TABLE mobile_line_assignments ALTER COLUMN employee_id DROP NOT NULL');

    // The one-line-per-employee rule, in the database rather than only the API --
    // the same shape as the one-open-training-request index.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_line_per_employee
        ON mobile_lines (current_employee_id)
        WHERE status = 'assigned' AND current_employee_id IS NOT NULL`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_mobile_lines_status ON mobile_lines (status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_mobile_lines_operator ON mobile_lines (operator)');

    // A package or credit limit must belong to the line's own operator. Enforced
    // as a trigger because a CHECK cannot reach another table.
    await client.query(`
      CREATE OR REPLACE FUNCTION mobile_line_products_match_operator() RETURNS trigger AS $$
      BEGIN
        IF NEW.current_package_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM telecom_packages p WHERE p.id = NEW.current_package_id AND p.operator = NEW.operator) THEN
          RAISE EXCEPTION 'Package belongs to a different operator';
        END IF;
        IF NEW.current_credit_limit_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM telecom_credit_limits c WHERE c.id = NEW.current_credit_limit_id AND c.operator = NEW.operator) THEN
          RAISE EXCEPTION 'Credit limit belongs to a different operator';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await client.query('DROP TRIGGER IF EXISTS trg_mobile_line_products_match ON mobile_lines');
    await client.query(`
      CREATE TRIGGER trg_mobile_line_products_match BEFORE INSERT OR UPDATE ON mobile_lines
      FOR EACH ROW EXECUTE FUNCTION mobile_line_products_match_operator()`);

    // Who has held each line. Append-only; snapshots so the history still reads
    // correctly after a rename, a project move or an employee record being tidied.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mobile_line_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mobile_line_id UUID NOT NULL REFERENCES mobile_lines(id) ON DELETE CASCADE,
        mobile_number_snapshot VARCHAR(20),
        employee_id UUID REFERENCES employees(id),
        employee_number_snapshot VARCHAR(50),
        employee_name_snapshot TEXT,
        national_id_snapshot VARCHAR(50),
        project_snapshot TEXT,
        client_snapshot TEXT,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        assigned_by UUID REFERENCES users(id),
        released_at TIMESTAMPTZ,
        released_by UUID REFERENCES users(id),
        release_reason VARCHAR(40),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_mla_line ON mobile_line_assignments (mobile_line_id, assigned_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_mla_employee ON mobile_line_assignments (employee_id)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS mobile_change_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mobile_line_id UUID NOT NULL REFERENCES mobile_lines(id),
        employee_id UUID REFERENCES employees(id),
        operator VARCHAR(20) NOT NULL,
        project_snapshot TEXT,
        client_snapshot TEXT,
        employee_name_snapshot TEXT,
        status VARCHAR(30) NOT NULL DEFAULT 'pending_approval',
        requested_by UUID REFERENCES users(id),
        requested_at TIMESTAMPTZ DEFAULT NOW(),
        approved_by UUID REFERENCES users(id),
        approved_at TIMESTAMPTZ,
        rejected_by UUID REFERENCES users(id),
        rejected_at TIMESTAMPTZ,
        rejection_reason TEXT,
        cancelled_by UUID REFERENCES users(id),
        cancelled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    // One open request per line, so two approved requests can never reach the
    // operator with contradictory values for the same number.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_change_request_per_line
        ON mobile_change_requests (mobile_line_id)
        WHERE status IN ('pending_approval','approved','email_prepared','sent_to_operator','partially_implemented')`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mobile_change_request_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID NOT NULL REFERENCES mobile_change_requests(id) ON DELETE CASCADE,
        field_name VARCHAR(20) NOT NULL CHECK (field_name IN ('package','credit_limit','cug','roaming')),
        current_value_snapshot TEXT,
        current_value_id UUID,
        original_requested_value TEXT,
        original_requested_id UUID,
        approved_value TEXT,
        approved_id UUID,
        implementation_status VARCHAR(20) NOT NULL DEFAULT 'awaiting'
          CHECK (implementation_status IN ('awaiting','implemented','not_implemented')),
        implemented_value TEXT,
        implemented_by UUID REFERENCES users(id),
        implemented_at TIMESTAMPTZ,
        not_implemented_reason TEXT,
        UNIQUE (request_id, field_name)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS telecom_email_batches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        operator VARCHAR(20) NOT NULL CHECK (operator IN ('safaricom','airtel')),
        recipient_to_snapshot TEXT,
        recipient_cc_snapshot TEXT,
        subject_snapshot TEXT,
        body_snapshot TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','sent','discarded')),
        prepared_by UUID REFERENCES users(id),
        prepared_at TIMESTAMPTZ DEFAULT NOW(),
        sent_by UUID REFERENCES users(id),
        sent_at TIMESTAMPTZ,
        discarded_by UUID REFERENCES users(id),
        discarded_at TIMESTAMPTZ
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS telecom_email_batch_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email_batch_id UUID NOT NULL REFERENCES telecom_email_batches(id) ON DELETE CASCADE,
        change_request_id UUID NOT NULL REFERENCES mobile_change_requests(id),
        UNIQUE (email_batch_id, change_request_id)
      )`);

    // One row per CHANGED FIELD, which is what makes a partial implementation
    // traceable: three fields changed on one request means three rows, each with
    // its own implementation date (or its own reason for never happening).
    await client.query(`
      CREATE TABLE IF NOT EXISTS mobile_product_change_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mobile_line_id UUID REFERENCES mobile_lines(id),
        mobile_number VARCHAR(20),
        operator VARCHAR(20),
        employee_id UUID REFERENCES employees(id),
        employee_name_snapshot TEXT,
        project_snapshot TEXT,
        request_id UUID REFERENCES mobile_change_requests(id),
        field_changed VARCHAR(20),
        previous_value TEXT,
        originally_requested_value TEXT,
        approved_value TEXT,
        implemented_value TEXT,
        monthly_price_snapshot NUMERIC(12,2),
        implementation_status VARCHAR(20),
        not_implemented_reason TEXT,
        requested_by_name TEXT, requested_at TIMESTAMPTZ,
        approved_by_name TEXT, approved_at TIMESTAMPTZ,
        email_batch_id UUID REFERENCES telecom_email_batches(id),
        email_sent_by_name TEXT, email_sent_at TIMESTAMPTZ,
        confirmed_by_name TEXT, confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_mpch_line ON mobile_product_change_history (mobile_line_id, created_at)');

    // Seeded INACTIVE and addressed to the OneHub owner: this module is the first
    // thing in the app that would email an external company, so going live is a
    // deliberate act, not a default.
    await client.query(`
      CREATE TABLE IF NOT EXISTS operator_email_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        operator VARCHAR(20) NOT NULL UNIQUE CHECK (operator IN ('safaricom','airtel')),
        to_recipients TEXT,
        cc_recipients TEXT,
        subject_template TEXT,
        body_template TEXT,
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        updated_by UUID REFERENCES users(id),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`
      INSERT INTO operator_email_settings (operator, to_recipients, cc_recipients, subject_template, body_template, is_active)
      VALUES
        ('safaricom', 'e.maged@outlook.com', '', 'OneHub — Safaricom Line Change Request', 'Hello Safaricom Team,\n\nKindly action the following changes on the lines below.', FALSE),
        ('airtel',    'e.maged@outlook.com', '', 'OneHub — Airtel Line Change Request',    'Hello Airtel Team,\n\nKindly action the following changes on the lines below.',    FALSE)
      ON CONFLICT (operator) DO NOTHING`);

    // Append-only audit. Ships in Phase 1 on purpose -- history cannot be
    // backfilled, so it has to exist before the first action does.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mobile_module_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type VARCHAR(30) NOT NULL,
        entity_id UUID,
        action VARCHAR(40) NOT NULL,
        from_status VARCHAR(30),
        to_status VARCHAR(30),
        detail TEXT,
        changed_by UUID REFERENCES users(id),
        changed_by_name TEXT,
        changed_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_mme_entity ON mobile_module_events (entity_type, entity_id, changed_at)');
  };

  // Append one audit line. Never the reason an action fails: a lost history line
  // is a smaller problem than a refused write.
  const logEvent = async ({ entityType, entityId, action, from, to, detail, user }) => {
    try {
      await pool.query(
        `INSERT INTO mobile_module_events (entity_type, entity_id, action, from_status, to_status, detail, changed_by, changed_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [entityType, entityId, action, from || null, to || null, detail || null,
         user?.id || null, user ? (user.name || null) : 'System']
      );
    } catch (e) { console.error('mobile event log failed:', e.message); }
  };

  // ── Roles ─────────────────────────────────────────────────
  // Supervisors and project directors are the "Projects" side: scoped to their
  // own projects/clients, they see their people's lines and (from Phase 3) raise
  // change requests. HR holds line custody. Admin does everything.
  const ADMIN = (req, res, next) =>
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
  const HR_ADMIN = (req, res, next) =>
    ['admin', 'hr'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Not authorized to manage mobile lines' });
  const VIEW_ROLES = ['admin', 'hr', 'supervisor', 'project_director'];
  const CAN_VIEW = (req, res, next) =>
    VIEW_ROLES.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not authorized to view mobile lines' });

  // Kenyan mobile numbers arrive as 07xx, +2547xx or 2547xx. Store one shape so
  // the unique index actually catches a duplicate typed a different way.
  const normaliseNumber = (raw) => {
    const digits = String(raw || '').replace(/[^\d]/g, '');
    if (/^0\d{9}$/.test(digits)) return digits;
    if (/^254\d{9}$/.test(digits)) return '0' + digits.slice(3);
    if (/^\d{9}$/.test(digits)) return '0' + digits;
    return null;
  };

  // ── Product catalogues ────────────────────────────────────
  router.get('/products/packages', auth, CAN_VIEW, async (req, res) => {
    try {
      const { operator, include_inactive } = req.query;
      const params = [];
      let w = 'WHERE 1=1';
      if (operator) { params.push(operator); w += ` AND operator = $${params.length}`; }
      if (!include_inactive) w += ' AND is_active = TRUE';
      const { rows } = await pool.query(
        `SELECT * FROM telecom_packages ${w} ORDER BY operator, package_name`, params);
      res.json(rows);
    } catch (e) { sendError(res, e); }
  });

  router.post('/products/packages', auth, ADMIN, async (req, res) => {
    const { operator, package_name, description, monthly_price } = req.body;
    if (!OPERATORS.includes(operator)) return res.status(400).json({ error: 'Operator must be Safaricom or Airtel' });
    if (!package_name || !package_name.trim()) return res.status(400).json({ error: 'A package name is required' });
    const price = monthly_price === '' || monthly_price == null ? null : Number(monthly_price);
    if (price != null && (isNaN(price) || price < 0)) return res.status(400).json({ error: 'Monthly price must be a non-negative number' });
    try {
      const { rows: [pkg] } = await pool.query(
        `INSERT INTO telecom_packages (operator, package_name, description, monthly_price, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
        [operator, package_name.trim(), description?.trim() || null, price, req.user.id]);
      await logEvent({ entityType: 'package', entityId: pkg.id, action: 'catalogue_created', user: req.user,
        detail: `${operator} package "${pkg.package_name}"${price != null ? ` at ${price}/month` : ''}` });
      res.status(201).json(pkg);
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'That package already exists for this operator' });
      sendError(res, e);
    }
  });

  router.patch('/products/packages/:id', auth, ADMIN, async (req, res) => {
    const { package_name, description, monthly_price, is_active } = req.body;
    try {
      const { rows: [before] } = await pool.query('SELECT * FROM telecom_packages WHERE id=$1', [req.params.id]);
      if (!before) return res.status(404).json({ error: 'Not found' });
      const price = monthly_price === '' || monthly_price == null ? null : Number(monthly_price);
      if (price != null && (isNaN(price) || price < 0)) return res.status(400).json({ error: 'Monthly price must be a non-negative number' });
      const { rows: [pkg] } = await pool.query(
        `UPDATE telecom_packages SET package_name=COALESCE($1, package_name), description=$2,
           monthly_price=$3, is_active=COALESCE($4, is_active), updated_by=$5, updated_at=NOW()
         WHERE id=$6 RETURNING *`,
        [package_name?.trim() || null, description?.trim() || null, price,
         is_active === undefined ? null : !!is_active, req.user.id, req.params.id]);
      const changes = [];
      if (before.package_name !== pkg.package_name) changes.push(`name ${before.package_name} → ${pkg.package_name}`);
      if (String(before.monthly_price) !== String(pkg.monthly_price)) changes.push(`price ${before.monthly_price ?? '—'} → ${pkg.monthly_price ?? '—'}`);
      if (before.is_active !== pkg.is_active) changes.push(pkg.is_active ? 'reactivated' : 'deactivated');
      await logEvent({ entityType: 'package', entityId: pkg.id, action: 'catalogue_updated', user: req.user,
        detail: changes.join('; ') || 'edited' });
      res.json(pkg);
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'That package already exists for this operator' });
      sendError(res, e);
    }
  });

  // Delete a catalogue item. Only ever allowed while NOTHING references it -- a
  // package that has been used is part of the record of what a line carried and
  // what was asked of the operator, and Retire is the answer for those. So this
  // is really "undo adding it", for a typo or a duplicate.
  const catalogueUsage = async (kind, id) => {
    const col = kind === 'package' ? 'current_package_id' : 'current_credit_limit_id';
    const { rows: [u] } = await pool.query(`
      SELECT (SELECT COUNT(*) FROM mobile_lines WHERE ${col} = $1)::int AS lines,
             (SELECT COUNT(*) FROM mobile_change_request_items
               WHERE current_value_id = $1 OR original_requested_id = $1 OR approved_id = $1)::int AS requests`, [id]);
    return u;
  };

  router.delete('/products/packages/:id', auth, ADMIN, async (req, res) => {
    try {
      const { rows: [pkg] } = await pool.query('SELECT * FROM telecom_packages WHERE id=$1', [req.params.id]);
      if (!pkg) return res.status(404).json({ error: 'Not found' });
      const u = await catalogueUsage('package', req.params.id);
      if (u.lines || u.requests) {
        return res.status(400).json({
          error: `"${pkg.package_name}" is in use — ${[u.lines && `${u.lines} line${u.lines > 1 ? 's' : ''}`, u.requests && `${u.requests} change request${u.requests > 1 ? 's' : ''}`].filter(Boolean).join(' and ')} reference it. Retire it instead, so those records keep reading correctly.`,
        });
      }
      await pool.query('DELETE FROM telecom_packages WHERE id=$1', [req.params.id]);
      await logEvent({ entityType: 'package', entityId: null, action: 'catalogue_deleted', user: req.user,
        detail: `${pkg.operator} package "${pkg.package_name}" deleted — never used` });
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  });

  router.delete('/products/credit-limits/:id', auth, ADMIN, async (req, res) => {
    try {
      const { rows: [lim] } = await pool.query('SELECT * FROM telecom_credit_limits WHERE id=$1', [req.params.id]);
      if (!lim) return res.status(404).json({ error: 'Not found' });
      const u = await catalogueUsage('credit_limit', req.params.id);
      if (u.lines || u.requests) {
        return res.status(400).json({
          error: `That credit limit is in use — ${[u.lines && `${u.lines} line${u.lines > 1 ? 's' : ''}`, u.requests && `${u.requests} change request${u.requests > 1 ? 's' : ''}`].filter(Boolean).join(' and ')} reference it. Retire it instead, so those records keep reading correctly.`,
        });
      }
      await pool.query('DELETE FROM telecom_credit_limits WHERE id=$1', [req.params.id]);
      await logEvent({ entityType: 'credit_limit', entityId: null, action: 'catalogue_deleted', user: req.user,
        detail: `${lim.operator} credit limit ${lim.credit_limit} deleted — never used` });
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  });

  router.get('/products/credit-limits', auth, CAN_VIEW, async (req, res) => {
    try {
      const { operator, include_inactive } = req.query;
      const params = [];
      let w = 'WHERE 1=1';
      if (operator) { params.push(operator); w += ` AND operator = $${params.length}`; }
      if (!include_inactive) w += ' AND is_active = TRUE';
      const { rows } = await pool.query(
        `SELECT * FROM telecom_credit_limits ${w} ORDER BY operator, credit_limit`, params);
      res.json(rows);
    } catch (e) { sendError(res, e); }
  });

  router.post('/products/credit-limits', auth, ADMIN, async (req, res) => {
    const { operator, credit_limit } = req.body;
    if (!OPERATORS.includes(operator)) return res.status(400).json({ error: 'Operator must be Safaricom or Airtel' });
    const value = Number(credit_limit);
    if (credit_limit === '' || credit_limit == null || isNaN(value) || value < 0) {
      return res.status(400).json({ error: 'Credit limit must be a non-negative number' });
    }
    try {
      const { rows: [row] } = await pool.query(
        `INSERT INTO telecom_credit_limits (operator, credit_limit, created_by, updated_by)
         VALUES ($1,$2,$3,$3) RETURNING *`, [operator, value, req.user.id]);
      await logEvent({ entityType: 'credit_limit', entityId: row.id, action: 'catalogue_created', user: req.user,
        detail: `${operator} credit limit ${value}` });
      res.status(201).json(row);
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'That credit limit already exists for this operator' });
      sendError(res, e);
    }
  });

  router.patch('/products/credit-limits/:id', auth, ADMIN, async (req, res) => {
    const { is_active } = req.body;
    try {
      const { rows: [row] } = await pool.query(
        `UPDATE telecom_credit_limits SET is_active=COALESCE($1, is_active), updated_by=$2, updated_at=NOW()
         WHERE id=$3 RETURNING *`,
        [is_active === undefined ? null : !!is_active, req.user.id, req.params.id]);
      if (!row) return res.status(404).json({ error: 'Not found' });
      await logEvent({ entityType: 'credit_limit', entityId: row.id, action: 'catalogue_updated', user: req.user,
        detail: row.is_active ? 'reactivated' : 'deactivated' });
      res.json(row);
    } catch (e) { sendError(res, e); }
  });

  // ── Non-employee holders ──────────────────────────────────
  // Admin-managed, and admin-only throughout: these lines are not attached to a
  // person, so there is no project to scope them by and nobody on the Projects
  // side has a reason to see them.
  router.get('/holders', auth, ADMIN, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT h.*, l.mobile_number AS current_line, l.operator AS current_operator
          FROM mobile_line_holders h
          LEFT JOIN mobile_lines l ON l.current_holder_id = h.id AND l.status = 'assigned'
         ORDER BY h.is_active DESC, h.name`);
      res.json(rows);
    } catch (e) { sendError(res, e); }
  });

  router.post('/holders', auth, ADMIN, async (req, res) => {
    const { name, project, client, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'A holder name is required' });
    try {
      const { rows: [h] } = await pool.query(
        `INSERT INTO mobile_line_holders (name, project, client, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
        [name.trim(), project?.trim() || null, client?.trim() || null, notes?.trim() || null, req.user.id]);
      await logEvent({ entityType: 'holder', entityId: h.id, action: 'holder_created', user: req.user,
        detail: `${h.name}${h.project ? ` · ${h.project}` : ''}` });
      res.status(201).json(h);
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'A holder with that name already exists' });
      sendError(res, e);
    }
  });

  router.patch('/holders/:id', auth, ADMIN, async (req, res) => {
    const { name, project, client, notes, is_active } = req.body;
    try {
      const { rows: [h] } = await pool.query(
        `UPDATE mobile_line_holders SET name=COALESCE($1,name), project=$2, client=$3, notes=$4,
           is_active=COALESCE($5,is_active), updated_by=$6, updated_at=NOW()
         WHERE id=$7 RETURNING *`,
        [name?.trim() || null, project?.trim() || null, client?.trim() || null, notes?.trim() || null,
         is_active === undefined ? null : !!is_active, req.user.id, req.params.id]);
      if (!h) return res.status(404).json({ error: 'Not found' });
      await logEvent({ entityType: 'holder', entityId: h.id, action: 'holder_updated', user: req.user,
        detail: `${h.name}${h.is_active ? '' : ' — retired'}` });
      res.json(h);
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'A holder with that name already exists' });
      sendError(res, e);
    }
  });

  router.delete('/holders/:id', auth, ADMIN, async (req, res) => {
    try {
      const { rows: [h] } = await pool.query('SELECT * FROM mobile_line_holders WHERE id=$1', [req.params.id]);
      if (!h) return res.status(404).json({ error: 'Not found' });
      const { rows: [u] } = await pool.query(`
        SELECT (SELECT COUNT(*) FROM mobile_lines WHERE current_holder_id=$1)::int AS lines,
               (SELECT COUNT(*) FROM mobile_line_assignments WHERE holder_id=$1)::int AS history`, [req.params.id]);
      if (u.lines || u.history) {
        return res.status(400).json({ error: `${h.name} holds or has held a line — retire it instead, so that history keeps reading correctly.` });
      }
      await pool.query('DELETE FROM mobile_line_holders WHERE id=$1', [req.params.id]);
      await logEvent({ entityType: 'holder', entityId: null, action: 'holder_deleted', user: req.user, detail: `${h.name} deleted — never held a line` });
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  });

  // ── Lines register ────────────────────────────────────────
  // Scoped exactly like every other person-linked resource: a supervisor or
  // project director sees the lines of people in their own projects/clients.
  // An UNASSIGNED line has no project, so it is only ever visible to HR/Admin --
  // which is also what keeps Available Lines off the Projects side entirely.
  const scopeClause = async (user, params) => {
    if (user.role === 'admin') return '';
    // A line held by a function (BTS NOC and the like) is admin-only: it has no
    // project to scope by, and nobody outside admin manages one.
    let w = ' AND l.current_holder_id IS NULL';
    if (user.role === 'hr') return w;
    const projects = await getProjectFilter(user);
    const clients = await getClientFilter(user);
    w += ' AND e.id IS NOT NULL';
    if (projects !== null) {
      if (projects.length === 0) return null;
      params.push(projects); w += ` AND e.project = ANY($${params.length})`;
    }
    if (clients !== null) {
      if (clients.length === 0) return null;
      params.push(clients); w += ` AND e.client = ANY($${params.length})`;
    }
    return w;
  };

  const LINE_SELECT = `
    SELECT l.id, l.mobile_number, l.operator, l.status,
           l.cug_enabled, l.roaming_enabled, l.monthly_price_snapshot,
           l.current_assignment_date, l.available_since, l.notes, l.updated_at,
           e.id AS employee_id, e.full_name AS employee_name, e.employee_number,
           e.national_id, e.project, e.client, e.department, e.employment_status,
           -- A line held by a function rather than a person: the register reads
           -- the holder's own name, project and client, since there is no
           -- employee record to inherit them from.
           h.id AS holder_id, h.name AS holder_name,
           h.project AS holder_project, h.client AS holder_client,
           p.id AS package_id, p.package_name, p.monthly_price AS package_price,
           cl.id AS credit_limit_id, cl.credit_limit,
           (SELECT COUNT(*)::int FROM mobile_change_requests r
             WHERE r.mobile_line_id = l.id
               AND r.status IN ('pending_approval','approved','email_prepared','sent_to_operator','partially_implemented')) AS pending_changes
      FROM mobile_lines l
      LEFT JOIN employees e ON e.id = l.current_employee_id
      LEFT JOIN mobile_line_holders h ON h.id = l.current_holder_id
      LEFT JOIN telecom_packages p ON p.id = l.current_package_id
      LEFT JOIN telecom_credit_limits cl ON cl.id = l.current_credit_limit_id`;

  const registerWhere = async (req, params) => {
    const { search, operator, status, project, client, package_id, credit_limit_id, cug, roaming, unconfigured } = req.query;
    let w = ' WHERE 1=1';
    if (search) {
      params.push(`%${search}%`);
      w += ` AND (l.mobile_number ILIKE $${params.length} OR e.full_name ILIKE $${params.length}
                  OR e.employee_number ILIKE $${params.length} OR e.national_id ILIKE $${params.length}
                  OR h.name ILIKE $${params.length})`;
    }
    if (operator) { params.push(operator.split(',')); w += ` AND l.operator = ANY($${params.length})`; }
    if (status) { params.push(status.split(',')); w += ` AND l.status = ANY($${params.length})`; }
    if (project) { params.push(project.split(',')); w += ` AND (e.project = ANY($${params.length}) OR h.project = ANY($${params.length}))`; }
    if (client) { params.push(client.split(',')); w += ` AND (e.client = ANY($${params.length}) OR h.client = ANY($${params.length}))`; }
    if (package_id) { params.push(package_id); w += ` AND l.current_package_id = $${params.length}`; }
    if (credit_limit_id) { params.push(credit_limit_id); w += ` AND l.current_credit_limit_id = $${params.length}`; }
    if (cug === 'yes') w += ' AND l.cug_enabled = TRUE';
    if (cug === 'no') w += ' AND l.cug_enabled = FALSE';
    if (roaming === 'yes') w += ' AND l.roaming_enabled = TRUE';
    if (roaming === 'no') w += ' AND l.roaming_enabled = FALSE';
    // The gaps the importer will leave behind, so they can be cleaned up.
    if (unconfigured) w += ' AND (l.current_package_id IS NULL OR l.current_credit_limit_id IS NULL)';
    const scope = await scopeClause(req.user, params);
    if (scope === null) return null;
    return w + scope;
  };

  router.get('/', auth, CAN_VIEW, async (req, res) => {
    try {
      await releaseLinesForExitedEmployees(); // keeps the register honest about who still holds what
      const params = [];
      const where = await registerWhere(req, params);
      if (where === null) return res.json({ rows: [], total: 0, page: 1, pageSize: 25 });
      const limit = Math.min(Math.max(parseInt(req.query.pageSize) || 25, 1), 200);
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      const { rows } = await pool.query(
        `${LINE_SELECT} ${where}
         ORDER BY l.status, l.operator, l.mobile_number
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit]);
      const { rows: [count] } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM mobile_lines l
           LEFT JOIN employees e ON e.id = l.current_employee_id
           LEFT JOIN mobile_line_holders h ON h.id = l.current_holder_id ${where}`, params);
      res.json({ rows, total: count.total, page, pageSize: limit });
    } catch (e) { sendError(res, e); }
  });

  router.get('/stats', auth, CAN_VIEW, async (req, res) => {
    try {
      const params = [];
      const where = await registerWhere(req, params);
      if (where === null) return res.json({ total: 0, assigned: 0, available: 0, terminated: 0, safaricom: 0, airtel: 0, unconfigured: 0, monthly_assigned: 0, monthly_idle: 0 });
      const { rows: [s] } = await pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE l.status='assigned')::int AS assigned,
               COUNT(*) FILTER (WHERE l.status='available')::int AS available,
               COUNT(*) FILTER (WHERE l.status='terminated')::int AS terminated,
               COUNT(*) FILTER (WHERE l.operator='safaricom')::int AS safaricom,
               COUNT(*) FILTER (WHERE l.operator='airtel')::int AS airtel,
               COUNT(*) FILTER (WHERE l.current_package_id IS NULL OR l.current_credit_limit_id IS NULL)::int AS unconfigured,
               -- What a line costs every month is its package PLUS its CUG
               -- subscription, which is charged per line and is easy to forget
               -- because it is a checkbox rather than a product.
               COALESCE(SUM(l.monthly_price_snapshot) FILTER (WHERE l.status='assigned'), 0) AS package_assigned,
               COALESCE(SUM(l.monthly_price_snapshot) FILTER (WHERE l.status='available'), 0) AS package_idle,
               COUNT(*) FILTER (WHERE l.status='assigned' AND l.cug_enabled)::int AS cug_assigned,
               COUNT(*) FILTER (WHERE l.status='available' AND l.cug_enabled)::int AS cug_idle,
               COALESCE(SUM(l.monthly_price_snapshot) FILTER (WHERE l.status='assigned'), 0)
                 + ${CUG_MONTHLY} * COUNT(*) FILTER (WHERE l.status='assigned' AND l.cug_enabled) AS monthly_assigned,
               COALESCE(SUM(l.monthly_price_snapshot) FILTER (WHERE l.status='available'), 0)
                 + ${CUG_MONTHLY} * COUNT(*) FILTER (WHERE l.status='available' AND l.cug_enabled) AS monthly_idle,
               -- A credit limit is headroom, not spend: it is the most a line
               -- can run up on top of its package. Summed, it turns the monthly
               -- figure into a worst case.
               COALESCE(SUM(cl.credit_limit) FILTER (WHERE l.status='assigned'), 0) AS credit_limit_assigned
          FROM mobile_lines l
          LEFT JOIN employees e ON e.id = l.current_employee_id
          LEFT JOIN mobile_line_holders h ON h.id = l.current_holder_id
          LEFT JOIN telecom_credit_limits cl ON cl.id = l.current_credit_limit_id ${where}`, params);
      s.max_assigned = Number(s.monthly_assigned) + Number(s.credit_limit_assigned);
      s.cug_monthly_rate = CUG_MONTHLY;
      res.json(s);
    } catch (e) { sendError(res, e); }
  });

  router.get('/filter-options', auth, CAN_VIEW, async (req, res) => {
    try {
      const [projects, clients, packages, limits] = await Promise.all([
        pool.query(`SELECT DISTINCT p AS project FROM (
                      SELECT e.project AS p FROM mobile_lines l JOIN employees e ON e.id=l.current_employee_id
                      UNION SELECT h.project FROM mobile_lines l JOIN mobile_line_holders h ON h.id=l.current_holder_id
                    ) x WHERE NULLIF(TRIM(p),'') IS NOT NULL ORDER BY 1`),
        pool.query(`SELECT DISTINCT c AS client FROM (
                      SELECT e.client AS c FROM mobile_lines l JOIN employees e ON e.id=l.current_employee_id
                      UNION SELECT h.client FROM mobile_lines l JOIN mobile_line_holders h ON h.id=l.current_holder_id
                    ) x WHERE NULLIF(TRIM(c),'') IS NOT NULL ORDER BY 1`),
        pool.query(`SELECT id, operator, package_name FROM telecom_packages ORDER BY operator, package_name`),
        pool.query(`SELECT id, operator, credit_limit FROM telecom_credit_limits ORDER BY operator, credit_limit`),
      ]);
      res.json({
        projects: projects.rows.map(r => r.project),
        clients: clients.rows.map(r => r.client),
        packages: packages.rows,
        credit_limits: limits.rows,
      });
    } catch (e) { sendError(res, e); }
  });

  router.get('/:id', auth, CAN_VIEW, async (req, res) => {
    try {
      const { rows: [line] } = await pool.query(`${LINE_SELECT} WHERE l.id = $1`, [req.params.id]);
      if (!line) return res.status(404).json({ error: 'Not found' });
      // An unassigned line has no project to scope against, so only HR/Admin see it.
      if (line.holder_id && req.user.role !== 'admin') return res.status(404).json({ error: 'Not found' });
      if (!['admin', 'hr'].includes(req.user.role)) {
        if (!line.employee_id) return res.status(404).json({ error: 'Not found' });
        if (!(await inScope(req.user, line.project, line.client))) return res.status(404).json({ error: 'Not found' });
      }
      const [assignments, events] = await Promise.all([
        pool.query(`SELECT a.*, u.full_name AS assigned_by_name, ru.full_name AS released_by_name
                      FROM mobile_line_assignments a
                      LEFT JOIN users u ON u.id = a.assigned_by
                      LEFT JOIN users ru ON ru.id = a.released_by
                     WHERE a.mobile_line_id = $1 ORDER BY a.assigned_at DESC`, [req.params.id]),
        pool.query(`SELECT action, from_status, to_status, detail, changed_by_name, changed_at
                      FROM mobile_module_events WHERE entity_type='line' AND entity_id=$1
                     ORDER BY changed_at DESC LIMIT 100`, [req.params.id]),
      ]);
      res.json({ ...line, assignment_history: assignments.rows, events: events.rows });
    } catch (e) { sendError(res, e); }
  });

  // ── Create / correct a line (admin) ───────────────────────
  // Setting the configuration by hand is an ADMINISTRATIVE CORRECTION, not a
  // telecom change: it is how a line is first recorded and how an import mistake
  // is fixed. It is audited as such so it can never be mistaken for something the
  // operator did. From Phase 3, the normal route is a change request.
  router.post('/', auth, ADMIN, async (req, res) => {
    const { mobile_number, operator, package_id, credit_limit_id, cug_enabled, roaming_enabled, notes } = req.body;
    const number = normaliseNumber(mobile_number);
    if (!number) return res.status(400).json({ error: 'Enter a valid mobile number, e.g. 0712345678' });
    if (!OPERATORS.includes(operator)) return res.status(400).json({ error: 'Operator must be Safaricom or Airtel' });
    try {
      const price = await packagePrice(package_id);
      const { rows: [line] } = await pool.query(
        `INSERT INTO mobile_lines (mobile_number, operator, status, current_package_id, current_credit_limit_id,
           monthly_price_snapshot, cug_enabled, roaming_enabled, notes, created_by)
         VALUES ($1,$2,'available',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [number, operator, package_id || null, credit_limit_id || null, price,
         !!cug_enabled, !!roaming_enabled, notes?.trim() || null, req.user.id]);
      await logEvent({ entityType: 'line', entityId: line.id, action: 'line_created', to: 'available', user: req.user,
        detail: `${operator} ${number}` });
      res.status(201).json(line);
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'That mobile number already exists' });
      if (e.message?.includes('different operator')) return res.status(400).json({ error: e.message });
      sendError(res, e);
    }
  });

  const packagePrice = async (packageId) => {
    if (!packageId) return null;
    const { rows } = await pool.query('SELECT monthly_price FROM telecom_packages WHERE id=$1', [packageId]);
    return rows.length ? rows[0].monthly_price : null;
  };

  router.patch('/:id', auth, ADMIN, async (req, res) => {
    const { package_id, credit_limit_id, cug_enabled, roaming_enabled, notes, correction_reason } = req.body;
    if (!correction_reason || !correction_reason.trim()) {
      return res.status(400).json({ error: 'A reason is required — editing the current configuration by hand is an administrative correction, not a telecom change' });
    }
    try {
      const { rows: [before] } = await pool.query(
        `SELECT l.*, p.package_name, c.credit_limit FROM mobile_lines l
           LEFT JOIN telecom_packages p ON p.id=l.current_package_id
           LEFT JOIN telecom_credit_limits c ON c.id=l.current_credit_limit_id
          WHERE l.id=$1`, [req.params.id]);
      if (!before) return res.status(404).json({ error: 'Not found' });
      if (before.status === 'terminated') return res.status(400).json({ error: 'This line is terminated and can no longer be changed' });
      const price = package_id === undefined ? before.monthly_price_snapshot : await packagePrice(package_id);
      const { rows: [line] } = await pool.query(
        `UPDATE mobile_lines SET
           current_package_id = $1, current_credit_limit_id = $2, monthly_price_snapshot = $3,
           cug_enabled = COALESCE($4, cug_enabled), roaming_enabled = COALESCE($5, roaming_enabled),
           notes = $6, updated_at = NOW()
         WHERE id = $7 RETURNING *`,
        [package_id === undefined ? before.current_package_id : (package_id || null),
         credit_limit_id === undefined ? before.current_credit_limit_id : (credit_limit_id || null),
         price,
         cug_enabled === undefined ? null : !!cug_enabled,
         roaming_enabled === undefined ? null : !!roaming_enabled,
         notes === undefined ? before.notes : (notes?.trim() || null),
         req.params.id]);
      const changed = [];
      if (before.current_package_id !== line.current_package_id) changed.push('package');
      if (before.current_credit_limit_id !== line.current_credit_limit_id) changed.push('credit limit');
      if (before.cug_enabled !== line.cug_enabled) changed.push(`CUG ${before.cug_enabled ? 'Yes' : 'No'} → ${line.cug_enabled ? 'Yes' : 'No'}`);
      if (before.roaming_enabled !== line.roaming_enabled) changed.push(`roaming ${before.roaming_enabled ? 'Yes' : 'No'} → ${line.roaming_enabled ? 'Yes' : 'No'}`);
      await logEvent({ entityType: 'line', entityId: line.id, action: 'administrative_correction', user: req.user,
        detail: `${changed.join(', ') || 'no product change'} — "${correction_reason.trim()}"` });
      res.json(line);
    } catch (e) {
      if (e.message?.includes('different operator')) return res.status(400).json({ error: e.message });
      sendError(res, e);
    }
  });

  // ── Import ────────────────────────────────────────────────
  // Two steps on purpose: validate returns a report and writes nothing; commit
  // refuses the whole batch if anything is still invalid, unless the admin has
  // explicitly asked to import only the rows that passed.
  const importColumns = ['mobile_number', 'operator', 'national_id', 'employee_number', 'package', 'credit_limit', 'cug', 'roaming'];

  const parseBool = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(s)) return true;
    if (['no', 'n', 'false', '0', ''].includes(s)) return false;
    return null;
  };

  const validateImport = async (rows) => {
    const seenNumbers = new Map();
    const seenEmployees = new Map();
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i] || {};
      const errors = [];
      const r = { row: i + 2, raw }; // +2: header row plus 1-based indexing, so it matches the spreadsheet

      r.mobile_number = normaliseNumber(raw.mobile_number);
      if (!r.mobile_number) errors.push(`Mobile number "${raw.mobile_number ?? ''}" is not a valid Kenyan number`);

      r.operator = String(raw.operator || '').trim().toLowerCase();
      if (!OPERATORS.includes(r.operator)) errors.push(`Operator "${raw.operator ?? ''}" must be Safaricom or Airtel`);

      if (r.mobile_number) {
        if (seenNumbers.has(r.mobile_number)) errors.push(`Duplicate of row ${seenNumbers.get(r.mobile_number)} in this file`);
        else seenNumbers.set(r.mobile_number, r.row);
        const { rows: exists } = await pool.query('SELECT id FROM mobile_lines WHERE mobile_number=$1', [r.mobile_number]);
        if (exists.length) errors.push('This number already exists in OneHub');
      }

      // National ID first: outsource employees have no employee number in OneHub,
      // so keying on that alone would silently skip an entire population.
      const nid = String(raw.national_id || '').trim();
      const empNo = String(raw.employee_number || '').trim();
      if (nid || empNo) {
        const { rows: emp } = await pool.query(
          `SELECT id, full_name, employment_status, project, client FROM employees
            WHERE ($1 <> '' AND national_id = $1) OR ($2 <> '' AND employee_number = $2) LIMIT 2`, [nid, empNo]);
        if (emp.length === 0) errors.push(`No employee found for ${nid ? `National ID ${nid}` : `Employee Number ${empNo}`}`);
        else if (emp.length > 1) errors.push('That identifier matches more than one employee');
        else {
          r.employee = emp[0];
          if (emp[0].employment_status !== 'active') errors.push(`${emp[0].full_name} is not an active employee`);
          if (seenEmployees.has(emp[0].id)) errors.push(`${emp[0].full_name} already has a line on row ${seenEmployees.get(emp[0].id)} of this file`);
          else seenEmployees.set(emp[0].id, r.row);
          const { rows: held } = await pool.query(
            `SELECT mobile_number FROM mobile_lines WHERE current_employee_id=$1 AND status='assigned'`, [emp[0].id]);
          if (held.length) errors.push(`${emp[0].full_name} already holds ${held[0].mobile_number} in OneHub`);
        }
      }

      const pkgName = String(raw.package || '').trim();
      if (pkgName && OPERATORS.includes(r.operator)) {
        const { rows: pkg } = await pool.query(
          `SELECT id, monthly_price FROM telecom_packages WHERE operator=$1 AND LOWER(package_name)=LOWER($2)`, [r.operator, pkgName]);
        if (!pkg.length) errors.push(`Package "${pkgName}" does not exist in the ${r.operator} catalogue`);
        else { r.package_id = pkg[0].id; r.monthly_price = pkg[0].monthly_price; }
      }

      const limitRaw = String(raw.credit_limit ?? '').replace(/[^\d.]/g, '');
      if (limitRaw && OPERATORS.includes(r.operator)) {
        const { rows: lim } = await pool.query(
          `SELECT id FROM telecom_credit_limits WHERE operator=$1 AND credit_limit=$2`, [r.operator, Number(limitRaw)]);
        if (!lim.length) errors.push(`Credit limit "${raw.credit_limit}" does not exist in the ${r.operator} catalogue`);
        else r.credit_limit_id = lim[0].id;
      }

      r.cug = parseBool(raw.cug);
      if (r.cug === null) errors.push(`CUG "${raw.cug}" must be Yes or No`);
      r.roaming = parseBool(raw.roaming);
      if (r.roaming === null) errors.push(`Roaming "${raw.roaming}" must be Yes or No`);

      r.errors = errors;
      r.valid = errors.length === 0;
      out.push(r);
    }
    return out;
  };

  router.post('/import/validate', auth, ADMIN, async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'Send { rows: [...] }' });
    if (rows.length > 5000) return res.status(400).json({ error: 'That file is too large — split it into batches of 5,000 rows or fewer' });
    try {
      const checked = await validateImport(rows);
      res.json({
        columns: importColumns,
        total: checked.length,
        valid: checked.filter(r => r.valid).length,
        invalid: checked.filter(r => !r.valid).length,
        rows: checked.map(r => ({
          row: r.row, mobile_number: r.mobile_number, operator: r.operator,
          employee_name: r.employee?.full_name || null,
          package_id: r.package_id || null, credit_limit_id: r.credit_limit_id || null,
          cug: r.cug, roaming: r.roaming, valid: r.valid, errors: r.errors,
        })),
      });
    } catch (e) { sendError(res, e); }
  });

  router.post('/import/commit', auth, ADMIN, async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    const partial = !!req.body?.allow_partial;
    if (!rows) return res.status(400).json({ error: 'Send { rows: [...] }' });
    const dbClient = await pool.connect();
    try {
      const checked = await validateImport(rows);
      const bad = checked.filter(r => !r.valid);
      if (bad.length && !partial) {
        return res.status(400).json({
          error: `${bad.length} of ${checked.length} rows are invalid. Fix them, or re-run allowing a partial import.`,
          invalid: bad.map(r => ({ row: r.row, errors: r.errors })),
        });
      }
      const good = checked.filter(r => r.valid);
      await dbClient.query('BEGIN');
      const created = [];
      for (const r of good) {
        const assigned = !!r.employee;
        const { rows: [line] } = await dbClient.query(
          `INSERT INTO mobile_lines (mobile_number, operator, status, current_employee_id,
             current_package_id, current_credit_limit_id, monthly_price_snapshot,
             cug_enabled, roaming_enabled, current_assignment_date, available_since, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, mobile_number`,
          [r.mobile_number, r.operator, assigned ? 'assigned' : 'available', assigned ? r.employee.id : null,
           r.package_id || null, r.credit_limit_id || null, r.monthly_price ?? null,
           r.cug, r.roaming, assigned ? new Date() : null, assigned ? null : new Date(), req.user.id]);
        if (assigned) {
          await dbClient.query(
            `INSERT INTO mobile_line_assignments (mobile_line_id, mobile_number_snapshot, employee_id,
               employee_number_snapshot, employee_name_snapshot, national_id_snapshot,
               project_snapshot, client_snapshot, assigned_by)
             SELECT $1,$2,e.id,e.employee_number,e.full_name,e.national_id,e.project,e.client,$3
               FROM employees e WHERE e.id = $4`,
            [line.id, r.mobile_number, req.user.id, r.employee.id]);
        }
        created.push(line);
      }
      await dbClient.query('COMMIT');
      for (const [i, line] of created.entries()) {
        await logEvent({ entityType: 'line', entityId: line.id, action: 'line_imported',
          to: good[i].employee ? 'assigned' : 'available', user: req.user,
          detail: `Imported ${line.mobile_number}${good[i].employee ? ` — assigned to ${good[i].employee.full_name}` : ''}` });
      }
      res.json({ imported: created.length, skipped: bad.length, invalid: bad.map(r => ({ row: r.row, errors: r.errors })) });
    } catch (e) {
      await dbClient.query('ROLLBACK').catch(() => {});
      sendError(res, e);
    } finally {
      dbClient.release();
    }
  });

  // ── Assignment ────────────────────────────────────────────
  // Available lines are HR's working screen. A supervisor or project director
  // must never see them: an unassigned line has no project, so it is out of their
  // scope by construction -- but the endpoint refuses them outright as well,
  // because "not visible in the register" is not the same as "not reachable".
  router.get('/available/list', auth, HR_ADMIN, async (req, res) => {
    try {
      await releaseLinesForExitedEmployees(); // a line freed by an exit belongs here immediately
      const params = [];
      let w = ` WHERE l.status = 'available'`;
      if (req.query.operator) { params.push(req.query.operator.split(',')); w += ` AND l.operator = ANY($${params.length})`; }
      if (req.query.search) { params.push(`%${req.query.search}%`); w += ` AND l.mobile_number ILIKE $${params.length}`; }
      const { rows } = await pool.query(`
        SELECT l.id, l.mobile_number, l.operator, l.available_since, l.cug_enabled, l.roaming_enabled,
               l.monthly_price_snapshot, p.package_name, c.credit_limit,
               prev.employee_name_snapshot AS previous_employee,
               prev.released_at AS previous_released_at, prev.release_reason AS previous_release_reason
          FROM mobile_lines l
          LEFT JOIN telecom_packages p ON p.id = l.current_package_id
          LEFT JOIN telecom_credit_limits c ON c.id = l.current_credit_limit_id
          LEFT JOIN LATERAL (
            SELECT COALESCE(employee_name_snapshot, holder_name_snapshot) AS employee_name_snapshot, released_at, release_reason
              FROM mobile_line_assignments a
             WHERE a.mobile_line_id = l.id AND a.released_at IS NOT NULL
             ORDER BY a.released_at DESC LIMIT 1) prev ON TRUE
          ${w}
         ORDER BY l.available_since DESC NULLS LAST, l.mobile_number`, params);
      res.json(rows);
    } catch (e) { sendError(res, e); }
  });

  // Assign a line to an employee. Everything here is one transaction: the line,
  // its holder and the history row are a single fact, and a half-applied
  // assignment is exactly what the one-line-per-employee rule exists to prevent.
  router.post('/:id/assign', auth, HR_ADMIN, async (req, res) => {
    const { employee_id, holder_id } = req.body;
    if (!employee_id && !holder_id) return res.status(400).json({ error: 'Select an employee or a holder' });
    if (employee_id && holder_id) return res.status(400).json({ error: 'A line goes to one holder — a person or a function, not both' });
    // Holder lines are admin-only by decision: they have no project, so there is
    // no scope to reason about and HR does not manage them.
    if (holder_id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can assign a line to a non-employee holder' });
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const { rows: [line] } = await db.query(
        `SELECT * FROM mobile_lines WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!line) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
      if (line.status === 'terminated') { await db.query('ROLLBACK'); return res.status(400).json({ error: 'This line is terminated and cannot be assigned' }); }
      if (line.status === 'assigned') { await db.query('ROLLBACK'); return res.status(400).json({ error: 'This line is already assigned — release it first' }); }

      // A function rather than a person: one line each, same as an employee.
      if (holder_id) {
        const { rows: [h] } = await db.query('SELECT * FROM mobile_line_holders WHERE id=$1', [holder_id]);
        if (!h) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Holder not found' }); }
        if (!h.is_active) { await db.query('ROLLBACK'); return res.status(400).json({ error: `${h.name} is retired` }); }
        const { rows: held } = await db.query(
          `SELECT mobile_number FROM mobile_lines WHERE current_holder_id=$1 AND status='assigned'`, [holder_id]);
        if (held.length) {
          await db.query('ROLLBACK');
          return res.status(400).json({ error: `${h.name} already holds ${held[0].mobile_number}. Each holder can only have one line.` });
        }
        await db.query(
          `UPDATE mobile_lines SET status='assigned', current_holder_id=$1, current_employee_id=NULL,
             current_assignment_date=NOW(), available_since=NULL, updated_at=NOW() WHERE id=$2`,
          [holder_id, req.params.id]);
        await db.query(
          `INSERT INTO mobile_line_assignments (mobile_line_id, mobile_number_snapshot, holder_id,
             holder_name_snapshot, project_snapshot, client_snapshot, assigned_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [line.id, line.mobile_number, h.id, h.name, h.project, h.client, req.user.id]);
        await db.query('COMMIT');
        await logEvent({ entityType: 'line', entityId: line.id, action: 'assigned', from: line.status, to: 'assigned',
          user: req.user, detail: `${line.mobile_number} → ${h.name} (holder)` });
        const { rows: [fresh] } = await pool.query(`${LINE_SELECT} WHERE l.id = $1`, [line.id]);
        return res.json(fresh);
      }

      const { rows: [emp] } = await db.query(
        `SELECT id, full_name, employee_number, national_id, project, client, employment_status
           FROM employees WHERE id = $1`, [employee_id]);
      if (!emp) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Employee not found' }); }
      if (emp.employment_status !== 'active') { await db.query('ROLLBACK'); return res.status(400).json({ error: `${emp.full_name} is not an active employee` }); }

      const { rows: held } = await db.query(
        `SELECT mobile_number FROM mobile_lines WHERE current_employee_id = $1 AND status = 'assigned'`, [employee_id]);
      if (held.length) {
        await db.query('ROLLBACK');
        return res.status(400).json({ error: `${emp.full_name} already holds ${held[0].mobile_number}. An employee can only have one company line.` });
      }

      await db.query(
        `UPDATE mobile_lines SET status='assigned', current_employee_id=$1,
           current_assignment_date=NOW(), available_since=NULL, updated_at=NOW() WHERE id=$2`,
        [employee_id, req.params.id]);
      await db.query(
        `INSERT INTO mobile_line_assignments (mobile_line_id, mobile_number_snapshot, employee_id,
           employee_number_snapshot, employee_name_snapshot, national_id_snapshot,
           project_snapshot, client_snapshot, assigned_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [line.id, line.mobile_number, emp.id, emp.employee_number, emp.full_name,
         emp.national_id, emp.project, emp.client, req.user.id]);
      await db.query('COMMIT');
      await logEvent({ entityType: 'line', entityId: line.id, action: 'assigned', from: line.status, to: 'assigned',
        user: req.user, detail: `${line.mobile_number} → ${emp.full_name}${emp.project ? ` (${emp.project})` : ''}` });
      const { rows: [fresh] } = await pool.query(`${LINE_SELECT} WHERE l.id = $1`, [line.id]);
      res.json(fresh);
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') return res.status(400).json({ error: 'That employee already holds a company line' });
      sendError(res, e);
    } finally { db.release(); }
  });

  // Release a line by hand. The configuration is deliberately left alone: the
  // number keeps its package, credit limit, CUG and roaming so it can be handed
  // to the next person as-is -- which is also why an idle line keeps costing money.
  const releaseLine = async (db, line, { reason, user }) => {
    await db.query(
      `UPDATE mobile_line_assignments SET released_at = NOW(), released_by = $1, release_reason = $2
        WHERE mobile_line_id = $3 AND released_at IS NULL`,
      [user?.id || null, reason, line.id]);
    await db.query(
      `UPDATE mobile_lines SET status='available', current_employee_id=NULL, current_holder_id=NULL,
         current_assignment_date=NULL, available_since=NOW(), updated_at=NOW() WHERE id=$1`,
      [line.id]);
  };

  const RELEASE_REASONS = ['reassignment', 'administrative_correction', 'line_terminated', 'employee_exit'];

  router.post('/:id/release', auth, HR_ADMIN, async (req, res) => {
    const reason = req.body?.release_reason;
    if (!RELEASE_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'Choose why the line is being released' });
    }
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const { rows: [line] } = await db.query(
        `SELECT l.*, e.full_name FROM mobile_lines l LEFT JOIN employees e ON e.id = l.current_employee_id
          WHERE l.id = $1 FOR UPDATE OF l`, [req.params.id]);
      if (!line) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
      if (line.status !== 'assigned') { await db.query('ROLLBACK'); return res.status(400).json({ error: 'This line is not assigned to anyone' }); }
      await releaseLine(db, line, { reason, user: req.user });
      await db.query('COMMIT');
      await logEvent({ entityType: 'line', entityId: line.id, action: 'released', from: 'assigned', to: 'available',
        user: req.user, detail: `${line.mobile_number} released from ${line.full_name || 'unknown'} — ${reason.replace(/_/g, ' ')}` });
      const { rows: [fresh] } = await pool.query(`${LINE_SELECT} WHERE l.id = $1`, [line.id]);
      res.json(fresh);
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      sendError(res, e);
    } finally { db.release(); }
  });

  // Terminate: the number is gone for good. Admin only, and final -- a terminated
  // line can never be assigned again, which is why it releases its holder first.
  router.post('/:id/terminate', auth, ADMIN, async (req, res) => {
    const reason = req.body?.reason;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to terminate a line' });
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const { rows: [line] } = await db.query(
        `SELECT l.*, e.full_name FROM mobile_lines l LEFT JOIN employees e ON e.id = l.current_employee_id
          WHERE l.id = $1 FOR UPDATE OF l`, [req.params.id]);
      if (!line) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
      if (line.status === 'terminated') { await db.query('ROLLBACK'); return res.status(400).json({ error: 'This line is already terminated' }); }
      if (line.status === 'assigned') await releaseLine(db, line, { reason: 'line_terminated', user: req.user });
      await db.query(
        `UPDATE mobile_lines SET status='terminated', current_employee_id=NULL, current_holder_id=NULL,
           current_assignment_date=NULL, available_since=NULL, terminated_at=NOW(), terminated_by=$1, updated_at=NOW() WHERE id=$2`,
        [req.user.id, line.id]);
      await db.query('COMMIT');
      await logEvent({ entityType: 'line', entityId: line.id, action: 'terminated', from: line.status, to: 'terminated',
        user: req.user, detail: `${line.mobile_number}${line.full_name ? ` (released from ${line.full_name})` : ''} — "${reason.trim()}"` });
      res.json({ ok: true });
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      sendError(res, e);
    } finally { db.release(); }
  });

  // Delete a line outright. For a row that should never have existed -- a typo, a
  // test, a duplicate. Refused once the line has any history, because at that
  // point it is a record of something real and Terminate is the honest answer.
  router.delete('/:id', auth, ADMIN, async (req, res) => {
    try {
      const { rows: [line] } = await pool.query('SELECT * FROM mobile_lines WHERE id=$1', [req.params.id]);
      if (!line) return res.status(404).json({ error: 'Not found' });
      const { rows: [{ count }] } = await pool.query(
        `SELECT (SELECT COUNT(*) FROM mobile_line_assignments WHERE mobile_line_id=$1)
              + (SELECT COUNT(*) FROM mobile_change_requests WHERE mobile_line_id=$1) AS count`, [req.params.id]);
      if (Number(count) > 0) {
        return res.status(400).json({ error: 'This line has history — terminate it instead of deleting it' });
      }
      await pool.query('DELETE FROM mobile_lines WHERE id=$1', [req.params.id]);
      await logEvent({ entityType: 'line', entityId: null, action: 'line_deleted', from: line.status, user: req.user,
        detail: `${line.operator} ${line.mobile_number} deleted — no history` });
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  });

  // Purge a line AND everything attached to it: assignments, change requests and
  // their items, and any link into an email batch. This is the deliberate
  // exception to "history is never deleted" -- for a line that should never have
  // been in OneHub at all (a test, a wrong number typed and then used for a
  // while), where Terminate would leave a permanent record of something that was
  // never real.
  //
  // Guarded three ways: admin only, the mobile number has to be typed back to
  // confirm, and a line somebody is currently holding cannot be purged -- release
  // it first, so this can never quietly take a live number away from an employee.
  // The audit row survives, because it is what is left of the line.
  router.post('/:id/purge', auth, ADMIN, async (req, res) => {
    const db = await pool.connect();
    try {
      const { rows: [line] } = await db.query(
        `SELECT l.*, e.full_name FROM mobile_lines l LEFT JOIN employees e ON e.id = l.current_employee_id WHERE l.id=$1`,
        [req.params.id]);
      if (!line) return res.status(404).json({ error: 'Not found' });
      if (String(req.body?.confirm_number || '').trim() !== line.mobile_number) {
        return res.status(400).json({ error: `Type ${line.mobile_number} to confirm you want this line and all of its history destroyed` });
      }
      if (line.status === 'assigned') {
        return res.status(400).json({ error: `${line.full_name || 'Someone'} is currently holding this line — release it first` });
      }
      const { rows: [counts] } = await db.query(`
        SELECT (SELECT COUNT(*) FROM mobile_line_assignments WHERE mobile_line_id=$1)::int AS assignments,
               (SELECT COUNT(*) FROM mobile_change_requests WHERE mobile_line_id=$1)::int AS requests`, [req.params.id]);

      await db.query('BEGIN');
      await db.query(`
        DELETE FROM telecom_email_batch_requests
         WHERE change_request_id IN (SELECT id FROM mobile_change_requests WHERE mobile_line_id=$1)`, [req.params.id]);
      await db.query(`
        DELETE FROM mobile_change_request_items
         WHERE request_id IN (SELECT id FROM mobile_change_requests WHERE mobile_line_id=$1)`, [req.params.id]);
      await db.query('DELETE FROM mobile_product_change_history WHERE mobile_line_id=$1', [req.params.id]);
      await db.query('DELETE FROM mobile_change_requests WHERE mobile_line_id=$1', [req.params.id]);
      await db.query('DELETE FROM mobile_line_assignments WHERE mobile_line_id=$1', [req.params.id]);
      await db.query('DELETE FROM mobile_lines WHERE id=$1', [req.params.id]);
      await db.query('COMMIT');

      await logEvent({ entityType: 'line', entityId: null, action: 'line_purged', from: line.status, user: req.user,
        detail: `${line.operator} ${line.mobile_number} purged with ${counts.assignments} assignment record(s) and ${counts.requests} change request(s)` });
      res.json({ ok: true, purged: { mobile_number: line.mobile_number, ...counts } });
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      sendError(res, e);
    } finally { db.release(); }
  });

  // ── Employee exit → automatic release ─────────────────────
  // An employee is exited in more than one place: manually through the employee
  // screen, and silently by the SharePoint sync's bulk upsert. Hooking a single
  // endpoint would miss most real exits, so this is a sweep -- it looks at the
  // state of the world rather than trusting an event, the same approach as the
  // training expiry sweep. Idempotent, so calling it often is free.
  const releaseLinesForExitedEmployees = async () => {
    try {
      const { rows: due } = await pool.query(`
        SELECT l.id, l.mobile_number, l.operator, e.full_name, e.employee_number, e.project, e.client
          FROM mobile_lines l JOIN employees e ON e.id = l.current_employee_id
         WHERE l.status = 'assigned' AND e.employment_status <> 'active'`);
      if (!due.length) return [];
      const db = await pool.connect();
      try {
        for (const line of due) {
          await db.query('BEGIN');
          await releaseLine(db, line, { reason: 'employee_exit', user: null });
          await db.query('COMMIT');
          await logEvent({ entityType: 'line', entityId: line.id, action: 'auto_released', from: 'assigned', to: 'available',
            user: null, detail: `${line.mobile_number} released automatically — ${line.full_name} exited` });
        }
      } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { db.release(); }
      await notifyReleased(due);
      return due;
    } catch (e) {
      console.error('mobile line exit sweep failed:', e.message);
      return [];
    }
  };

  // One email per sweep, not one per line: an exit run that ends twenty contracts
  // should not produce twenty messages.
  const notifyReleased = async (lines) => {
    if (!lines.length || !sendMail) return;
    try {
      const rows = lines.map(l => `
        <tr>
          <td style="padding:6px 10px;border:1px solid #ddd;">${l.mobile_number}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${l.operator === 'safaricom' ? 'Safaricom' : 'Airtel'}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${l.full_name || '—'}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${l.project || '—'}</td>
        </tr>`).join('');
      await sendMail({
        subject: `OneHub — ${lines.length} Mobile Line${lines.length > 1 ? 's' : ''} Released`,
        html: mailWrap(`
          <p>Hello HR Team,</p>
          <p><strong>${lines.length} company mobile line${lines.length > 1 ? 's have' : ' has'}</strong> been released automatically because the holder is no longer an active employee. ${lines.length > 1 ? 'They are' : 'It is'} now available to assign, with the package, credit limit, CUG and roaming left exactly as ${lines.length > 1 ? 'they were' : 'it was'}.</p>
          <table style="border-collapse:collapse;font-size:10.5pt;">
            <tr>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Mobile Number</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Operator</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Previous Holder</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Project</th>
            </tr>
            ${rows}
          </table>
          <p>Please reassign in OneHub → Mobile Lines → Available Lines.</p>
        `),
      });
    } catch (e) { console.error('mobile line release email failed:', e.message); }
  };

  router.get('/:id/assignment-history', auth, CAN_VIEW, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT a.*, u.full_name AS assigned_by_name, ru.full_name AS released_by_name
           FROM mobile_line_assignments a
           LEFT JOIN users u ON u.id = a.assigned_by
           LEFT JOIN users ru ON ru.id = a.released_by
          WHERE a.mobile_line_id = $1 ORDER BY a.assigned_at DESC`, [req.params.id]);
      res.json(rows);
    } catch (e) { sendError(res, e); }
  });

  // ── Audit read ────────────────────────────────────────────
  router.get('/:id/events', auth, CAN_VIEW, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT action, from_status, to_status, detail, changed_by_name, changed_at
           FROM mobile_module_events WHERE entity_type='line' AND entity_id=$1 ORDER BY changed_at DESC`,
        [req.params.id]);
      res.json(rows);
    } catch (e) { sendError(res, e); }
  });

  // ── Change requests ───────────────────────────────────────
  // Mounted separately at /api/mobile-line-change-requests.
  //
  // The flow starts from the EMPLOYEE, never from the line inventory: a
  // supervisor picks their person, OneHub finds the line, and the form shows
  // Current → Requested. That ordering is the reason the Projects side never
  // needs to see which numbers are spare.
  //
  // Nothing in this section touches a line's current configuration. Approving
  // authorises us to ask the operator; it does not change what the operator is
  // providing. Only Phase 5's implementation confirmation may do that.
  const requests = express.Router();

  const REQUESTER_ROLES = ['admin', 'supervisor', 'project_director'];
  const CAN_REQUEST = (req, res, next) =>
    REQUESTER_ROLES.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not authorized to request mobile line changes' });

  const FIELDS = ['package', 'credit_limit', 'cug', 'roaming'];
  const FIELD_LABEL = { package: 'Package', credit_limit: 'Credit Limit', cug: 'CUG', roaming: 'Roaming' };
  const yesNo = (v) => v ? 'Yes' : 'No';

  // Everything the request form needs for one employee, in a single call: the
  // line, what it currently carries, and only that operator's active catalogue.
  requests.get('/context/:employeeId', auth, CAN_REQUEST, async (req, res) => {
    try {
      const { rows: [emp] } = await pool.query(
        `SELECT id, full_name, employee_number, national_id, project, client, employment_status
           FROM employees WHERE id = $1`, [req.params.employeeId]);
      if (!emp) return res.status(404).json({ error: 'Not found' });
      if (!(await inScope(req.user, emp.project, emp.client))) return res.status(404).json({ error: 'Not found' });

      const { rows: [line] } = await pool.query(`${LINE_SELECT} WHERE l.current_employee_id = $1 AND l.status = 'assigned'`, [emp.id]);
      if (!line) {
        return res.json({ employee: emp, line: null, reason: `${emp.full_name} has no company mobile line, so there is nothing to change.` });
      }
      const [pkgs, limits, open] = await Promise.all([
        pool.query(`SELECT id, package_name, monthly_price FROM telecom_packages WHERE operator=$1 AND is_active ORDER BY package_name`, [line.operator]),
        pool.query(`SELECT id, credit_limit FROM telecom_credit_limits WHERE operator=$1 AND is_active ORDER BY credit_limit`, [line.operator]),
        pool.query(`SELECT id, status FROM mobile_change_requests WHERE mobile_line_id=$1
                     AND status IN ('pending_approval','approved','email_prepared','sent_to_operator','partially_implemented')`, [line.id]),
      ]);
      res.json({
        employee: emp, line,
        packages: pkgs.rows, credit_limits: limits.rows,
        open_request: open.rows[0] || null,
      });
    } catch (e) { sendError(res, e); }
  });

  requests.post('/', auth, CAN_REQUEST, async (req, res) => {
    const { employee_id, package_id, credit_limit_id, cug, roaming } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'Select an employee' });
    const db = await pool.connect();
    try {
      const { rows: [emp] } = await db.query(
        `SELECT id, full_name, project, client, employment_status FROM employees WHERE id=$1`, [employee_id]);
      if (!emp) return res.status(404).json({ error: 'Not found' });
      if (!(await inScope(req.user, emp.project, emp.client))) return res.status(404).json({ error: 'Not found' });
      if (emp.employment_status !== 'active') return res.status(400).json({ error: `${emp.full_name} is not an active employee` });

      const { rows: [line] } = await db.query(
        `SELECT l.*, p.package_name, c.credit_limit FROM mobile_lines l
           LEFT JOIN telecom_packages p ON p.id = l.current_package_id
           LEFT JOIN telecom_credit_limits c ON c.id = l.current_credit_limit_id
          WHERE l.current_employee_id = $1 AND l.status = 'assigned'`, [employee_id]);
      if (!line) return res.status(400).json({ error: `${emp.full_name} has no company mobile line` });

      // Build only the items that actually DIFFER. An unchanged field is shown in
      // the UI for context but is not a change, and must never reach the operator.
      const items = [];
      if (package_id !== undefined && package_id !== null && package_id !== '' && package_id !== line.current_package_id) {
        const { rows: [p] } = await db.query(
          `SELECT id, package_name FROM telecom_packages WHERE id=$1 AND operator=$2 AND is_active`, [package_id, line.operator]);
        if (!p) return res.status(400).json({ error: 'That package is not available for this operator' });
        items.push({ field: 'package', cur: line.package_name, curId: line.current_package_id, val: p.package_name, valId: p.id });
      }
      if (credit_limit_id !== undefined && credit_limit_id !== null && credit_limit_id !== '' && credit_limit_id !== line.current_credit_limit_id) {
        const { rows: [c] } = await db.query(
          `SELECT id, credit_limit FROM telecom_credit_limits WHERE id=$1 AND operator=$2 AND is_active`, [credit_limit_id, line.operator]);
        if (!c) return res.status(400).json({ error: 'That credit limit is not available for this operator' });
        items.push({ field: 'credit_limit', cur: line.credit_limit == null ? null : String(line.credit_limit), curId: line.current_credit_limit_id, val: String(c.credit_limit), valId: c.id });
      }
      if (cug !== undefined && cug !== null && !!cug !== line.cug_enabled) {
        items.push({ field: 'cug', cur: yesNo(line.cug_enabled), curId: null, val: yesNo(!!cug), valId: null });
      }
      if (roaming !== undefined && roaming !== null && !!roaming !== line.roaming_enabled) {
        items.push({ field: 'roaming', cur: yesNo(line.roaming_enabled), curId: null, val: yesNo(!!roaming), valId: null });
      }
      if (!items.length) {
        return res.status(400).json({ error: 'Nothing has changed — pick at least one value that differs from what the line has now' });
      }

      await db.query('BEGIN');
      const { rows: [reqRow] } = await db.query(
        `INSERT INTO mobile_change_requests (mobile_line_id, employee_id, operator, project_snapshot,
           client_snapshot, employee_name_snapshot, status, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,'pending_approval',$7) RETURNING *`,
        [line.id, emp.id, line.operator, emp.project, emp.client, emp.full_name, req.user.id]);
      for (const it of items) {
        await db.query(
          `INSERT INTO mobile_change_request_items (request_id, field_name, current_value_snapshot,
             current_value_id, original_requested_value, original_requested_id, approved_value, approved_id)
           VALUES ($1,$2,$3,$4,$5,$6,$5,$6)`,
          [reqRow.id, it.field, it.cur, it.curId, it.val, it.valId]);
      }
      await db.query('COMMIT');
      await logEvent({ entityType: 'request', entityId: reqRow.id, action: 'request_submitted', to: 'pending_approval',
        user: req.user, detail: `${line.mobile_number} · ${emp.full_name} — ${items.map(i => `${FIELD_LABEL[i.field]} ${i.cur ?? 'Not set'} → ${i.val}`).join('; ')}` });
      res.status(201).json({ ...reqRow, items });
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') {
        return res.status(400).json({ error: 'This line already has a change request in progress — resolve that one first.' });
      }
      sendError(res, e);
    } finally { db.release(); }
  });

  const REQUEST_SELECT = `
    SELECT r.*, l.mobile_number, l.status AS line_status,
           u.full_name AS requested_by_name, au.full_name AS approved_by_name,
           ru.full_name AS rejected_by_name, cu.full_name AS cancelled_by_name,
           (SELECT json_agg(json_build_object(
              'id', i.id, 'field_name', i.field_name,
              'current_value_snapshot', i.current_value_snapshot,
              'original_requested_value', i.original_requested_value,
              'approved_value', i.approved_value,
              'implementation_status', i.implementation_status,
              'implemented_value', i.implemented_value,
              'not_implemented_reason', i.not_implemented_reason) ORDER BY i.field_name)
              FROM mobile_change_request_items i WHERE i.request_id = r.id) AS items
      FROM mobile_change_requests r
      JOIN mobile_lines l ON l.id = r.mobile_line_id
      LEFT JOIN users u ON u.id = r.requested_by
      LEFT JOIN users au ON au.id = r.approved_by
      LEFT JOIN users ru ON ru.id = r.rejected_by
      LEFT JOIN users cu ON cu.id = r.cancelled_by`;

  requests.get('/', auth, CAN_VIEW, async (req, res) => {
    try {
      const { status, operator, project, client, search, requested_by } = req.query;
      const params = [];
      let w = ' WHERE 1=1';
      if (status) { params.push(status.split(',')); w += ` AND r.status = ANY($${params.length})`; }
      if (operator) { params.push(operator.split(',')); w += ` AND r.operator = ANY($${params.length})`; }
      if (project) { params.push(project.split(',')); w += ` AND r.project_snapshot = ANY($${params.length})`; }
      if (client) { params.push(client.split(',')); w += ` AND r.client_snapshot = ANY($${params.length})`; }
      if (requested_by) { params.push(requested_by); w += ` AND r.requested_by = $${params.length}`; }
      if (search) {
        params.push(`%${search}%`);
        w += ` AND (l.mobile_number ILIKE $${params.length} OR r.employee_name_snapshot ILIKE $${params.length})`;
      }
      // Same scope rule as everything else: your own projects and clients.
      if (!['admin', 'hr'].includes(req.user.role)) {
        const projects = await getProjectFilter(req.user);
        const clients = await getClientFilter(req.user);
        if (projects !== null) {
          if (projects.length === 0) return res.json({ rows: [], total: 0 });
          params.push(projects); w += ` AND r.project_snapshot = ANY($${params.length})`;
        }
        if (clients !== null) {
          if (clients.length === 0) return res.json({ rows: [], total: 0 });
          params.push(clients); w += ` AND r.client_snapshot = ANY($${params.length})`;
        }
      }
      const { rows } = await pool.query(`${REQUEST_SELECT} ${w} ORDER BY r.requested_at DESC LIMIT 300`, params);
      res.json({ rows, total: rows.length });
    } catch (e) { sendError(res, e); }
  });

  // Counts for the nav badge and the queue headings.
  requests.get('/stats', auth, CAN_VIEW, async (req, res) => {
    try {
      const params = [];
      let w = ' WHERE 1=1';
      if (!['admin', 'hr'].includes(req.user.role)) {
        const projects = await getProjectFilter(req.user);
        if (projects !== null) {
          if (projects.length === 0) return res.json({});
          params.push(projects); w += ` AND r.project_snapshot = ANY($${params.length})`;
        }
      }
      const { rows: [s] } = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE r.status='pending_approval')::int AS pending_approval,
               COUNT(*) FILTER (WHERE r.status='approved')::int AS awaiting_email,
               COUNT(*) FILTER (WHERE r.status='sent_to_operator')::int AS awaiting_operator,
               COUNT(*) FILTER (WHERE r.status='partially_implemented')::int AS partially_implemented,
               COUNT(*)::int AS total
          FROM mobile_change_requests r ${w}`, params);
      res.json(s);
    } catch (e) { sendError(res, e); }
  });

  const loadRequest = async (id) => {
    const { rows: [r] } = await pool.query(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
    return r;
  };

  requests.get('/:id', auth, CAN_VIEW, async (req, res) => {
    try {
      const r = await loadRequest(req.params.id);
      if (!r) return res.status(404).json({ error: 'Not found' });
      if (!['admin', 'hr'].includes(req.user.role) && !(await inScope(req.user, r.project_snapshot, r.client_snapshot))) {
        return res.status(404).json({ error: 'Not found' });
      }
      res.json(r);
    } catch (e) { sendError(res, e); }
  });

  // A requester can withdraw their own request, but only while nobody has acted
  // on it. Once approved it is on its way to the operator and only an admin can
  // stop it.
  requests.post('/:id/cancel', auth, CAN_REQUEST, async (req, res) => {
    try {
      const r = await loadRequest(req.params.id);
      if (!r) return res.status(404).json({ error: 'Not found' });
      if (!(await inScope(req.user, r.project_snapshot, r.client_snapshot))) return res.status(404).json({ error: 'Not found' });
      // A requester may withdraw only while nobody has acted. An admin may also
      // pull back an APPROVED request, but only while it is still sitting in the
      // queue -- once it is in a prepared or sent email the operator has been
      // told, and unwinding it is a conversation, not a button.
      const withdrawable = req.user.role === 'admin' ? ['pending_approval', 'approved'] : ['pending_approval'];
      if (!withdrawable.includes(r.status)) {
        return res.status(400).json({
          error: r.status === 'approved'
            ? 'This request is approved and awaiting its operator email — only an admin can pull it back.'
            : `This request is ${r.status.replace(/_/g, ' ')} and can no longer be cancelled`,
        });
      }
      if (req.user.role !== 'admin' && r.requested_by !== req.user.id) {
        return res.status(403).json({ error: 'You can only cancel a request you raised' });
      }
      await pool.query(
        `UPDATE mobile_change_requests SET status='cancelled', cancelled_by=$1, cancelled_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [req.user.id, req.params.id]);
      await logEvent({ entityType: 'request', entityId: r.id, action: 'request_cancelled', from: r.status, to: 'cancelled',
        user: req.user, detail: `${r.mobile_number} · ${r.employee_name_snapshot}${r.status === 'approved' ? ' — pulled back after approval, before any operator email' : ''}` });
      res.json(await loadRequest(req.params.id));
    } catch (e) { sendError(res, e); }
  });

  // Approving authorises the ask. It does NOT change the line. An admin may cut a
  // requested value down before approving -- both numbers are kept, so the
  // history shows what was asked for as well as what was allowed.
  requests.post('/:id/approve', auth, ADMIN, async (req, res) => {
    const overrides = req.body?.items || {}; // { package: id|null, credit_limit: id|null, cug: bool, roaming: bool }
    const db = await pool.connect();
    try {
      const r = await loadRequest(req.params.id);
      if (!r) return res.status(404).json({ error: 'Not found' });
      if (r.status !== 'pending_approval') {
        return res.status(400).json({ error: `This request is ${r.status.replace(/_/g, ' ')} and is no longer awaiting approval` });
      }
      const { rows: [line] } = await db.query('SELECT * FROM mobile_lines WHERE id=$1', [r.mobile_line_id]);
      await db.query('BEGIN');
      const changed = [];
      for (const item of (r.items || [])) {
        if (!(item.field_name in overrides)) continue;
        const v = overrides[item.field_name];
        let value = null, id = null;
        if (item.field_name === 'package') {
          const { rows: [p] } = await db.query(
            `SELECT id, package_name FROM telecom_packages WHERE id=$1 AND operator=$2 AND is_active`, [v, line.operator]);
          if (!p) { await db.query('ROLLBACK'); return res.status(400).json({ error: 'That package is not available for this operator' }); }
          value = p.package_name; id = p.id;
        } else if (item.field_name === 'credit_limit') {
          const { rows: [c] } = await db.query(
            `SELECT id, credit_limit FROM telecom_credit_limits WHERE id=$1 AND operator=$2 AND is_active`, [v, line.operator]);
          if (!c) { await db.query('ROLLBACK'); return res.status(400).json({ error: 'That credit limit is not available for this operator' }); }
          value = String(c.credit_limit); id = c.id;
        } else {
          value = yesNo(!!v);
        }
        if (value !== item.approved_value) changed.push(`${FIELD_LABEL[item.field_name]} ${item.original_requested_value} → ${value}`);
        await db.query(`UPDATE mobile_change_request_items SET approved_value=$1, approved_id=$2 WHERE id=$3`,
          [value, id, item.id]);
      }
      // An approved value identical to what the line already has is not a change,
      // so it must not travel to the operator.
      const { rows: remaining } = await db.query(
        `SELECT i.field_name, i.approved_value, i.current_value_snapshot FROM mobile_change_request_items i WHERE i.request_id=$1`, [req.params.id]);
      const stillChanging = remaining.filter(i => (i.approved_value ?? '') !== (i.current_value_snapshot ?? ''));
      if (!stillChanging.length) {
        await db.query('ROLLBACK');
        return res.status(400).json({ error: 'Every value now matches what the line already has — reject the request instead of approving an empty change.' });
      }
      await db.query(
        `UPDATE mobile_change_requests SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [req.user.id, req.params.id]);
      await db.query('COMMIT');
      await logEvent({ entityType: 'request', entityId: r.id, action: changed.length ? 'request_modified_and_approved' : 'request_approved',
        from: 'pending_approval', to: 'approved', user: req.user,
        detail: changed.length ? `Approved with changes — ${changed.join('; ')}` : 'Approved as requested' });
      res.json(await loadRequest(req.params.id));
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      sendError(res, e);
    } finally { db.release(); }
  });

  requests.post('/:id/reject', auth, ADMIN, async (req, res) => {
    const reason = req.body?.rejection_reason;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required so the requester knows why' });
    try {
      const r = await loadRequest(req.params.id);
      if (!r) return res.status(404).json({ error: 'Not found' });
      if (r.status !== 'pending_approval') {
        return res.status(400).json({ error: `This request is ${r.status.replace(/_/g, ' ')} and is no longer awaiting approval` });
      }
      await pool.query(
        `UPDATE mobile_change_requests SET status='rejected', rejected_by=$1, rejected_at=NOW(),
           rejection_reason=$2, updated_at=NOW() WHERE id=$3`,
        [req.user.id, reason.trim(), req.params.id]);
      await logEvent({ entityType: 'request', entityId: r.id, action: 'request_rejected', from: 'pending_approval', to: 'rejected',
        user: req.user, detail: `${r.mobile_number} · ${r.employee_name_snapshot} — "${reason.trim()}"` });
      notifyRejected(await loadRequest(req.params.id)).catch(() => {});
      res.json(await loadRequest(req.params.id));
    } catch (e) { sendError(res, e); }
  });

  // The requester has to learn a rejection without watching the screen, and the
  // reason is the whole point of telling them.
  const notifyRejected = async (r) => {
    if (!sendMail) return;
    const { rows: [u] } = await pool.query('SELECT full_name FROM users WHERE id=$1', [r.requested_by]);
    await sendMail({
      subject: `OneHub — Mobile Line Change Rejected (${r.mobile_number})`,
      html: mailWrap(`
        <p>Hello ${u?.full_name || 'there'},</p>
        <p>Your mobile line change request for <strong>${r.employee_name_snapshot}</strong> (${r.mobile_number}) was not approved.</p>
        <p><strong>Reason:</strong> ${r.rejection_reason}</p>
        <p>The line is unchanged. You can raise a new request in OneHub → Mobile Lines → Change Requests.</p>
      `),
    });
  };

  // ── Operator email ────────────────────────────────────────
  // Approved requests wait in a queue. An admin gathers them into ONE email per
  // operator, reads it, and sends it. Nothing is sent automatically, and
  // Safaricom and Airtel can never share a batch.
  //
  // The safety switch: a configuration ships INACTIVE and addressed to the
  // OneHub owner. Sending is refused while it is inactive, so the first real
  // message to a telecom operator is a deliberate act, never a side effect of
  // testing.
  const batches = express.Router();

  batches.get('/settings', auth, ADMIN, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM operator_email_settings ORDER BY operator');
      res.json(rows);
    } catch (e) { sendError(res, e); }
  });

  batches.put('/settings/:operator', auth, ADMIN, async (req, res) => {
    const { to_recipients, cc_recipients, subject_template, body_template, is_active } = req.body;
    if (!OPERATORS.includes(req.params.operator)) return res.status(400).json({ error: 'Unknown operator' });
    const emails = String(to_recipients || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
    if (is_active && !emails.length) {
      return res.status(400).json({ error: 'Add at least one recipient before switching this operator live' });
    }
    const bad = [...emails, ...String(cc_recipients || '').split(/[;,]/).map(s => s.trim()).filter(Boolean)]
      .filter(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad.length) return res.status(400).json({ error: `Not a valid email address: ${bad[0]}` });
    try {
      const { rows: [before] } = await pool.query('SELECT * FROM operator_email_settings WHERE operator=$1', [req.params.operator]);
      const { rows: [s] } = await pool.query(
        `UPDATE operator_email_settings SET to_recipients=$1, cc_recipients=$2, subject_template=$3,
           body_template=$4, is_active=COALESCE($5, is_active), updated_by=$6, updated_at=NOW()
         WHERE operator=$7 RETURNING *`,
        [to_recipients || '', cc_recipients || '', subject_template || '', body_template || '',
         is_active === undefined ? null : !!is_active, req.user.id, req.params.operator]);
      if (before && before.is_active !== s.is_active) {
        await logEvent({ entityType: 'email_settings', entityId: s.id,
          action: s.is_active ? 'operator_email_went_live' : 'operator_email_disabled', user: req.user,
          detail: `${s.operator} → ${s.is_active ? `LIVE, sending to ${s.to_recipients}` : 'inactive'}` });
      } else {
        await logEvent({ entityType: 'email_settings', entityId: s.id, action: 'operator_email_settings_updated',
          user: req.user, detail: `${s.operator} recipients/template updated` });
      }
      res.json(s);
    } catch (e) { sendError(res, e); }
  });

  // The change table. One row per changed field, so a person appears as many
  // times as they have changes -- which is what the operator has to action.
  const renderBatchRows = (rows) => rows.map(r => `
      <tr>
        <td style="padding:6px 10px;border:1px solid #ddd;">${r.mobile_number}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;">${r.employee_name_snapshot || '—'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;">${r.project_snapshot || '—'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;">${FIELD_LABEL[r.field_name]}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;">${r.current_value_snapshot ?? '—'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;"><strong>${r.approved_value}</strong></td>
      </tr>`).join('');

  const renderBatchBody = (intro, rows) => mailWrap(`
      ${intro.split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join('')}
      <table style="border-collapse:collapse;font-size:10.5pt;">
        <tr>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Mobile Number</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Employee</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Project</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Item</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Current</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Requested</th>
        </tr>
        ${renderBatchRows(rows)}
      </table>
      <p>Kindly confirm once these have been applied.</p>
    `);

  // Only the items that are genuinely a change reach the operator: an approved
  // value equal to what the line already has is dropped here as well as at
  // approval, because an admin edit could have made it a no-op.
  const batchItems = async (requestIds) => {
    const { rows } = await pool.query(`
      SELECT r.id AS request_id, l.mobile_number, r.employee_name_snapshot, r.project_snapshot,
             i.field_name, i.current_value_snapshot, i.approved_value
        FROM mobile_change_requests r
        JOIN mobile_lines l ON l.id = r.mobile_line_id
        JOIN mobile_change_request_items i ON i.request_id = r.id
       WHERE r.id = ANY($1::uuid[])
         AND COALESCE(i.approved_value,'') <> COALESCE(i.current_value_snapshot,'')
       ORDER BY l.mobile_number, i.field_name`, [requestIds]);
    return rows;
  };

  batches.post('/prepare', auth, ADMIN, async (req, res) => {
    const { operator, request_ids } = req.body;
    if (!OPERATORS.includes(operator)) return res.status(400).json({ error: 'Choose Safaricom or Airtel' });
    if (!Array.isArray(request_ids) || !request_ids.length) return res.status(400).json({ error: 'Select at least one approved request' });
    const db = await pool.connect();
    try {
      const { rows: reqs } = await db.query(
        `SELECT id, status, operator FROM mobile_change_requests WHERE id = ANY($1::uuid[])`, [request_ids]);
      if (reqs.length !== request_ids.length) return res.status(400).json({ error: 'One of those requests no longer exists' });
      const wrongStatus = reqs.find(r => r.status !== 'approved');
      if (wrongStatus) return res.status(400).json({ error: `A selected request is ${wrongStatus.status.replace(/_/g, ' ')}, not awaiting its email` });
      const wrongOperator = reqs.find(r => r.operator !== operator);
      if (wrongOperator) return res.status(400).json({ error: 'Safaricom and Airtel changes cannot share one email' });

      const { rows: [settings] } = await db.query('SELECT * FROM operator_email_settings WHERE operator=$1', [operator]);
      const items = await batchItems(request_ids);
      if (!items.length) return res.status(400).json({ error: 'None of those requests still contain a change' });

      const subject = `${settings?.subject_template || `OneHub — ${operator} Line Changes`} (${items.length} change${items.length > 1 ? 's' : ''})`;
      const body = renderBatchBody(settings?.body_template || 'Hello,', items);

      await db.query('BEGIN');
      const { rows: [batch] } = await db.query(
        `INSERT INTO telecom_email_batches (operator, recipient_to_snapshot, recipient_cc_snapshot,
           subject_snapshot, body_snapshot, status, prepared_by)
         VALUES ($1,$2,$3,$4,$5,'prepared',$6) RETURNING *`,
        [operator, settings?.to_recipients || '', settings?.cc_recipients || '', subject, body, req.user.id]);
      for (const id of request_ids) {
        await db.query('INSERT INTO telecom_email_batch_requests (email_batch_id, change_request_id) VALUES ($1,$2)', [batch.id, id]);
        await db.query(`UPDATE mobile_change_requests SET status='email_prepared', updated_at=NOW() WHERE id=$1`, [id]);
      }
      await db.query('COMMIT');
      await logEvent({ entityType: 'batch', entityId: batch.id, action: 'email_prepared', to: 'prepared', user: req.user,
        detail: `${operator} — ${request_ids.length} request(s), ${items.length} change(s)` });
      res.status(201).json({ ...batch, items, is_active: !!settings?.is_active });
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      sendError(res, e);
    } finally { db.release(); }
  });

  batches.get('/', auth, ADMIN, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT b.*, u.full_name AS prepared_by_name, su.full_name AS sent_by_name,
               (SELECT COUNT(*)::int FROM telecom_email_batch_requests x WHERE x.email_batch_id = b.id) AS request_count
          FROM telecom_email_batches b
          LEFT JOIN users u ON u.id = b.prepared_by
          LEFT JOIN users su ON su.id = b.sent_by
         ORDER BY b.prepared_at DESC LIMIT 100`);
      res.json(rows);
    } catch (e) { sendError(res, e); }
  });

  batches.get('/:id', auth, ADMIN, async (req, res) => {
    try {
      const { rows: [b] } = await pool.query(`
        SELECT b.*, u.full_name AS prepared_by_name, su.full_name AS sent_by_name
          FROM telecom_email_batches b
          LEFT JOIN users u ON u.id = b.prepared_by
          LEFT JOIN users su ON su.id = b.sent_by WHERE b.id=$1`, [req.params.id]);
      if (!b) return res.status(404).json({ error: 'Not found' });
      const { rows: [settings] } = await pool.query('SELECT is_active FROM operator_email_settings WHERE operator=$1', [b.operator]);
      const { rows: reqs } = await pool.query(
        `SELECT r.id, r.status, r.employee_name_snapshot, l.mobile_number
           FROM telecom_email_batch_requests x
           JOIN mobile_change_requests r ON r.id = x.change_request_id
           JOIN mobile_lines l ON l.id = r.mobile_line_id
          WHERE x.email_batch_id=$1`, [req.params.id]);
      res.json({ ...b, requests: reqs, is_active: !!settings?.is_active });
    } catch (e) { sendError(res, e); }
  });

  batches.post('/:id/send', auth, ADMIN, async (req, res) => {
    const db = await pool.connect();
    try {
      const { rows: [batch] } = await db.query('SELECT * FROM telecom_email_batches WHERE id=$1', [req.params.id]);
      if (!batch) return res.status(404).json({ error: 'Not found' });
      if (batch.status !== 'prepared') return res.status(400).json({ error: `This batch is already ${batch.status}` });
      const { rows: [settings] } = await db.query('SELECT * FROM operator_email_settings WHERE operator=$1', [batch.operator]);
      // The safety switch. Refusing here rather than in the UI is the point.
      if (!settings?.is_active) {
        return res.status(400).json({
          error: `${batch.operator === 'safaricom' ? 'Safaricom' : 'Airtel'} email is not live yet. Turn it on in Operator Email Settings once the recipients are right — until then nothing is sent.`,
        });
      }
      if (!batch.recipient_to_snapshot) return res.status(400).json({ error: 'This batch has no recipient' });

      await sendMail({
        to: batch.recipient_to_snapshot.split(/[;,]/).map(s => s.trim()).filter(Boolean),
        cc: batch.recipient_cc_snapshot ? batch.recipient_cc_snapshot.split(/[;,]/).map(s => s.trim()).filter(Boolean) : undefined,
        subject: batch.subject_snapshot,
        html: batch.body_snapshot,
      });

      await db.query('BEGIN');
      await db.query(`UPDATE telecom_email_batches SET status='sent', sent_by=$1, sent_at=NOW() WHERE id=$2`, [req.user.id, batch.id]);
      await db.query(`
        UPDATE mobile_change_requests SET status='sent_to_operator', updated_at=NOW()
         WHERE id IN (SELECT change_request_id FROM telecom_email_batch_requests WHERE email_batch_id=$1)`, [batch.id]);
      await db.query('COMMIT');
      await logEvent({ entityType: 'batch', entityId: batch.id, action: 'email_sent', from: 'prepared', to: 'sent', user: req.user,
        detail: `${batch.operator} → ${batch.recipient_to_snapshot}` });
      res.json({ ok: true });
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      sendError(res, e);
    } finally { db.release(); }
  });

  // Changed your mind before sending: the requests go back to the queue rather
  // than being stranded in "Email Prepared" with nothing able to move them.
  batches.post('/:id/discard', auth, ADMIN, async (req, res) => {
    const db = await pool.connect();
    try {
      const { rows: [batch] } = await db.query('SELECT * FROM telecom_email_batches WHERE id=$1', [req.params.id]);
      if (!batch) return res.status(404).json({ error: 'Not found' });
      if (batch.status !== 'prepared') return res.status(400).json({ error: `This batch is already ${batch.status} and cannot be discarded` });
      await db.query('BEGIN');
      await db.query(`UPDATE telecom_email_batches SET status='discarded', discarded_by=$1, discarded_at=NOW() WHERE id=$2`, [req.user.id, batch.id]);
      await db.query(`
        UPDATE mobile_change_requests SET status='approved', updated_at=NOW()
         WHERE status='email_prepared'
           AND id IN (SELECT change_request_id FROM telecom_email_batch_requests WHERE email_batch_id=$1)`, [batch.id]);
      await db.query('COMMIT');
      await logEvent({ entityType: 'batch', entityId: batch.id, action: 'email_discarded', from: 'prepared', to: 'discarded',
        user: req.user, detail: `${batch.operator} batch discarded — requests returned to the queue` });
      res.json({ ok: true });
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      sendError(res, e);
    } finally { db.release(); }
  });

  return { router, requests, batches, setup, logEvent, normaliseNumber, releaseLinesForExitedEmployees, OPERATORS, LINE_STATUSES };
};
