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
    const { 
      id, dtl_id, history_id, client_name, client, 
      is_deployable_to_client, is_deployable, is_backend_deployable, 
      stack_type, target_stack, stack 
    } = body || {};

    const targetStack = (stack_type || target_stack || stack || (is_backend_deployable !== undefined ? 'backend' : 'frontend')).toLowerCase();
    const isBackend = targetStack === 'backend' || targetStack === 'b';

    const rawFlag = isBackend
      ? (is_backend_deployable !== undefined ? is_backend_deployable : (is_deployable !== undefined ? is_deployable : is_deployable_to_client))
      : (is_deployable_to_client !== undefined ? is_deployable_to_client : (is_deployable !== undefined ? is_deployable : 0));
    const flagVal = parseInt(rawFlag, 10) === 1 ? 1 : 0;

    const historyTarget = dtl_id || history_id;
    if (historyTarget) {
      // Toggle history release in child table SA_DEPLOYMENT_TRACKER_DTL (frontend or backend)
      const record = await db.updateHistoryDeployableFlag(historyTarget, flagVal, isBackend ? 'backend' : 'frontend');
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({
        success: true,
        table: 'SA_DEPLOYMENT_TRACKER_DTL',
        stack: isBackend ? 'backend' : 'frontend',
        message: flagVal === 0 
          ? `History ${isBackend ? 'Backend' : 'Frontend'} marked as Deployable (0)` 
          : `History ${isBackend ? 'Backend' : 'Frontend'} marked as Has Issue (1)`,
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
