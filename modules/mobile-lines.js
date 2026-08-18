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

module.exports = function mobileLinesModule({ express, pool, auth, inScope, getProjectFilter, getClientFilter, sendError }) {
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

    // An assigned line must have a holder; an available or terminated one must
    // not. Without this a release that half-ran would leave a line that is
    // "available" yet still shows someone's name.
    await client.query(`DO $$ BEGIN
      ALTER TABLE mobile_lines ADD CONSTRAINT mobile_lines_holder_matches_status
        CHECK ((status = 'assigned' AND current_employee_id IS NOT NULL)
            OR (status <> 'assigned' AND current_employee_id IS NULL));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

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

  // ── Lines register ────────────────────────────────────────
  // Scoped exactly like every other person-linked resource: a supervisor or
  // project director sees the lines of people in their own projects/clients.
  // An UNASSIGNED line has no project, so it is only ever visible to HR/Admin --
  // which is also what keeps Available Lines off the Projects side entirely.
  const scopeClause = async (user, params) => {
    if (['admin', 'hr'].includes(user.role)) return '';
    const projects = await getProjectFilter(user);
    const clients = await getClientFilter(user);
    let w = ' AND e.id IS NOT NULL';
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
           p.id AS package_id, p.package_name, p.monthly_price AS package_price,
           cl.id AS credit_limit_id, cl.credit_limit,
           (SELECT COUNT(*)::int FROM mobile_change_requests r
             WHERE r.mobile_line_id = l.id
               AND r.status IN ('pending_approval','approved','email_prepared','sent_to_operator','partially_implemented')) AS pending_changes
      FROM mobile_lines l
      LEFT JOIN employees e ON e.id = l.current_employee_id
      LEFT JOIN telecom_packages p ON p.id = l.current_package_id
      LEFT JOIN telecom_credit_limits cl ON cl.id = l.current_credit_limit_id`;

  const registerWhere = async (req, params) => {
    const { search, operator, status, project, client, package_id, credit_limit_id, cug, roaming, unconfigured } = req.query;
    let w = ' WHERE 1=1';
    if (search) {
      params.push(`%${search}%`);
      w += ` AND (l.mobile_number ILIKE $${params.length} OR e.full_name ILIKE $${params.length} OR e.employee_number ILIKE $${params.length} OR e.national_id ILIKE $${params.length})`;
    }
    if (operator) { params.push(operator.split(',')); w += ` AND l.operator = ANY($${params.length})`; }
    if (status) { params.push(status.split(',')); w += ` AND l.status = ANY($${params.length})`; }
    if (project) { params.push(project.split(',')); w += ` AND e.project = ANY($${params.length})`; }
    if (client) { params.push(client.split(',')); w += ` AND e.client = ANY($${params.length})`; }
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
        `SELECT COUNT(*)::int AS total FROM mobile_lines l LEFT JOIN employees e ON e.id = l.current_employee_id ${where}`, params);
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
               COALESCE(SUM(l.monthly_price_snapshot) FILTER (WHERE l.status='assigned'), 0) AS monthly_assigned,
               COALESCE(SUM(l.monthly_price_snapshot) FILTER (WHERE l.status='available'), 0) AS monthly_idle
          FROM mobile_lines l LEFT JOIN employees e ON e.id = l.current_employee_id ${where}`, params);
      res.json(s);
    } catch (e) { sendError(res, e); }
  });

  router.get('/filter-options', auth, CAN_VIEW, async (req, res) => {
    try {
      const [projects, clients, packages, limits] = await Promise.all([
        pool.query(`SELECT DISTINCT e.project FROM mobile_lines l JOIN employees e ON e.id=l.current_employee_id WHERE NULLIF(TRIM(e.project),'') IS NOT NULL ORDER BY 1`),
        pool.query(`SELECT DISTINCT e.client FROM mobile_lines l JOIN employees e ON e.id=l.current_employee_id WHERE NULLIF(TRIM(e.client),'') IS NOT NULL ORDER BY 1`),
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

  return { router, setup, logEvent, normaliseNumber, OPERATORS, LINE_STATUSES };
};
