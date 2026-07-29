const { createClient } = require('@supabase/supabase-js');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://lgnfiveyqlehnxlvspqb.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Identify the caller from their Supabase Auth session token — never
  // trust a clinic_id passed in the request body, since that would let
  // any logged-in clinic write into another clinic's patient list.
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  const { clinic_id } = req.body || {};
  if (!clinic_id) {
    res.status(400).json({ error: 'clinic_id is required' });
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

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) {
    res.status(400).json({ error: 'rows must be a non-empty array' });
    return;
  }
  if (rows.length > 2000) {
    res.status(400).json({ error: 'Max 2000 rows per import — split the file' });
    return;
  }

  const patients = [];
  const skipped = [];
  for (const row of rows) {
    const phone_number = (row.phone_number || row.phone || row.telefono || '').toString().trim();
    if (!phone_number) {
      skipped.push(row);
      continue;
    }
    patients.push({
      clinic_id,
      phone_number,
      name: (row.name || row.nombre || '').toString().trim() || null,
      dob: (row.dob || row.fecha_nacimiento || '').toString().trim() || null,
      doc_id: (row.doc_id || row.cedula || '').toString().trim() || null,
      insurance: (row.insurance || row.seguro || '').toString().trim() || null,
      notes: (row.notes || row.notas || '').toString().trim() || null,
    });
  }

  if (patients.length === 0) {
    res.status(400).json({ error: 'No rows had a usable phone number', skipped: skipped.length });
    return;
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('patients')
    .upsert(patients, { onConflict: 'clinic_id,phone_number' })
    .select('id');

  if (insertErr) {
    console.error('Import upsert error:', insertErr.message);
    res.status(500).json({ error: insertErr.message });
    return;
  }

  res.status(200).json({ imported: inserted?.length || 0, skipped: skipped.length });
};
