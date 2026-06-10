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

  let phase = null;
  const collected = { name: [], dob: [], reason: [], doctor: [], slots: [] };

  for (const item of transcriptObject) {
    if (item.role === 'agent' && item.content) {
      const text = item.content.toLowerCase();
      if (text.includes('nombre completo') || text.includes('su nombre')) {
        phase = 'name';
      } else if (text.includes('nacimiento')) {
        phase = 'dob';
      } else if (text.includes('motivo') || text.includes('visita hoy')) {
        phase = 'reason';
      } else if (text.includes('médico') || text.includes('doctor') || text.includes('medico')) {
        phase = 'doctor';
      } else if (text.includes('disponibilidad') || text.includes('jueves') || text.includes('viernes')) {
        phase = 'slots';
      }
    } else if (item.role === 'user' && isAudible(item) && phase) {
      collected[phase].push(item.content.trim());
    }
  }

  // patient_name: last value in "name" phase, skip invalid ones
  for (let i = collected.name.length - 1; i >= 0; i--) {
    const v = collected.name[i];
    const lower = v.toLowerCase();
    if (lower.includes('sé') || lower.includes('ya')) continue;
    const words = v.trim().split(/\s+/);
    if (words.length === 1 && words[0].length < 4) continue;
    result.patient_name = v;
    break;
  }

  // dob: all values joined
  result.dob = collected.dob.join(' ').trim();

  // reason: last value, skip if ends with "?"
  for (let i = collected.reason.length - 1; i >= 0; i--) {
    const v = collected.reason[i];
    if (v.endsWith('?')) continue;
    result.reason = v;
    break;
  }

  // doctor: last value, skip if ends with "?"
  for (let i = collected.doctor.length - 1; i >= 0; i--) {
    const v = collected.doctor[i];
    if (v.endsWith('?')) continue;
    result.doctor = v;
    break;
  }

  // appointment_time: last value in "slots" phase
  if (collected.slots.length > 0) {
    result.appointment_time = collected.slots[collected.slots.length - 1];
  }

  // Sanity check: if patient_name contains month words, clear it
  const monthWords = ['febrero', 'ochenta', 'enero', 'marzo', 'abril', 'mayo',
    'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  if (result.patient_name) {
    const lower = result.patient_name.toLowerCase();
    if (monthWords.some(m => lower.includes(m))) {
      result.patient_name = '';
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
