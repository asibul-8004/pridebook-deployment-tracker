const db = require('../db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const token = process.env.GITHUB_TOKEN || '';
    const forceSync = req.query && (req.query.sync === 'true' || req.query.sync === '1');
    
    // Internal synchronization: checks GitHub against DB, onboards new clients, updates DB, records history in DTL table
    const result = await db.getDeploymentsWithSync({ token, forceSync });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const format = req.query && req.query.format;
    if (format === 'db' || format === 'array') {
      return res.status(200).json(result.data);
    }

    // Direct database response
    return res.status(200).json(result);
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ success: false, error: err.message });
  }
};
