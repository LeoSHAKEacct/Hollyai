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

// Extract patient data from transcript_object by matching user responses
// that follow specific agent questions.
function extractFromTranscript(transcriptObject) {
  if (!Array.isArray(transcriptObject)) return {};

  const result = {};
  const DAY_WORDS = /viernes|jueves|lunes|martes|miércoles|miercoles|mañana|tarde/i;
  const FILLER = /^(sí|si|no|ok|okay|claro|bueno|está bien|de acuerdo)$/i;

  for (let i = 0; i < transcriptObject.length; i++) {
    const turn = transcriptObject[i];
    if (turn.role !== 'agent') continue;

    const agentText = (turn.content || '').toLowerCase();
    const nextUser = transcriptObject[i + 1];
    if (!nextUser || nextUser.role !== 'user') continue;
    const userText = (nextUser.content || '').trim();

    // patient_name: after agent mentions "nombre", skip single words and fillers
    if (!result.patient_name && /nombre/.test(agentText)) {
      if (userText.split(/\s+/).length >= 2 && !FILLER.test(userText)) {
        result.patient_name = userText;
      }
    }

    // dob: after agent mentions "nacimiento", join consecutive user turns
    if (!result.dob && /nacimiento/.test(agentText)) {
      let dob = userText;
      let j = i + 2;
      while (j < transcriptObject.length && transcriptObject[j].role === 'user') {
        dob += ' ' + (transcriptObject[j].content || '').trim();
        j++;
      }
      result.dob = dob.trim();
    }

    // reason: after agent mentions "motivo"
    if (!result.reason && /motivo/.test(agentText)) {
      result.reason = userText;
    }

    // doctor: after agent mentions "doctor" or "médico"
    if (!result.doctor && /m[eé]dico|doctor/.test(agentText)) {
      result.doctor = userText;
    }
  }

  // appointment_time: any user turn containing a day/time word
  if (!result.appointment_time) {
    for (const turn of transcriptObject) {
      if (turn.role === 'user' && DAY_WORDS.test(turn.content || '')) {
        result.appointment_time = (turn.content || '').trim();
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
    const parsed = extractFromTranscript(call.transcript_object);

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
