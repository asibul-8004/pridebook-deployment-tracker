const db = require('../../db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const clientFilter = req.query?.client;
    let history = db.getMergedHistory(clientFilter);
    if (!history || history.length === 0) {
      try {
        await db.syncDatabaseFromGitHub(process.env.GITHUB_TOKEN || '');
        history = db.getMergedHistory(clientFilter);
      } catch (e) {}
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).json({
      success: true,
      count: history.length,
      data: history
    });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ success: false, error: err.message });
  }
};
