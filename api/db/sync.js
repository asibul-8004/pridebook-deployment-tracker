const db = require('../../db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const token = process.env.GITHUB_TOKEN || '';
    const syncedRows = await db.syncDatabaseFromGitHub(token);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      success: true,
      message: `Synchronized with GitHub into ${db.getActiveDbType()} successfully`,
      count: syncedRows.length,
      data: syncedRows
    });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ success: false, error: err.message });
  }
};
