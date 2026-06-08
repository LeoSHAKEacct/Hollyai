const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return oauth2Client;
}

// Parse key fields from Retell call transcript as a fallback
function parseTranscript(transcript) {
  if (!transcript || typeof transcript !== 'string') return {};
  const result = {};

  const nameMatch = transcript.match(
    /(?:nombre|name)[:\s]+([A-Za-záéíóúÁÉÍÓÚñÑ\s]+?)(?:\.|,|\n|fecha|date|reason|motivo|doctor|cita|appointment|tel[eé]fono|phone|$)/i
  );
  if (nameMatch) result.patient_name = nameMatch[1].trim();

  const dobMatch = transcript.match(
    /(?:fecha de nacimiento|nacimiento|date of birth|birth(?:day)?)[:\s]+([0-9\/\-\.A-Za-záéíóúÁÉÍÓÚñÑ\s]+?)(?:\.|,|\n|reason|motivo|doctor|cita|appointment|tel[eé]fono|phone|$)/i
  );
  if (dobMatch) result.date_of_birth = dobMatch[1].trim();

  const reasonMatch = transcript.match(
    /(?:motivo(?:\s+de\s+(?:la\s+)?(?:visita|consulta))?|reason(?:\s+for\s+(?:visit|appointment))?)[:\s]+([^.\n]+?)(?:\.|,|\n|doctor|m[eé]dico|cita|appointment|tel[eé]fono|phone|$)/i
  );
  if (reasonMatch) result.reason = reasonMatch[1].trim();

  const doctorMatch = transcript.match(
    /(?:m[eé]dico|doctor|dr\.?)[:\s]+(?:Dr\.?\s+)?([A-Za-záéíóúÁÉÍÓÚñÑ\s]+?)(?:\.|,|\n|cita|appointment|tel[eé]fono|phone|motivo|reason|fecha|date|$)/i
  );
  if (doctorMatch) result.doctor = doctorMatch[1].trim();

  const apptMatch = transcript.match(
    /(?:cita|appointment|programad[ao](?:\s+para)?|scheduled(?:\s+for)?)[:\s]+([0-9A-Za-záéíóúÁÉÍÓÚñÑ\/\-:,\s\.]+?)(?:\.|,|\n|nombre|name|doctor|m[eé]dico|tel[eé]fono|phone|$)/i
  );
  if (apptMatch) result.appointment_time = apptMatch[1].trim();

  return result;
}

module.exports = async function handler(req, res) {
  // Full request body logged for debugging Retell function call payloads
  console.log('REQUEST BODY:', JSON.stringify(req.body, null, 2));

  const supabaseKeys = Object.keys(process.env).filter(k => k.startsWith('SUPABASE'));
  console.log('ENV CHECK:', {
    hasClientId: !!process.env.GOOGLE_CLIENT_ID,
    hasSecret: !!process.env.GOOGLE_CLIENT_SECRET,
    hasRefresh: !!process.env.GOOGLE_REFRESH_TOKEN,
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    supabaseKeys,
  });

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Set CORS headers on all responses
  Object.entries(CORS_HEADERS).forEach(([key, value]) => res.setHeader(key, value));

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // --- Payload normalisation ---
  // Format A: Retell agent-level webhook (post-call)
  //   { event, call: { agent_id, from_number, transcript, call_analysis: { custom_analysis_data: {...} } } }
  // Format B: Direct POST (curl tests)
  //   { patient_name, date_of_birth, reason, doctor, appointment_time, phone_number }
  let patient_name, date_of_birth, reason, doctor, appointment_time, phone_number, retell_agent_id;

  if (req.body.call) {
    const call = req.body.call;
    const data = call?.call_analysis?.custom_analysis_data || {};

    // Parse transcript as fallback for any empty fields
    const transcriptData = parseTranscript(call.transcript);
    console.log('TRANSCRIPT PARSED:', transcriptData);

    patient_name     = data.patient_name     || transcriptData.patient_name     || null;
    date_of_birth    = data.date_of_birth    || transcriptData.date_of_birth    || null;
    reason           = data.reason           || transcriptData.reason           || null;
    doctor           = data.doctor           || transcriptData.doctor           || null;
    appointment_time = data.appointment_time || transcriptData.appointment_time || null;
    // from_number is reliable — always prefer it
    phone_number     = call.from_number      || data.phone_number               || null;
    retell_agent_id  = call.agent_id         || null;
  } else {
    patient_name     = req.body.patient_name     || null;
    date_of_birth    = req.body.date_of_birth    || null;
    reason           = req.body.reason           || null;
    doctor           = req.body.doctor           || null;
    appointment_time = req.body.appointment_time || null;
    phone_number     = req.body.phone_number     || null;
    retell_agent_id  = null;
  }

  // Return 200 (not 400) on missing fields so Retell doesn't retry the webhook
  if (!patient_name || !appointment_time) {
    console.warn('Missing required fields — skipping booking:', { patient_name, appointment_time });
    res.status(200).json({ success: false, reason: 'missing_required_fields' });
    return;
  }

  // Parse appointment_time into a Date; expected ISO 8601 or parseable string
  const startTime = new Date(appointment_time);
  if (isNaN(startTime.getTime())) {
    res.status(400).json({ error: 'Invalid appointment_time format' });
    return;
  }
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // +30 min

  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'leoneltelesmeneses@gmail.com';

  const event = {
    summary: `Cita - ${patient_name}`,
    description: [
      `Paciente: ${patient_name}`,
      `Fecha de nacimiento: ${date_of_birth || ''}`,
      `Motivo: ${reason || ''}`,
      `Doctor: ${doctor || ''}`,
      `Teléfono: ${phone_number || ''}`,
    ].join('\n'),
    start: { dateTime: startTime.toISOString() },
    end:   { dateTime: endTime.toISOString() },
  };

  // --- Google Calendar (non-fatal) ---
  let event_id = null;
  let calendarError = null;
  try {
    const auth = getOAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });
    const calendarResponse = await calendar.events.insert({ calendarId, resource: event });
    event_id = calendarResponse.data.id;
    console.log('Google Calendar event created:', event_id);
  } catch (calErr) {
    calendarError = calErr.message;
    console.error('Google Calendar error (non-fatal):', calErr);
  }

  // --- Supabase (always runs regardless of Google Calendar outcome) ---
  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://lgnfiveyqlehnxlvspqb.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxnbmZpdmV5cWxlaG54bHZzcHFiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTQ5MTgxNiwiZXhwIjoyMDkxMDY3ODE2fQ.lHDXNcg6Q9Ds9G4NKUR2l3duVnri26dGOiVaGMc_cSc';
    console.log('SUPABASE INIT:', { hasUrl: !!supabaseUrl, hasKey: !!supabaseKey });
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error: dbError } = await supabase.from('appointments').insert({
      patient_name,
      dob: date_of_birth,
      reason,
      doctor,
      appointment_time,
      phone_number,
      retell_agent_id,
    });

    if (dbError) {
      console.error('Supabase insert error:', JSON.stringify(dbError));
    } else {
      console.log('Supabase insert successful');
    }
  } catch (dbErr) {
    console.error('Supabase unexpected error:', dbErr);
  }

  res.status(200).json({
    success: true,
    event_id,
    ...(calendarError ? { calendar_warning: calendarError } : {}),
  });
};
