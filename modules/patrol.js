// ── OneHub Operations: Route Patrol ──────────────────────────
// Routes and cycles. A Planner starts a cycle and uploads one KMZ per
// area (NW, RIFT, ...); the KMZ is kept in the patrol R2 bucket and its lines
// and points are stored as rows so the map, distance checks and coverage can
// read them without re-parsing. Re-uploading an area inside a cycle replaces
// that area; past cycles are never edited, so their routes stay as they were.
//
// Like mobile-lines.js this takes its dependencies by injection, so server.js
// stays the only place that builds the pool and the auth middleware.

const multer = require('multer');
const JSZip = require('jszip');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Who may do what. Admin always may (see patrolRoleOf).
const ROUTE_EDIT_ROLES = ['admin', 'planner'];
const ROUTE_VIEW_ROLES = ['admin', 'patrol_officer', 'field_supervisor', 'pm_coordinator', 'planner', 'director'];
const KMZ_MAX_BYTES = 10 * 1024 * 1024;
// Patrol rules. Settings (a later stage) makes these adjustable.
const PATROL_ROLES = ['admin', 'patrol_officer'];
const PIN_MAX_FROM_OFFICER_M = 100;  // a pin may sit at most this far from the officer
const PIN_OFF_ROUTE_M = 100;         // further than this from every route line = Off route (warning only)
const PHOTOS_MIN = 1, PHOTOS_MAX = 3;
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
const PHOTO_RETENTION_DAYS = 60;     // ~2 months; photos on a pin with an open ticket are kept
const PIN_STATUSES = ['critical', 'medium', 'normal'];

// ── KML reading ───────────────────────────────────────────────
// KML is plain, regular XML. A small tokenizer is enough and avoids pulling in
// an XML library for one file format.
const decodeEntities = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

// Builds a light tree: { tag, children: [...], text }. Namespace prefixes
// (kml:, gx:) are dropped so <gx:Track> and <Track> read the same.
function parseXml(xml) {
  const root = { tag: '#root', children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[3]) {
      const tag = m[3].includes(':') ? m[3].split(':').pop() : m[3];
      if (m[2] === '/') {
        // Pop back to the matching open tag; tolerate a stray close tag.
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tag === tag) { stack.length = i; break; }
        }
      } else {
        const el = { tag, children: [], text: '' };
        top.children.push(el);
        if (m[5] !== '/') stack.push(el);
      }
      continue;
    }
    if (m[6] !== undefined) top.text += decodeEntities(m[6]);
  }
  return root;
}

const child = (el, tag) => el.children.find(c => c.tag === tag);
const textOf = (el, tag) => {
  const c = child(el, tag);
  return c ? c.text.trim() : '';
};
const descendants = (el, tag, out = []) => {
  for (const c of el.children) {
    if (c.tag === tag) out.push(c);
    descendants(c, tag, out);
  }
  return out;
};

// "lon,lat[,alt] lon,lat[,alt] ..." → [[lon, lat], ...]; malformed tuples dropped.
const parseCoords = (s) => String(s).trim().split(/\s+/).map(t => {
  const [lon, lat] = t.split(',').map(Number);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}).filter(Boolean);

const haversineM = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const lineLengthM = (pts) => pts.reduce((sum, p, i) => i ? sum + haversineM(pts[i - 1], p) : 0, 0);

