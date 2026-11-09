const db = require('../../db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }
    const { id, client_name, client, is_deployable_to_client, is_deployable } = body || {};
    const target = id || client_name || client;
    const rawFlag = is_deployable_to_client !== undefined ? is_deployable_to_client : is_deployable;
    const flagVal = parseInt(rawFlag, 10) === 1 ? 1 : 0;

    if (!target) {
      return res.status(400).json({ error: 'id or client_name required' });
    }

    const record = await db.updateDeployableFlag(target, flagVal);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      success: true,
      message: flagVal === 0 ? 'Marked as Deployable (0)' : 'Marked as Has Issue / Not Deployable (1)',
      record
    });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ success: false, error: err.message });
  }
};
