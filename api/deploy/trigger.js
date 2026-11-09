const deployService = require('../../deploy-service');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ success: false, error: 'Method not allowed, use POST' });
  }

  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (_) { payload = {}; }
    }
    payload = payload || {};

    const client = payload.client;
    const frontend_tag = payload.frontend_tag;
    const backend_tag = payload.backend_tag;
    const username = payload.username;
    const password = payload.password;
    const token = process.env.GITHUB_TOKEN || '';

    const result = await deployService.triggerReleaseDeploy({
      client,
      frontend_tag,
      backend_tag,
      username,
      password,
      token
    });

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(result);
  } catch (err) {
    const status = err.statusCode || 400;
    res.setHeader('Content-Type', 'application/json');
    return res.status(status).json({ success: false, error: err.message });
  }
};
