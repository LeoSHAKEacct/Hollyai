const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

module.exports = async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  Object.entries(CORS_HEADERS).forEach(([key, value]) => res.setHeader(key, value));

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { agent_id } = req.body;

  if (!agent_id) {
    res.status(400).json({ error: 'agent_id is required' });
    return;
  }

  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'RETELL_API_KEY is not configured' });
    return;
  }

  try {
    const response = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agent_id }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Retell API error:', response.status, errorText);
      res.status(response.status).json({ error: 'Retell API error', details: errorText });
      return;
    }

    const data = await response.json();
    res.status(200).json({ access_token: data.access_token });
  } catch (err) {
    console.error('get-token error:', err);
    res.status(500).json({ error: err.message });
  }
};
