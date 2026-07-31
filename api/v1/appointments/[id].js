// PATCH /v1/appointments/{id} — SmileWeb confirms, reschedules or rejects a
// booking from its own agenda. Response shape is fixed by the spec shown in
// demo-smileweb.html.
//
//   PATCH /v1/appointments/b7f2a41c-…
//   Authorization: Bearer sk_sandbox_…
//   { "status": "confirmed" }
//   { "starts_at": "2026-07-25T16:00:00-05:00" }   ← reschedule

const { authenticate } = require('../../_lib/apikey');
const { getSupabase, loadBusy, isBusy, toISO, toSpoken } = require('../../_lib/agenda');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const ALLOWED_STATUS = ['pending', 'confirmed', 'rejected', 'cancelled', 'completed'];

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'PATCH') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const id = req.query?.id;
  if (!id) {
    res.status(400).json({ error: 'Appointment id is required' });
    return;
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const { status, starts_at } = body;

  if (status === undefined && starts_at === undefined) {
    res.status(400).json({ error: 'Provide status and/or starts_at' });
    return;
  }
  if (status !== undefined && !ALLOWED_STATUS.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUS.join(', ')}` });
    return;
  }

  try {
    const supabase = getSupabase();

    // Scope the lookup to the key's clinic so a partner key cannot read or
    // mutate another clinic's appointment — indistinguishable from "not found".
    const { data: existing, error: findErr } = await supabase
      .from('appointments')
      .select('id, clinic_id, status, reason, appointment_date, duration_min')
      .eq('id', id)
      .eq('clinic_id', auth.clinicId)
      .maybeSingle();

    if (findErr) throw new Error(findErr.message);
    if (!existing) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    const patch = {};
    if (status !== undefined) patch.status = status;

    if (starts_at !== undefined) {
      const startMs = new Date(starts_at).getTime();
      if (!Number.isFinite(startMs)) {
        res.status(400).json({ error: 'starts_at must be an ISO-8601 timestamp' });
        return;
      }
      if (startMs <= Date.now()) {
        res.status(409).json({ error: 'Cannot reschedule into the past' });
        return;
      }

      const durationMin = existing.duration_min || 30;
      const durationMs = durationMin * 60000;
      const busy = await loadBusy(
        supabase, auth.clinicId, startMs - 1, startMs + durationMs + 1, existing.id
      );
      if (isBusy(startMs, durationMs, busy)) {
        res.status(409).json({ error: 'Requested time is no longer available' });
        return;
      }

      patch.appointment_date = new Date(startMs).toISOString();
      patch.appointment_time = toSpoken(startMs);
    }

    const { data: updated, error: updErr } = await supabase
      .from('appointments')
      .update(patch)
      .eq('id', existing.id)
      .select('id, status, reason, doctor, appointment_date, duration_min, updated_at')
      .single();

    if (updErr) throw new Error(updErr.message);

    res.status(200).json({
      id: updated.id,
      status: updated.status,
      service: updated.reason || null,
      practitioner: updated.doctor || null,
      starts_at: updated.appointment_date
        ? toISO(new Date(updated.appointment_date).getTime())
        : null,
      ends_at: updated.appointment_date
        ? toISO(new Date(updated.appointment_date).getTime() + (updated.duration_min || 30) * 60000)
        : null,
      updated_at: updated.updated_at
        ? toISO(new Date(updated.updated_at).getTime())
        : null,
    });
  } catch (err) {
    console.error('[v1/appointments PATCH]', err.message);
    res.status(500).json({ error: err.message });
  }
};

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
