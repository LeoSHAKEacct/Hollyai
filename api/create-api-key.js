// POST /api/create-api-key — issue a partner API key for a clinic.
//
// Called from the CRM's Integraciones panel by a logged-in clinic member.
// The plaintext key is returned exactly once and never stored; only its
// SHA-256 hash is persisted. Listing and revoking happen client-side through
// RLS on api_keys, so they need no endpoint.

const { createClient } = require('@supabase/supabase-js');
const { generateKey } = require('./_lib/apikey');

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

  // Identify the caller from their Supabase Auth session — never trust a
  // clinic_id from the body alone.
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
  const { clinic_id, name, env } = body;

  if (!clinic_id) {
    res.status(400).json({ error: 'clinic_id is required' });
    return;
  }
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'name is required (e.g. "SmileWeb sandbox")' });
    return;
  }
  if (env && !['live', 'sandbox'].includes(env)) {
    res.status(400).json({ error: 'env must be "live" or "sandbox"' });
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
    const key = generateKey(env || 'sandbox');

    const { data, error } = await supabase
      .from('api_keys')
      .insert({
        clinic_id,
        name: String(name).trim(),
        key_hash: key.hash,
        key_prefix: key.display_prefix,
      })
      .select('id, name, key_prefix, created_at')
      .single();

    if (error) throw new Error(error.message);

    res.status(200).json({
      ...data,
      // Shown once in the UI, then unrecoverable.
      api_key: key.plaintext,
    });
  } catch (err) {
    console.error('[create-api-key]', err.message);
    res.status(500).json({ error: err.message });
  }
};

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
