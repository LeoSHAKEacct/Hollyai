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
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

function extractFromTranscript(transcriptObject, fromNumber) {
  const result = { patient_name: '', dob: '', reason: '', doctor: '',
    appointment_time: '', phone_number: fromNumber || '' };

  if (!Array.isArray(transcriptObject)) return result;

  const isAudible = t =>
    t.content && t.content.trim() !== '' && t.content !== '(inaudible speech)';

  for (let i = 0; i < transcriptObject.length; i++) {
    const item = transcriptObject[i];
    if (item.role !== 'agent') continue;
    const text = item.content.toLowerCase();

    // First audible user response after this agent turn
    const nextUser = transcriptObject.slice(i + 1)
      .find(t => t.role === 'user' && isAudible(t));
    if (!nextUser) continue;
    const userResponse = nextUser.content.trim();

    if (!result.patient_name &&
        (text.includes('nombre completo') || text.includes('su nombre'))) {
      // Take the last of up to 3 user responses (most-corrected version)
      const nameResponses = transcriptObject.slice(i + 1)
        .filter(t => t.role === 'user' && isAudible(t) &&
          !['sí', 'si', 'no', 'ok', 'claro'].includes(t.content.trim().toLowerCase()))
        .slice(0, 3);
      if (nameResponses.length > 0) {
        result.patient_name = nameResponses[nameResponses.length - 1].content.trim();
      }
    }

    if (!result.dob && text.includes('nacimiento')) {
      // Join up to 3 user responses after DOB question
      result.dob = transcriptObject.slice(i + 1)
        .filter(t => t.role === 'user' && isAudible(t))
        .slice(0, 3)
        .map(t => t.content.trim())
        .join(' ');
    }

    if (!result.reason &&
        (text.includes('motivo') || text.includes('visita hoy'))) {
      result.reason = userResponse;
    }

    if (!result.doctor &&
        (text.includes('médico') || text.includes('doctor') || text.includes('medico'))) {
      result.doctor = userResponse;
    }
  }

  // appointment_time: first user turn containing a day/time word
  const dayWords = ['viernes', 'jueves', 'lunes', 'martes', 'miércoles',
    'miercoles', 'sábado', 'sabado', 'domingo', 'mañana', 'tarde'];
  for (const turn of transcriptObject) {
    if (turn.role === 'user' && turn.content) {
      const lower = turn.content.toLowerCase();
      if (dayWords.some(d => lower.includes(d))) {
        result.appointment_time = turn.content.trim();
        break;
      }
    }
  }

  return result;
}

module.exports = async function handler(req, res) {
  console.log('REQUEST BODY:', JSON.stringify(req.body, null, 2));

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  // --- Extract fields ---
  let patient_name, dob, reason, doctor, appointment_time, phone_number, retell_agent_id;

  if (req.body && req.body.call) {
    const call = req.body.call;
    const custom = call?.call_analysis?.custom_analysis_data || {};
    const parsed = extractFromTranscript(call.transcript_object, call.from_number);

    patient_name     = custom.patient_name     || parsed.patient_name     || '';
    dob              = custom.date_of_birth    || parsed.dob              || '';
    reason           = custom.reason           || parsed.reason           || '';
    doctor           = custom.doctor           || parsed.doctor           || '';
    appointment_time = custom.appointment_time || parsed.appointment_time || '';
    phone_number     = call.from_number        || custom.phone_number     || '';
    retell_agent_id  = call.agent_id           || '';
  } else {
    patient_name     = req.body?.patient_name     || '';
    dob              = req.body?.date_of_birth    || '';
    reason           = req.body?.reason           || '';
    doctor           = req.body?.doctor           || '';
    appointment_time = req.body?.appointment_time || '';
    phone_number     = req.body?.phone_number     || '';
    retell_agent_id  = '';
  }

  const record = { patient_name, dob, reason, doctor, appointment_time, phone_number, retell_agent_id };
  console.log('SAVING TO SUPABASE:', record);

  // --- Google Calendar (best-effort) ---
  let event_id = null;
  if (appointment_time && patient_name) {
    try {
      const startTime = new Date(appointment_time);
      if (!isNaN(startTime.getTime())) {
        const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
        const calendarId = process.env.GOOGLE_CALENDAR_ID || 'leoneltelesmeneses@gmail.com';
        const event = {
          summary: `Cita - ${patient_name}`,
          description: [
            `Paciente: ${patient_name}`,
            `Fecha de nacimiento: ${dob}`,
            `Motivo: ${reason}`,
            `Doctor: ${doctor}`,
            `Teléfono: ${phone_number}`,
          ].join('\n'),
          start: { dateTime: startTime.toISOString() },
          end:   { dateTime: endTime.toISOString() },
        };
        const auth = getOAuthClient();
        const calendar = google.calendar({ version: 'v3', auth });
        const calRes = await calendar.events.insert({ calendarId, resource: event });
        event_id = calRes.data.id;
        console.log('Google Calendar event created:', event_id);
      } else {
        console.warn('appointment_time is not a parseable ISO date — skipping calendar');
      }
    } catch (calErr) {
      console.warn('Google Calendar error (non-fatal):', calErr.message);
    }
  }

  // --- Supabase (always runs) ---
  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://lgnfiveyqlehnxlvspqb.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxnbmZpdmV5cWxlaG54bHZzcHFiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTQ5MTgxNiwiZXhwIjoyMDkxMDY3ODE2fQ.lHDXNcg6Q9Ds9G4NKUR2l3duVnri26dGOiVaGMc_cSc';
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error: dbError } = await supabase.from('appointments').insert({
      patient_name,
      dob,
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
    console.error('Supabase unexpected error:', dbErr.message);
  }

  res.status(200).json({ success: true, event_id });
};