// Shortest distance in metres from point p to the polyline pts ([lon, lat]).
// Projects onto a flat plane around p, which is accurate to well under a
// metre at the few-hundred-metre distances this is used for.
const distanceToLineM = (p, pts) => {
  const rad = Math.PI / 180, R = 6371000;
  const kx = Math.cos(p[1] * rad) * rad * R, ky = rad * R;
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const ax = (pts[i - 1][0] - p[0]) * kx, ay = (pts[i - 1][1] - p[1]) * ky;
    const bx = (pts[i][0] - p[0]) * kx, by = (pts[i][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const cx = ax + t * dx, cy = ay + t * dy;
    best = Math.min(best, Math.sqrt(cx * cx + cy * cy));
  }
  return best;
};

// Walks Document/Folder/Placemark and returns one feature per geometry. A
// Placemark holding a MultiGeometry gives several features with the same name.
function kmlToFeatures(xml) {
  const root = parseXml(xml);
  const features = [];
  let docName = '';
  const walk = (el, folders) => {
    for (const c of el.children) {
      if (c.tag === 'Document') {
        if (!docName) docName = textOf(c, 'name');
        walk(c, folders);
      } else if (c.tag === 'Folder') {
        const name = textOf(c, 'name');
        walk(c, name ? [...folders, name] : folders);
      } else if (c.tag === 'Placemark') {
        const name = textOf(c, 'name') || '(unnamed)';
        const folder = folders.join(' / ');
        for (const g of descendants(c, 'Point')) {
          const pts = parseCoords(textOf(g, 'coordinates'));
          if (pts.length) features.push({ kind: 'point', name, folder, coordinates: pts[0], length_m: null });
        }
        for (const g of descendants(c, 'LineString')) {
          const pts = parseCoords(textOf(g, 'coordinates'));
          if (pts.length >= 2) features.push({ kind: 'line', name, folder, coordinates: pts, length_m: Math.round(lineLengthM(pts) * 10) / 10 });
        }
        for (const g of descendants(c, 'Polygon')) {
          const ring = descendants(g, 'outerBoundaryIs')[0];
          const pts = ring ? parseCoords(descendants(ring, 'coordinates')[0]?.text || '') : [];
          if (pts.length >= 3) features.push({ kind: 'polygon', name, folder, coordinates: pts, length_m: null });
        }
      } else if (c.children.length) {
        walk(c, folders);
      }
    }
  };
  walk(root, []);
  // Google Earth wraps everything in a folder named after the file, which
  // would start every path with the same words. Drop it.
  const top = docName.replace(/\.kmz$/i, '').trim();
  if (top) for (const f of features) {
    if (f.folder === top) f.folder = '';
    else if (f.folder.startsWith(top + ' / ')) f.folder = f.folder.slice(top.length + 3);
  }
  return { docName: top || docName, features };
}

// A KMZ is a zip holding one main .kml (usually doc.kml) plus optional images.
async function readKmz(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { throw new Error('This file is not a valid KMZ.'); }
  const kmls = Object.values(zip.files).filter(f => !f.dir && /\.kml$/i.test(f.name));
  if (!kmls.length) throw new Error('No KML found inside this KMZ.');
  const main = kmls.find(f => /(^|\/)doc\.kml$/i.test(f.name)) || kmls[0];
  return kmlToFeatures(await main.async('string'));
}

// ── Dates ─────────────────────────────────────────────────────
// Calendar arithmetic on YYYY-MM-DD in UTC so no timezone shifts a day.
const dayBefore = (ymd) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
// Today in East Africa, where every patrol happens.
const todayEAT = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

const cleanArea = (s) => String(s || '').replace(/[\\/\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

module.exports = function patrolModule({ express, pool, auth, sendError }) {
  const router = express.Router();

  // Its own bucket and key, scoped to that bucket only -- a leak here cannot
  // reach the training certificates.
  const PATROL_R2_BUCKET = process.env.PATROL_R2_BUCKET;
  const R2_READY = !!(process.env.R2_ACCOUNT_ID && process.env.PATROL_R2_ACCESS_KEY_ID && process.env.PATROL_R2_SECRET_ACCESS_KEY && PATROL_R2_BUCKET);
  const r2 = R2_READY ? new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.PATROL_R2_ACCESS_KEY_ID, secretAccessKey: process.env.PATROL_R2_SECRET_ACCESS_KEY },
  }) : null;

  // cycle id → its route lines, for the off-route check. Cleared on upload/remove.
  const routeCache = new Map();

  const kmzUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: KMZ_MAX_BYTES },
    fileFilter: (req, file, cb) => {
      if (/\.kmz$/i.test(file.originalname || '')) cb(null, true);
      else cb(new Error('Upload a .kmz file.'));
    },
  });

  // ── Schema ────────────────────────────────────────────────
  const setup = async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS patrol_cycles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(120) NOT NULL,
        starts_on DATE NOT NULL UNIQUE,
        ends_on DATE,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CHECK (ends_on >= starts_on)
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS patrol_route_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cycle_id UUID NOT NULL REFERENCES patrol_cycles(id) ON DELETE CASCADE,
        area VARCHAR(80) NOT NULL,
        original_filename VARCHAR(255),
        document_name TEXT,
        r2_key TEXT,
        size_bytes INTEGER,
        uploaded_by UUID REFERENCES users(id),
        uploaded_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (cycle_id, area)
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS patrol_routes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_id UUID NOT NULL REFERENCES patrol_route_files(id) ON DELETE CASCADE,
        cycle_id UUID NOT NULL REFERENCES patrol_cycles(id) ON DELETE CASCADE,
        area VARCHAR(80) NOT NULL,
        kind VARCHAR(10) NOT NULL CHECK (kind IN ('line','point','polygon')),
        name TEXT,
        folder TEXT,
        coordinates JSONB NOT NULL,
        length_m NUMERIC(12,1),
        sort_order INTEGER
      )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_patrol_routes_cycle ON patrol_routes(cycle_id)');
    // The areas a KMZ can be uploaded for, kept by the admin (Admin Panel).
    // Routes refer to an area by its name; renaming an area renames it on every
    // upload too, in one transaction (see PUT /areas/:id).
    await client.query(`
      CREATE TABLE IF NOT EXISTS patrol_areas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(80) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_patrol_areas_name ON patrol_areas (LOWER(name))');
    const { rows: [{ n }] } = await client.query('SELECT COUNT(*)::int AS n FROM patrol_areas');
    if (n === 0) {
      await client.query(`INSERT INTO patrol_areas (name, sort_order) VALUES ('Nairobi West', 1), ('Rift', 2)`);
    }
    // ── Patrols, pins, photos ──
    // What an officer reports. Observation types are an admin list, like areas;
    // a pin keeps the label it was saved with, so renaming a type later does
    // not rewrite what an officer reported.
    await client.query(`
      CREATE TABLE IF NOT EXISTS patrol_observation_types (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        label VARCHAR(120) NOT NULL,
        category VARCHAR(60),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_patrol_obs_label ON patrol_observation_types (LOWER(label))');
    const { rows: [{ nt }] } = await client.query('SELECT COUNT(*)::int AS nt FROM patrol_observation_types');
    if (nt === 0) {
      const seed = [
        ['Third-party works', ['Road construction', 'General construction', 'Excavation near the route', 'Heavy machinery on the route', 'Other utility works', 'Drilling or boring', 'Tree cutting or land clearing']],
        ['Route infrastructure', ['Exposed cable', 'Damaged or cut cable', 'Manhole or handhole damaged or open', 'Route marker missing or damaged', 'Warning sign missing or damaged', 'Cabinet or pole damaged']],
        ['Environment', ['Flooding or standing water', 'Soil erosion or washout', 'Ground collapse', 'Fire near the route', 'Vegetation overgrowth']],
        ['Security and public', ['Demonstrations or crowds', 'Vandalism or theft', 'Unauthorised people on the route', 'Encroachment on the right-of-way', 'Dumping or debris on the route']],
        ['Access', ['Route blocked', 'Checkpoint not reachable']],
        ['General', ['Route clear, no issues', 'Other']],
      ];
      let order = 0;
      for (const [category, labels] of seed) {
        for (const label of labels) {
          await client.query('INSERT INTO patrol_observation_types (label, category, sort_order) VALUES ($1,$2,$3)', [label, category, ++order]);
        }
      }
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS patrols (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        officer_id UUID NOT NULL REFERENCES users(id),
        cycle_id UUID NOT NULL REFERENCES patrol_cycles(id),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      )`);
    // One running patrol per officer at a time.
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_patrols_running ON patrols (officer_id) WHERE ended_at IS NULL');
    await client.query(`
      CREATE TABLE IF NOT EXISTS patrol_pins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patrol_id UUID NOT NULL REFERENCES patrols(id),
        cycle_id UUID NOT NULL REFERENCES patrol_cycles(id),
        officer_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lat DOUBLE PRECISION NOT NULL,
        lon DOUBLE PRECISION NOT NULL,
        officer_lat DOUBLE PRECISION NOT NULL,
        officer_lon DOUBLE PRECISION NOT NULL,
        gps_accuracy_m REAL,
        distance_from_officer_m REAL NOT NULL,
        distance_to_route_m REAL,
        nearest_route_name TEXT,
        nearest_route_area VARCHAR(80),
        off_route BOOLEAN NOT NULL DEFAULT FALSE,
        name VARCHAR(160) NOT NULL,
        location_note TEXT,
        observation_type_id UUID REFERENCES patrol_observation_types(id),
        observation_label VARCHAR(120) NOT NULL,
        status VARCHAR(10) NOT NULL CHECK (status IN ('critical','medium','normal')),
        review_status VARCHAR(20) NOT NULL DEFAULT 'awaiting_review',
        ticket_status VARCHAR(10)
      )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_patrol_pins_patrol ON patrol_pins(patrol_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_patrol_pins_created ON patrol_pins(created_at)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS patrol_pin_photos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pin_id UUID NOT NULL REFERENCES patrol_pins(id) ON DELETE CASCADE,
        position SMALLINT NOT NULL,
        r2_key TEXT,
        thumb_key TEXT,
        size_bytes INTEGER,
        captured_at TIMESTAMPTZ,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION,
        removed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    // Who did what to a pin, when. Append-only; review and ticket steps join
    // it in a later stage.
    await client.query(`
      CREATE TABLE IF NOT EXISTS patrol_pin_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pin_id UUID NOT NULL REFERENCES patrol_pins(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id),
        action VARCHAR(40) NOT NULL,
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

    // Before the list existed the area was typed in, suggested from the file
    // name as NW / RIFT. Bring any such upload onto the listed names.
    for (const [from, to] of [['NW', 'Nairobi West'], ['RIFT', 'Rift']]) {
      await client.query('UPDATE patrol_route_files SET area=$2 WHERE area=$1', [from, to]);
      await client.query('UPDATE patrol_routes SET area=$2 WHERE area=$1', [from, to]);
    }
    // Cycles have no fixed length (about 3 months, sometimes more or less): one
    // runs until the next is started, so only a superseded cycle has an end
    // date. The first deploy stored a 3-month end on every cycle; undo that for
    // the latest one, which by this rule is always open.
    await client.query('ALTER TABLE patrol_cycles ALTER COLUMN ends_on DROP NOT NULL');
    await client.query(`UPDATE patrol_cycles SET ends_on = NULL
      WHERE ends_on IS NOT NULL AND starts_on = (SELECT MAX(starts_on) FROM patrol_cycles)`);
  };

  // ── Access ────────────────────────────────────────────────
  const patrolRoleOf = (user) => user.role === 'admin' ? 'admin' : (user.patrol_role || null);
  const allow = (roles) => (req, res, next) => {
    if (roles.includes(patrolRoleOf(req.user))) return next();
    res.status(403).json({ error: 'Not authorized' });
  };

  // ── Cycles ────────────────────────────────────────────────
  const cycleRows = async (db = pool) => {
    const { rows } = await db.query(`
      SELECT c.id, c.name, to_char(c.starts_on,'YYYY-MM-DD') AS starts_on, to_char(c.ends_on,'YYYY-MM-DD') AS ends_on,
             c.created_at, u.full_name AS created_by_name
      FROM patrol_cycles c LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.starts_on DESC`);
    return rows;
  };
  // The cycle in force today: the latest one that has started.
  const currentCycleId = (cycles, today = todayEAT()) => cycles.find(c => c.starts_on <= today)?.id || null;

  router.get('/cycles', auth, allow(ROUTE_VIEW_ROLES), async (req, res) => {
    try {
      const cycles = await cycleRows();
      const { rows: areas } = await pool.query(`
        SELECT f.id, f.cycle_id, f.area, f.original_filename, f.document_name, f.size_bytes, f.uploaded_at,
               (f.r2_key IS NOT NULL) AS has_file, u.full_name AS uploaded_by_name,
               COUNT(r.id) FILTER (WHERE r.kind = 'line')::int AS lines,
               COUNT(r.id) FILTER (WHERE r.kind = 'point')::int AS points,
               COALESCE(ROUND(SUM(r.length_m) / 1000.0, 1), 0)::float AS length_km
        FROM patrol_route_files f
        LEFT JOIN users u ON u.id = f.uploaded_by
        LEFT JOIN patrol_routes r ON r.file_id = f.id
        GROUP BY f.id, u.full_name
        ORDER BY f.area`);
      const today = todayEAT();
      const current = currentCycleId(cycles, today);
      res.json({
        today,
        current_cycle_id: current,
        can_edit: ROUTE_EDIT_ROLES.includes(patrolRoleOf(req.user)),
        file_storage: R2_READY,
        cycles: cycles.map(c => ({
          ...c,
          status: c.id === current ? 'current' : (c.starts_on > today ? 'upcoming' : 'past'),
          areas: areas.filter(a => a.cycle_id === c.id),
        })),
      });
    } catch (e) { sendError(res, e); }
  });

  // A cycle runs until the next one is started. Starting one closes the cycle
  // before it on the day before, so cycles never overlap and every date
  // belongs to exactly one.
  // The start date is always today (East Africa time). It is not taken from
  // the request: nobody may back-date or pre-date a cycle.
  router.post('/cycles', auth, allow(ROUTE_EDIT_ROLES), async (req, res) => {
    const starts = todayEAT();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE patrol_cycles IN SHARE ROW EXCLUSIVE MODE');
      const cycles = await cycleRows(client);
      const latest = cycles[0];
      if (latest && starts <= latest.starts_on) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `${latest.name} already started today. A new cycle can be started from tomorrow.` });
      }
      if (latest) {
        await client.query('UPDATE patrol_cycles SET ends_on = $1 WHERE id = $2', [dayBefore(starts), latest.id]);
      }
      const name = String(req.body?.name || '').trim().slice(0, 120) || `Cycle ${cycles.length + 1}`;
      const { rows } = await client.query(
        'INSERT INTO patrol_cycles (name, starts_on, created_by) VALUES ($1,$2,$3) RETURNING id',
        [name, starts, req.user.id]);
      await client.query('COMMIT');
      res.status(201).json({ id: rows[0].id });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); sendError(res, e); }
    finally { client.release(); }
  });

  // Only the current and upcoming cycles take uploads; a past cycle is a record.
  const editableCycle = async (cycleId) => {
    const cycles = await cycleRows();
    const c = cycles.find(x => x.id === cycleId);
    if (!c) return { error: 'Cycle not found.', status: 404 };
    const current = currentCycleId(cycles);
    if (c.id !== current && c.starts_on <= todayEAT()) return { error: 'This cycle has ended, so its routes can no longer change.', status: 400 };
    return { cycle: c };
  };

  // ── Area list (admin-kept) ────────────────────────────────
  const ADMIN = ['admin'];
  router.get('/areas', auth, allow(ROUTE_VIEW_ROLES), async (req, res) => {
    try {
      const all = req.query.all === '1' && patrolRoleOf(req.user) === 'admin';
      const { rows } = await pool.query(`
        SELECT a.id, a.name, a.is_active, a.sort_order,
               (SELECT COUNT(*)::int FROM patrol_route_files f WHERE f.area = a.name) AS uploads
        FROM patrol_areas a ${all ? '' : 'WHERE a.is_active'}
        ORDER BY a.sort_order, a.name`);
      res.json(rows);
    } catch (e) { sendError(res, e); }
  });

  router.post('/areas', auth, allow(ADMIN), async (req, res) => {
    const name = cleanArea(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Enter the area name.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO patrol_areas (name, sort_order)
         VALUES ($1, (SELECT COALESCE(MAX(sort_order),0)+1 FROM patrol_areas))
         RETURNING id, name, is_active, sort_order, 0 AS uploads`, [name]);
      res.status(201).json(rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'That area is already in the list.' });
      sendError(res, e);
    }
  });

  router.put('/areas/:id', auth, allow(ADMIN), async (req, res) => {
    const name = cleanArea(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Enter the area name.' });
    const active = req.body?.is_active !== false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [cur] } = await client.query('SELECT name FROM patrol_areas WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!cur) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Area not found.' }); }
      await client.query('UPDATE patrol_areas SET name=$1, is_active=$2 WHERE id=$3', [name, active, req.params.id]);
      if (cur.name !== name) {
        await client.query('UPDATE patrol_route_files SET area=$1 WHERE area=$2', [name, cur.name]);
        await client.query('UPDATE patrol_routes SET area=$1 WHERE area=$2', [name, cur.name]);
      }
      const { rows } = await client.query(`
        SELECT a.id, a.name, a.is_active, a.sort_order,
               (SELECT COUNT(*)::int FROM patrol_route_files f WHERE f.area = a.name) AS uploads
        FROM patrol_areas a WHERE a.id=$1`, [req.params.id]);
      await client.query('COMMIT');
      res.json(rows[0]);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') return res.status(409).json({ error: 'That area is already in the list.' });
      sendError(res, e);
    } finally { client.release(); }
  });

  // Only an area nothing was ever uploaded for can be deleted; otherwise it is
  // deactivated, which keeps past cycles readable.
  router.delete('/areas/:id', auth, allow(ADMIN), async (req, res) => {
    try {
      const { rows: [a] } = await pool.query(`
        SELECT a.name, (SELECT COUNT(*)::int FROM patrol_route_files f WHERE f.area = a.name) AS uploads
        FROM patrol_areas a WHERE a.id=$1`, [req.params.id]);
      if (!a) return res.status(404).json({ error: 'Area not found.' });
      if (a.uploads > 0) return res.status(400).json({ error: `${a.name} has routes uploaded, so it can only be deactivated.` });
      await pool.query('DELETE FROM patrol_areas WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  });

  // ── Areas in a cycle (one KMZ each) ───────────────────────
  router.post('/cycles/:id/areas', auth, allow(ROUTE_EDIT_ROLES), (req, res) => {
    kmzUpload.single('kmz')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The KMZ must be 10 MB or smaller.' : (err.message || 'Upload rejected') });
      if (!req.file) return res.status(400).json({ error: 'Choose a KMZ file to upload.' });
      const { rows: [listed] } = await pool.query(
        'SELECT name FROM patrol_areas WHERE is_active AND LOWER(name)=LOWER($1)', [cleanArea(req.body?.area)]);
      if (!listed) return res.status(400).json({ error: 'Pick an area from the list.' });
      const area = listed.name;

      let parsed;
      try { parsed = await readKmz(req.file.buffer); } catch (e) { return res.status(400).json({ error: e.message }); }
      if (!parsed.features.some(f => f.kind === 'line')) return res.status(400).json({ error: 'This KMZ has no route lines in it.' });

      const client = await pool.connect();
      let r2Key = null;
      try {
        const check = await editableCycle(req.params.id);
        if (check.error) return res.status(check.status).json({ error: check.error });
        const cycle = check.cycle;

        if (R2_READY) {
          r2Key = `routes/${cycle.starts_on}/${area}/${Date.now()}-${req.file.originalname.replace(/[\\/\r\n\t]+/g, ' ')}`;
          await r2.send(new PutObjectCommand({ Bucket: PATROL_R2_BUCKET, Key: r2Key, Body: req.file.buffer, ContentType: 'application/vnd.google-earth.kmz' }));
        }

        await client.query('BEGIN');
        const { rows: old } = await client.query('SELECT id, r2_key FROM patrol_route_files WHERE cycle_id=$1 AND LOWER(area)=LOWER($2)', [cycle.id, area]);
        if (old[0]) await client.query('DELETE FROM patrol_route_files WHERE id=$1', [old[0].id]); // routes cascade
        const { rows: [file] } = await client.query(
          `INSERT INTO patrol_route_files (cycle_id, area, original_filename, document_name, r2_key, size_bytes, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [cycle.id, area, req.file.originalname.slice(0, 255), parsed.docName || null, r2Key, req.file.size, req.user.id]);
        // One multi-row insert per batch keeps a 300-feature file to a few round trips.
        const BATCH = 200;
        for (let i = 0; i < parsed.features.length; i += BATCH) {
          const chunk = parsed.features.slice(i, i + BATCH);
          const params = [];
          const values = chunk.map((f, j) => {
            params.push(file.id, cycle.id, area, f.kind, f.name, f.folder || null, JSON.stringify(f.coordinates), f.length_m, i + j);
            const b = j * 9;
            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::jsonb,$${b + 8},$${b + 9})`;
          });
          await client.query(`INSERT INTO patrol_routes (file_id, cycle_id, area, kind, name, folder, coordinates, length_m, sort_order) VALUES ${values.join(',')}`, params);
        }
        await client.query('COMMIT');
        routeCache.delete(cycle.id);
        // The replaced file goes only once the new one is safely in.
        if (old[0]?.r2_key && R2_READY) r2.send(new DeleteObjectCommand({ Bucket: PATROL_R2_BUCKET, Key: old[0].r2_key })).catch(() => {});

        const lines = parsed.features.filter(f => f.kind === 'line');
        res.status(201).json({
          id: file.id, area, replaced: !!old[0],
          lines: lines.length,
          points: parsed.features.filter(f => f.kind === 'point').length,
          length_km: Math.round(lines.reduce((s, f) => s + f.length_m, 0) / 100) / 10,
        });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (r2Key && R2_READY) r2.send(new DeleteObjectCommand({ Bucket: PATROL_R2_BUCKET, Key: r2Key })).catch(() => {});
        sendError(res, e);
      } finally { client.release(); }
    });
  });

  router.delete('/cycles/:id/areas/:fileId', auth, allow(ROUTE_EDIT_ROLES), async (req, res) => {
    try {
      const check = await editableCycle(req.params.id);
      if (check.error) return res.status(check.status).json({ error: check.error });
      const { rows } = await pool.query('DELETE FROM patrol_route_files WHERE id=$1 AND cycle_id=$2 RETURNING r2_key', [req.params.fileId, req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Area not found in this cycle.' });
      routeCache.delete(req.params.id);
      if (rows[0].r2_key && R2_READY) r2.send(new DeleteObjectCommand({ Bucket: PATROL_R2_BUCKET, Key: rows[0].r2_key })).catch(() => {});
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  });

  // Short-lived link to the original KMZ, so any cycle can be opened in Google
  // Earth exactly as it was uploaded.
  router.get('/areas/:fileId/download', auth, allow(ROUTE_VIEW_ROLES), async (req, res) => {
    try {
      if (!R2_READY) return res.status(503).json({ error: 'File storage is not configured yet.' });
      const { rows } = await pool.query('SELECT r2_key, original_filename FROM patrol_route_files WHERE id=$1', [req.params.fileId]);
      if (!rows[0]?.r2_key) return res.status(404).json({ error: 'The original file is not stored for this area.' });
      const url = await getSignedUrl(r2, new GetObjectCommand({
        Bucket: PATROL_R2_BUCKET, Key: rows[0].r2_key,
        ResponseContentDisposition: `attachment; filename="${(rows[0].original_filename || 'route.kmz').replace(/"/g, '')}"`,
      }), { expiresIn: 300 });
      res.json({ url });
    } catch (e) { sendError(res, e); }
  });

  // The map's data: every route and site in a cycle, as GeoJSON.
  router.get('/cycles/:id/routes', auth, allow(ROUTE_VIEW_ROLES), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, area, kind, name, folder, coordinates, length_m::float AS length_m
         FROM patrol_routes WHERE cycle_id=$1 ORDER BY area, sort_order`, [req.params.id]);
      res.json({
        type: 'FeatureCollection',
        features: rows.map(r => ({
          type: 'Feature',
          id: r.id,
          geometry: r.kind === 'point' ? { type: 'Point', coordinates: r.coordinates }
            : r.kind === 'line' ? { type: 'LineString', coordinates: r.coordinates }
            : { type: 'Polygon', coordinates: [r.coordinates] },
          properties: { area: r.area, kind: r.kind, name: r.name, folder: r.folder, length_m: r.length_m },
        })),
      });
    } catch (e) { sendError(res, e); }
  });


  // ── Observation types (admin-kept) ────────────────────────
  router.get('/observation-types', auth, allow(ROUTE_VIEW_ROLES), async (req, res) => {
    try {
      const all = req.query.all === '1' && patrolRoleOf(req.user) === 'admin';
      const { rows } = await pool.query(`
        SELECT id, label, category, is_active, sort_order FROM patrol_observation_types
        ${all ? '' : 'WHERE is_active'} ORDER BY sort_order, label`);
      res.json(rows);
    } catch (e) { sendError(res, e); }
  });

  const cleanLabel = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
  router.post('/observation-types', auth, allow(ADMIN), async (req, res) => {
    const label = cleanLabel(req.body?.label, 120);
    if (!label) return res.status(400).json({ error: 'Enter the observation type.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO patrol_observation_types (label, category, sort_order)
         VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order),0)+1 FROM patrol_observation_types))
         RETURNING id, label, category, is_active, sort_order`,
        [label, cleanLabel(req.body?.category, 60) || null]);
      res.status(201).json(rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'That observation type is already in the list.' });
      sendError(res, e);
    }
  });

  router.put('/observation-types/:id', auth, allow(ADMIN), async (req, res) => {
    const label = cleanLabel(req.body?.label, 120);
    if (!label) return res.status(400).json({ error: 'Enter the observation type.' });
    try {
      const { rows } = await pool.query(
        `UPDATE patrol_observation_types SET label=$1, category=$2, is_active=$3 WHERE id=$4
         RETURNING id, label, category, is_active, sort_order`,
        [label, cleanLabel(req.body?.category, 60) || null, req.body?.is_active !== false, req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Observation type not found.' });
      res.json(rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'That observation type is already in the list.' });
      sendError(res, e);
    }
  });

  router.delete('/observation-types/:id', auth, allow(ADMIN), async (req, res) => {
    try {
      const { rows: [{ used }] } = await pool.query('SELECT COUNT(*)::int AS used FROM patrol_pins WHERE observation_type_id=$1', [req.params.id]);
      if (used) return res.status(400).json({ error: 'Pins already use this type, so it can only be deactivated.' });
      await pool.query('DELETE FROM patrol_observation_types WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  });

  // ── Patrols ───────────────────────────────────────────────
  // The route lines of a cycle, kept in memory for the off-route check:
  // ~120 lines, read once per cycle rather than on every pin.
  const linesForCycle = async (cycleId) => {
    if (!routeCache.has(cycleId)) {
      const { rows } = await pool.query(
        "SELECT name, area, coordinates FROM patrol_routes WHERE cycle_id=$1 AND kind='line'", [cycleId]);
      routeCache.set(cycleId, rows);
    }
    return routeCache.get(cycleId);
  };

  const patrolSummary = async (patrolId) => {
    const { rows: [p] } = await pool.query(`
      SELECT p.id, p.cycle_id, p.started_at, p.ended_at, c.name AS cycle_name
      FROM patrols p JOIN patrol_cycles c ON c.id = p.cycle_id WHERE p.id=$1`, [patrolId]);
    if (!p) return null;
    const { rows: pins } = await pool.query(`
      SELECT id, created_at, lat, lon, name, location_note, observation_label, status, off_route,
             distance_to_route_m, nearest_route_name,
             (SELECT COUNT(*)::int FROM patrol_pin_photos ph WHERE ph.pin_id = pp.id) AS photos
      FROM patrol_pins pp WHERE patrol_id=$1 ORDER BY created_at`, [patrolId]);
    return { ...p, pins };
  };

  // The officer's running patrol, if any, with its pins so far.
  router.get('/patrols/mine', auth, allow(PATROL_ROLES), async (req, res) => {
    try {
      const { rows: [run] } = await pool.query('SELECT id FROM patrols WHERE officer_id=$1 AND ended_at IS NULL', [req.user.id]);
      const cycles = await cycleRows();
      res.json({
        patrol: run ? await patrolSummary(run.id) : null,
        current_cycle_id: currentCycleId(cycles),
        rules: { pin_max_from_officer_m: PIN_MAX_FROM_OFFICER_M, pin_off_route_m: PIN_OFF_ROUTE_M, photos_min: PHOTOS_MIN, photos_max: PHOTOS_MAX },
        photo_storage: R2_READY,
      });
    } catch (e) { sendError(res, e); }
  });

  router.post('/patrols', auth, allow(PATROL_ROLES), async (req, res) => {
    try {
      const cycleId = currentCycleId(await cycleRows());
      if (!cycleId) return res.status(400).json({ error: 'No patrol cycle has started yet. A Planner needs to start one on Routes.' });
      const { rows: [run] } = await pool.query('SELECT id FROM patrols WHERE officer_id=$1 AND ended_at IS NULL', [req.user.id]);
      if (run) return res.json(await patrolSummary(run.id)); // already running: carry on with it
      const { rows: [p] } = await pool.query('INSERT INTO patrols (officer_id, cycle_id) VALUES ($1,$2) RETURNING id', [req.user.id, cycleId]);
      res.status(201).json(await patrolSummary(p.id));
    } catch (e) {
      if (e.code === '23505') { // a double tap raced the first start
        const { rows: [run] } = await pool.query('SELECT id FROM patrols WHERE officer_id=$1 AND ended_at IS NULL', [req.user.id]);
        if (run) return res.json(await patrolSummary(run.id));
      }
      sendError(res, e);
    }
  });

  router.post('/patrols/:id/end', auth, allow(PATROL_ROLES), async (req, res) => {
    try {
      const { rows } = await pool.query(
        'UPDATE patrols SET ended_at=NOW() WHERE id=$1 AND officer_id=$2 AND ended_at IS NULL RETURNING id', [req.params.id, req.user.id]);
      if (!rows[0]) return res.status(404).json({ error: 'This patrol is not running.' });
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  });

  // ── Pins ──────────────────────────────────────────────────
  // One request carries the pin and its photos: full size (photo0..2) and the
  // matching thumbnails (thumb0..2), both made and stamped on the phone.
  const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PHOTO_MAX_BYTES, files: PHOTOS_MAX * 2 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype === 'image/jpeg') cb(null, true);
      else cb(new Error('Photos must be JPEG.'));
    },
  }).fields([...Array(PHOTOS_MAX)].flatMap((_, i) => [{ name: `photo${i}`, maxCount: 1 }, { name: `thumb${i}`, maxCount: 1 }]));

  const num = (v) => (v === '' || v == null) ? NaN : Number(v);
  const validLatLon = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  router.post('/patrols/:id/pins', auth, allow(PATROL_ROLES), (req, res) => {
    photoUpload(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A photo is too large.' : (err.message || 'Upload rejected') });
      const b = req.body || {};
      const lat = num(b.lat), lon = num(b.lon), oLat = num(b.officer_lat), oLon = num(b.officer_lon);
      if (!validLatLon(lat, lon) || !validLatLon(oLat, oLon)) return res.status(400).json({ error: 'Your location is missing. Turn on location and try again.' });
      const name = cleanLabel(b.name, 160);
      if (!name) return res.status(400).json({ error: 'Give the point a name.' });
      const status = String(b.status || '');
      if (!PIN_STATUSES.includes(status)) return res.status(400).json({ error: 'Pick a status: Critical, Medium or Normal.' });

      const files = req.files || {};
      const photos = [...Array(PHOTOS_MAX)].map((_, i) => ({ full: files[`photo${i}`]?.[0], thumb: files[`thumb${i}`]?.[0] })).filter(x => x.full);
      if (photos.length < PHOTOS_MIN) return res.status(400).json({ error: `Take at least ${PHOTOS_MIN} photo.` });
      let meta = [];
      try { meta = JSON.parse(b.photos_meta || '[]'); } catch { meta = []; }

      // The pin has to sit near the officer. Both positions come from the
      // phone; this stops a pin being dropped across town from where they stand.
      const fromOfficer = haversineM([oLon, oLat], [lon, lat]);
      if (fromOfficer > PIN_MAX_FROM_OFFICER_M + 1) {
        return res.status(400).json({ error: `The pin is ${Math.round(fromOfficer)} m from you. It must be within ${PIN_MAX_FROM_OFFICER_M} m.` });
      }

      const keys = [];
      try {
        const { rows: [patrol] } = await pool.query(
          'SELECT id, cycle_id FROM patrols WHERE id=$1 AND officer_id=$2 AND ended_at IS NULL', [req.params.id, req.user.id]);
        if (!patrol) return res.status(400).json({ error: 'This patrol has ended. Start a new patrol to add pins.' });
        if (!R2_READY) return res.status(503).json({ error: 'Photo storage is not set up yet.' });

        const { rows: [type] } = await pool.query('SELECT id, label FROM patrol_observation_types WHERE id=$1 AND is_active', [b.observation_type_id || null]);
        if (!type) return res.status(400).json({ error: 'Pick an observation type.' });

        let nearest = null;
        for (const line of await linesForCycle(patrol.cycle_id)) {
          const d = distanceToLineM([lon, lat], line.coordinates);
          if (!nearest || d < nearest.d) nearest = { d, name: line.name, area: line.area };
        }
        const offRoute = !nearest || nearest.d > PIN_OFF_ROUTE_M;

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows: [pin] } = await client.query(`
            INSERT INTO patrol_pins (patrol_id, cycle_id, officer_id, lat, lon, officer_lat, officer_lon, gps_accuracy_m,
              distance_from_officer_m, distance_to_route_m, nearest_route_name, nearest_route_area, off_route,
              name, location_note, observation_type_id, observation_label, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id, created_at`,
            [patrol.id, patrol.cycle_id, req.user.id, lat, lon, oLat, oLon, Number.isFinite(num(b.accuracy)) ? num(b.accuracy) : null,
             Math.round(fromOfficer * 10) / 10, nearest ? Math.round(nearest.d * 10) / 10 : null, nearest?.name || null, nearest?.area || null, offRoute,
             name, cleanLabel(b.location_note, 500) || null, type.id, type.label, status]);

          const month = new Date().toISOString().slice(0, 7);
          for (let i = 0; i < photos.length; i++) {
            const m = meta[i] || {};
            const base = `photos/${month}/${pin.id}/${i + 1}`;
            await r2.send(new PutObjectCommand({ Bucket: PATROL_R2_BUCKET, Key: `${base}.jpg`, Body: photos[i].full.buffer, ContentType: 'image/jpeg' }));
            keys.push(`${base}.jpg`);
            let thumbKey = null;
            if (photos[i].thumb) {
              await r2.send(new PutObjectCommand({ Bucket: PATROL_R2_BUCKET, Key: `${base}-thumb.jpg`, Body: photos[i].thumb.buffer, ContentType: 'image/jpeg' }));
              keys.push(`${base}-thumb.jpg`);
              thumbKey = `${base}-thumb.jpg`;
            }
            const captured = m.captured_at && !isNaN(Date.parse(m.captured_at)) ? m.captured_at : null;
            const pLat = num(m.lat), pLon = num(m.lon);
            await client.query(`
              INSERT INTO patrol_pin_photos (pin_id, position, r2_key, thumb_key, size_bytes, captured_at, lat, lon)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [pin.id, i + 1, `${base}.jpg`, thumbKey, photos[i].full.size, captured,
               validLatLon(pLat, pLon) ? pLat : null, validLatLon(pLat, pLon) ? pLon : null]);
          }
          await client.query(
            "INSERT INTO patrol_pin_events (pin_id, user_id, action, detail) VALUES ($1,$2,'created',$3)",
            [pin.id, req.user.id, JSON.stringify({ status, observation: type.label, off_route: offRoute })]);
          await client.query('COMMIT');
          res.status(201).json({
            id: pin.id, created_at: pin.created_at, off_route: offRoute,
            distance_to_route_m: nearest ? Math.round(nearest.d) : null, nearest_route_name: nearest?.name || null,
          });
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally { client.release(); }
      } catch (e) {
        for (const k of keys) r2.send(new DeleteObjectCommand({ Bucket: PATROL_R2_BUCKET, Key: k })).catch(() => {});
        sendError(res, e);
      }
    });
  });

  // One pin with short-lived photo links. An officer sees only their own pins;
  // every other Operations role sees all of them.
  router.get('/pins/:id', auth, allow(ROUTE_VIEW_ROLES), async (req, res) => {
    try {
      const { rows: [pin] } = await pool.query(`
        SELECT pp.*, u.full_name AS officer_name FROM patrol_pins pp JOIN users u ON u.id = pp.officer_id WHERE pp.id=$1`, [req.params.id]);
      if (!pin) return res.status(404).json({ error: 'Pin not found.' });
      if (patrolRoleOf(req.user) === 'patrol_officer' && pin.officer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
      const { rows: photos } = await pool.query(
        'SELECT id, position, r2_key, thumb_key, captured_at, removed_at FROM patrol_pin_photos WHERE pin_id=$1 ORDER BY position', [pin.id]);
      const sign = (key) => key && R2_READY ? getSignedUrl(r2, new GetObjectCommand({ Bucket: PATROL_R2_BUCKET, Key: key }), { expiresIn: 600 }) : null;
      res.json({
        ...pin,
        photos: await Promise.all(photos.map(async ph => ({
          id: ph.id, position: ph.position, captured_at: ph.captured_at, removed_at: ph.removed_at,
          url: ph.removed_at ? null : await sign(ph.r2_key),
          thumb_url: ph.removed_at ? null : await sign(ph.thumb_key || ph.r2_key),
        }))),
      });
    } catch (e) { sendError(res, e); }
  });

  // ── Photo retention ───────────────────────────────────────
  // Daily: photos older than PHOTO_RETENTION_DAYS are deleted from storage and
  // marked removed. The pin and its details stay. Photos on a pin whose ticket
  // is still open are kept until the ticket closes.
  const sweepOldPhotos = async () => {
    if (!R2_READY) return;
    try {
      const { rows } = await pool.query(`
        SELECT ph.id, ph.r2_key, ph.thumb_key FROM patrol_pin_photos ph
        JOIN patrol_pins p ON p.id = ph.pin_id
        WHERE ph.removed_at IS NULL
          AND COALESCE(ph.captured_at, ph.created_at) < NOW() - ($1 || ' days')::interval
          AND p.ticket_status IS DISTINCT FROM 'open'
        LIMIT 2000`, [String(PHOTO_RETENTION_DAYS)]);
      for (const ph of rows) {
        for (const key of [ph.r2_key, ph.thumb_key].filter(Boolean)) {
          await r2.send(new DeleteObjectCommand({ Bucket: PATROL_R2_BUCKET, Key: key })).catch(() => {});
        }
        await pool.query('UPDATE patrol_pin_photos SET removed_at=NOW() WHERE id=$1', [ph.id]);
      }
      if (rows.length) console.log(`Patrol photos removed after ${PHOTO_RETENTION_DAYS} days: ${rows.length}`);
    } catch (e) { console.error('Patrol photo sweep failed:', e.message); }
  };
  // 03:00 East Africa time (00:00 UTC), then every 24 hours.
  const msToNext = () => { const n = new Date(); const t = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)); return t - n; };
  setTimeout(() => { sweepOldPhotos(); setInterval(sweepOldPhotos, 24 * 3600 * 1000); }, msToNext());

  return { router, setup, _internals: { readKmz, kmlToFeatures, distanceToLineM } };
};
