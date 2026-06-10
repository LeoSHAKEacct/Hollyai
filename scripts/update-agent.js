#!/usr/bin/env node
// Updates the Retell Holly ES agent with post_call_analysis_data fields.
//
// Retell does not allow PATCHing a published agent directly — the workflow is:
//   1. POST /create-agent-version  → creates a new unpublished draft (from base_version)
//   2. PATCH /update-agent         → sets post_call_analysis_data on the draft
//   3. POST /publish-agent-version → publishes the draft
//
// Usage: node scripts/update-agent.js
//   (uses RETELL_API_KEY env var, falls back to hardcoded key for local runs)

const AGENT_ID = 'agent_974fee51cfeef9670c4daa5d9a';
const API_KEY  = process.env.RETELL_API_KEY || 'key_f41f86667282818d576ce8414517';
const BASE     = 'https://api.retellai.com';

const POST_CALL_ANALYSIS_DATA = [
  {
    name: 'patient_name',
    type: 'string',
    description: "The patient's full proper name only. Extract ONLY the name, NOT words like Mi, Me, llamo, nombre, es, soy, Si. Example: if patient says 'Mi nombre es Roberta Fuentes' extract only 'Roberta Fuentes'. Use the final corrected version if they correct it.",
  },
  {
    name: 'date_of_birth',
    type: 'string',
    description: "Patient's date of birth. Combine multiple responses if needed. Example: if patient says 'febrero' then 'ochenta y ocho' combine as 'febrero 1988'.",
  },
  {
    name: 'reason',
    type: 'string',
    description: 'The medical reason for the visit. Only patient answers, not questions.',
  },
  {
    name: 'doctor',
    type: 'string',
    description: 'The preferred doctor name. Only if patient named a specific doctor, otherwise empty.',
  },
  {
    name: 'appointment_time',
    type: 'string',
    description: 'The confirmed appointment day and time. Example: viernes a las 2 de la tarde.',
  },
];

async function retell(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  console.log(`${method} ${path} → ${res.status}`);
  if (!res.ok) { console.error('Response:', data); throw new Error(`HTTP ${res.status}`); }
  return data;
}

async function main() {
  // Step 1 — get current published version number
  const agent = await retell('GET', `/get-agent/${AGENT_ID}`);
  console.log(`Current: version=${agent.version} is_published=${agent.is_published}`);

  // Step 2 — create a new draft based on the current published version
  const draft = await retell('POST', `/create-agent-version/${AGENT_ID}`, {
    base_version: agent.version,
  });
  const draftVersion = draft.version;
  console.log(`Draft created: version=${draftVersion} is_published=${draft.is_published}`);

  // Step 3 — patch the draft with post_call_analysis_data
  const updated = await retell('PATCH', `/update-agent/${AGENT_ID}`, {
    post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
  });
  console.log(`Draft updated: post_call_analysis_data fields = ${updated.post_call_analysis_data?.length}`);

  // Step 4 — publish the draft
  await retell('POST', `/publish-agent-version/${AGENT_ID}`, { version: draftVersion });

  // Step 5 — verify
  const live = await retell('GET', `/get-agent/${AGENT_ID}`);
  console.log(`\nLive agent: version=${live.version} is_published=${live.is_published}`);
  console.log('post_call_analysis_data:', JSON.stringify(live.post_call_analysis_data, null, 2));
}

main().catch(err => { console.error(err.message); process.exit(1); });
