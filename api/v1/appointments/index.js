// GET /v1/appointments — partner pull endpoint (SmileWeb).
//
// Response shape is fixed by the integration spec shown to SmileWeb in
// demo-smileweb.html; do not change field names without re-issuing that spec.
//
//   GET /v1/appointments?since=2026-07-01T00:00:00Z&status=pending&limit=50
//   Authorization: Bearer sk_sandbox_…

const { authenticate } = require('../../_lib/apikey');
const { getSupabase, toISO } = require('../../_lib/agenda');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(row) {
  return Buffer.from(`${row.updated_at}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [updatedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!updatedAt || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

// Maps an appointments row (plus joined patient) to the pitched contract.
function serialize(row) {
  const p = row.patients || {};
  const startMs = row.appointment_date ? new Date(row.appointment_date).getTime() : null;
  const durationMin = row.duration_min || 30;
  return {
    id: row.id,
    status: row.status,
    patient: {
      full_name: p.name || row.patient_name || null,
      document_id: p.doc_id || null,
      phone: p.phone_number || row.phone_number || null,
      email: p.email || null,
    },
    service: row.reason || null,
    practitioner: row.doctor || null,
    starts_at: startMs ? toISO(startMs) : null,
    // A receiving agenda needs the length of the slot, not just its start.
    ends_at: startMs ? toISO(startMs + durationMin * 60000) : null,
    duration_min: durationMin,
    source: row.source,
    created_at: row.created_at ? toISO(new Date(row.created_at).getTime()) : null,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  try {
    const supabase = getSupabase();
    const limit = Math.min(
      Math.max(parseInt(req.query?.limit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );

    let q = supabase
      .from('appointments')
      .select('*, patients(name, doc_id, phone_number, email)')
      // Scoped to the key's clinic — a partner key can never read another
      // clinic's bookings.
      .eq('clinic_id', auth.clinicId)
      // Only real agenda entries; rows without a resolved date aren't bookings.
      .not('appointment_date', 'is', null)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1); // one extra row tells us if another page exists

    if (req.query?.status) {
      q = q.eq('status', req.query.status);
    }
    if (req.query?.since) {
      const since = new Date(req.query.since);
      if (isNaN(since.getTime())) {
        res.status(400).json({ error: 'since must be an ISO-8601 timestamp' });
        return;
      }
      q = q.gt('updated_at', since.toISOString());
    }
    if (req.query?.cursor) {
      const c = decodeCursor(req.query.cursor);
      if (!c) {
        res.status(400).json({ error: 'Invalid cursor' });
        return;
      }
      // Keyset pagination: strictly after (updated_at, id).
      q = q.or(`updated_at.gt.${c.updatedAt},and(updated_at.eq.${c.updatedAt},id.gt.${c.id})`);
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rows = data || [];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.status(200).json({
      data: page.map(serialize),
      next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch (err) {
    console.error('[v1/appointments GET]', err.message);
    res.status(500).json({ error: err.message });
  }
};
