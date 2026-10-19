// ── OneHub Operations: Route Patrol ──────────────────────────
// Routes and 3-month cycles. A Planner starts a cycle and uploads one KMZ per
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
// Settings (stage 7) will make this adjustable; until then a cycle is 3 months.
const CYCLE_MONTHS = 3;
const KMZ_MAX_BYTES = 10 * 1024 * 1024;

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
const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
// Calendar arithmetic on YYYY-MM-DD in UTC so no timezone shifts a day.
// Day before the same date N months on, clamped to the month's last day so
// 30 Nov + 3 months ends 27 Feb rather than spilling into March.
const addMonthsMinusDay = (ymd, months) => {
  const [y, m, day] = ymd.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay) - 1);
  return target.toISOString().slice(0, 10);
};
const dayBefore = (ymd) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cycleLabel = (starts, ends) => {
  const s = new Date(`${starts}T00:00:00Z`), e = new Date(`${ends}T00:00:00Z`);
  const sm = `${MONTHS[s.getUTCMonth()]}${s.getUTCFullYear() !== e.getUTCFullYear() ? ' ' + s.getUTCFullYear() : ''}`;
  return `${sm} – ${MONTHS[e.getUTCMonth()]} ${e.getUTCFullYear()}`;
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
        ends_on DATE NOT NULL,
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

  // Starting a cycle closes the one before it the day before the new one
  // starts, so cycles never overlap and every date belongs to exactly one.
  router.post('/cycles', auth, allow(ROUTE_EDIT_ROLES), async (req, res) => {
    const starts = req.body?.starts_on;
    if (!isDateStr(starts)) return res.status(400).json({ error: 'Pick a start date.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE patrol_cycles IN SHARE ROW EXCLUSIVE MODE');
      const cycles = await cycleRows(client);
      const latest = cycles[0];
      if (latest && starts <= latest.starts_on) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `A new cycle has to start after the latest one (${latest.name}, from ${latest.starts_on}).` });
      }
      const ends = addMonthsMinusDay(starts, CYCLE_MONTHS);
      if (latest && latest.ends_on >= starts) {
        await client.query('UPDATE patrol_cycles SET ends_on = $1 WHERE id = $2', [dayBefore(starts), latest.id]);
      }
      const name = String(req.body?.name || '').trim().slice(0, 120) || cycleLabel(starts, ends);
      const { rows } = await client.query(
        'INSERT INTO patrol_cycles (name, starts_on, ends_on, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
        [name, starts, ends, req.user.id]);
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

  // ── Areas (one KMZ each) ──────────────────────────────────
  router.post('/cycles/:id/areas', auth, allow(ROUTE_EDIT_ROLES), (req, res) => {
    kmzUpload.single('kmz')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The KMZ must be 10 MB or smaller.' : (err.message || 'Upload rejected') });
      if (!req.file) return res.status(400).json({ error: 'Choose a KMZ file to upload.' });
      const area = cleanArea(req.body?.area);
      if (!area) return res.status(400).json({ error: 'Give the area a name, for example NW or RIFT.' });

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

  return { router, setup, _internals: { readKmz, kmlToFeatures, addMonthsMinusDay, cycleLabel } };
};
