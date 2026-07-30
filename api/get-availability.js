// Thin HTTP wrapper over the agenda engine (api/_lib/agenda.js).
// Availability now comes from the clinic's own operating_hours + booked
// appointments + schedule_blocks. Google Calendar is no longer consulted.

const { getAvailableSlots, getSupabase } = require('./_lib/agenda');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Resolve which clinic to check.
//   1. explicit ?clinic_id=
//   2. ?retell_agent_id= (how a voice agent identifies itself)
//   3. if the account only has one clinic, use it — keeps the currently
//      deployed Retell agent working without a same-moment config change.
async function resolveClinicId(query) {
  if (query?.clinic_id) return query.clinic_id;

  const supabase = getSupabase();

  if (query?.retell_agent_id) {
    const { data, error } = await supabase
      .from('clinics')
      .select('id')
      .eq('retell_agent_id', query.retell_agent_id)
      .maybeSingle();
    if (error) throw new Error(`clinic lookup: ${error.message}`);
    if (data) return data.id;
    return null;
  }

  const { data, error } = await supabase.from('clinics').select('id').limit(2);
  if (error) throw new Error(`clinic lookup: ${error.message}`);
  if ((data || []).length === 1) return data[0].id;

  return null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  try {
    const clinicId = await resolveClinicId(req.query);
    if (!clinicId) {
      res.status(400).json({
        error: 'Could not determine clinic — pass clinic_id or retell_agent_id',
        slots: [],
      });
      return;
    }

    const slots = await getAvailableSlots({
      clinicId,
      preference: req.query?.preference || null,
      days: Number(req.query?.days) || 7,
      limit: Number(req.query?.limit) || 4,
    });

    res.status(200).json({ slots });
  } catch (err) {
    console.error('[get-availability]', err.message);
    res.status(500).json({ error: err.message, slots: [] });
  }
};
