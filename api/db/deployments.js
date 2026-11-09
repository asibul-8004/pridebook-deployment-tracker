const db = require('../../db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const shouldSync = req.query?.sync === 'true';
    const clientFilter = req.query?.client;
    const token = process.env.GITHUB_TOKEN || '';

    let rows = await db.getAllDeployments({ client_name: clientFilter });

    if (shouldSync || rows.length === 0) {
      try {
        await db.syncDatabaseFromGitHub(token);
        rows = await db.getAllDeployments({ client_name: clientFilter });
      } catch (syncErr) {
        console.warn('[Vercel DB Sync Warn]:', syncErr.message);
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).json({
      success: true,
      db_type: db.getActiveDbType(),
      count: rows.length,
      deployable_count: rows.filter(r => r.is_deployable_to_client === 0).length,
      issue_count: rows.filter(r => r.is_deployable_to_client === 1).length,
      data: rows
    });
  } catch (err) {
    console.error('[Vercel DB Deployments Error]:', err.message);
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};
