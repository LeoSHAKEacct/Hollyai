// POST /api/book-manual — book a slot from the CRM agenda.
//
// Goes through the shared agenda engine rather than inserting directly, so a
// manual booking gets the same re-check-before-insert protection as an
// automated one and can't silently double-book a slot someone just took.

const { createClient } = require('@supabase/supabase-js');
const { bookSlot } = require('./_lib/agenda');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabase = createClient(
    process.env.SUPABASE_URL || 'https://lgnfiveyqlehnxlvspqb.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const { clinic_id, starts_at, patient_name, phone_number, service, duration_min } = body;

  if (!clinic_id || !starts_at) {
    res.status(400).json({ error: 'clinic_id and starts_at are required' });
    return;
  }

  const { data: membership, error: membershipErr } = await supabase
    .from('clinic_members')
    .select('role')
    .eq('user_id', userData.user.id)
    .or(`clinic_id.eq.${clinic_id},role.eq.super_admin`)
    .maybeSingle();

  if (membershipErr || !membership) {
    res.status(403).json({ error: 'Not a member of this clinic' });
    return;
  }

  try {
    // Attach to an existing patient when the phone matches, so manual
    // bookings land on the same CRM timeline as calls and imports.
    let patientId = null;
    if (phone_number) {
      const { data: patient } = await supabase
        .from('patients')
        .upsert(
          { clinic_id, phone_number, name: patient_name || undefined },
          { onConflict: 'clinic_id,phone_number' }
        )
        .select('id')
        .single();
      patientId = patient?.id || null;
    }

    const result = await bookSlot({
      clinicId: clinic_id,
      patientId,
      patientName: patient_name || '',
      phoneNumber: phone_number || '',
      service: service || '',
      startsAt: starts_at,
      durationMin: Number(duration_min) || 30,
      source: 'manual',
      // Booked by clinic staff who can see their own agenda — already settled.
      status: 'confirmed',
    });

    if (!result.ok) {
      const code = result.reason === 'slot_taken' ? 409 : 400;
      res.status(code).json({ error: result.reason });
      return;
    }

    res.status(200).json({ appointment: result.appointment });
  } catch (err) {
    console.error('[book-manual]', err.message);
    res.status(500).json({ error: err.message });
  }
};

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
