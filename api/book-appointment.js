const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

console.log('[DEBUG] GOOGLE_REFRESH_TOKEN (first 20):', (process.env.GOOGLE_REFRESH_TOKEN || '').slice(0, 20));

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

// Parse key fields from Retell transcript_object array as a fallback.
// Each entry has { role: "agent"|"user", content: "..." }.
// We extract user responses that follow specific agent questions.
function parseTranscript(transcriptObject) {
  if (!Array.isArray(transcriptObject) || transcriptObject.length === 0) return {};

  const result = {};

  for (let i = 0; i < transcriptObject.length; i++) {
    const turn = transcriptObject[i];
    if (turn.role !== 'agent') continue;

    const agentText = (turn.content || '').toLowerCase();
    // Collect the next user turn(s) after this agent question
    const nextUser = transcriptObject[i + 1];
    if (!nextUser || nextUser.role !== 'user') continue;
    const userText = (nextUser.content || '').trim();

    if (!result.patient_name && /nombre/.test(agentText)) {
      result.patient_name = userText;
    }

    if (!result.date_of_birth && /nacimiento/.test(agentText)) {
      // Combine consecutive user turns in case the date spans multiple responses
      let dob = userText;
      let j = i + 2;
      while (j < transcriptObject.length && transcriptObject[j].role === 'user') {
        dob += ' ' + (transcriptObject[j].content || '').trim();
        j++;
      }
      result.date_of_birth = dob.trim();
    }

    if (!result.reason && /motivo/.test(agentText)) {
      result.reason = userText;
    }

    if (!result.doctor && /m[eé]dico|doctor/.test(agentText)) {
      result.doctor = userText;
    }

    if (!result.appointment_time && /jueves|viernes|disponib|horario|agenda/.test(agentText)) {
      result.appointment_time = userText;
    }
  }

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

    // Parse transcript_object as fallback for any empty fields
    const transcriptData = parseTranscript(call.transcript_object);
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
