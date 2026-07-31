// Bearer-token auth for the partner API (/v1/*), used by SmileWeb.
//
// Only SHA-256 hashes are persisted. The plaintext key is returned once at
// creation and is unrecoverable afterwards, so a database leak cannot be
// replayed against the API.

const crypto = require('crypto');
const { getSupabase } = require('./agenda');

function hashKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

// sk_live_… in production, sk_sandbox_… for partner testing.
function generateKey(env = 'sandbox') {
  const prefix = env === 'live' ? 'sk_live_' : 'sk_sandbox_';
  const plaintext = prefix + crypto.randomBytes(24).toString('base64url');
  return {
    plaintext,
    hash: hashKey(plaintext),
    // Enough to recognise a key in a list, far too little to use it.
    display_prefix: plaintext.slice(0, prefix.length + 6) + '…',
  };
}

function extractBearer(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return m ? m[1].trim() : null;
}

/**
 * Authenticate a /v1 request.
 * @returns {Promise<{ok:true, clinicId:string, keyId:string} | {ok:false, status:number, error:string}>}
 */
async function authenticate(req) {
  const presented = extractBearer(req);
  if (!presented) {
    return { ok: false, status: 401, error: 'Missing Authorization: Bearer <api key>' };
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, clinic_id, revoked_at')
    .eq('key_hash', hashKey(presented))
    .maybeSingle();

  if (error) {
    // Before agenda-schema.sql runs there is no api_keys table, which means
    // no key can be valid — that's a 401, not a server fault.
    if (/does not exist|PGRST205/i.test(`${error.message} ${error.code || ''}`)) {
      return { ok: false, status: 401, error: 'Invalid or revoked API key' };
    }
    console.error('[apikey] lookup failed:', error.message);
    return { ok: false, status: 500, error: 'Key verification failed' };
  }
  // Same response for "no such key" and "revoked" — don't confirm key existence.
  if (!data || data.revoked_at) {
    return { ok: false, status: 401, error: 'Invalid or revoked API key' };
  }

  // Best-effort usage stamp; never block the request on it.
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(({ error: e }) => { if (e) console.warn('[apikey] last_used_at:', e.message); });

  return { ok: true, clinicId: data.clinic_id, keyId: data.id };
}

module.exports = { authenticate, generateKey, hashKey, extractBearer };
