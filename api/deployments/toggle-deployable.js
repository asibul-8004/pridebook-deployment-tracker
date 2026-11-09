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
    const { id, dtl_id, history_id, client_name, client, is_deployable_to_client, is_deployable } = body || {};
    const rawFlag = is_deployable_to_client !== undefined ? is_deployable_to_client : is_deployable;
    const flagVal = parseInt(rawFlag, 10) === 1 ? 1 : 0;

    const historyTarget = dtl_id || history_id;
    if (historyTarget) {
      // Toggle history release in child table SA_DEPLOYMENT_TRACKER_DTL
      const record = await db.updateHistoryDeployableFlag(historyTarget, flagVal);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({
        success: true,
        table: 'SA_DEPLOYMENT_TRACKER_DTL',
        message: flagVal === 0 ? 'History release marked as Deployable (0)' : 'History release marked as Has Issue (1)',
        record
      });
    }

    const target = id || client_name || client;
    if (!target) {
      return res.status(400).json({ error: 'dtl_id, id, or client_name required' });
    }

    const record = await db.updateDeployableFlag(target, flagVal);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      success: true,
      table: 'SA_DEPLOYMENT_TRACKER',
      message: flagVal === 0 ? 'Marked as Deployable (0)' : 'Marked as Has Issue / Not Deployable (1)',
      record
    });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ success: false, error: err.message });
  }
};
