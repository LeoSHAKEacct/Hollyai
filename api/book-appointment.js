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

module.exports = async function handler(req, res) {
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

  const {
    patient_name,
    date_of_birth,
    reason,
    doctor,
    appointment_time,
    phone_number,
  } = req.body;

  if (!patient_name || !appointment_time) {
    res.status(400).json({ error: 'patient_name and appointment_time are required' });
    return;
  }

  // Parse appointment_time into a Date; expected ISO 8601 or parseable string
  const startTime = new Date(appointment_time);
  if (isNaN(startTime.getTime())) {
    res.status(400).json({ error: 'Invalid appointment_time format' });
    return;
  }
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // +30 min

  try {
    // --- Google Calendar ---
    const auth = getOAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

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
      end: { dateTime: endTime.toISOString() },
    };

    const calendarResponse = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      resource: event,
    });

    const event_id = calendarResponse.data.id;

    // --- Supabase ---
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { error: dbError } = await supabase.from('appointments').insert({
      patient_name,
      dob: date_of_birth,
      reason,
      doctor,
      appointment_time,
      phone_number,
    });

    if (dbError) {
      console.error('Supabase insert error:', dbError);
      // Still return success if calendar event was created; log the DB error
    }

    res.status(200).json({ success: true, event_id });
  } catch (err) {
    console.error('book-appointment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
