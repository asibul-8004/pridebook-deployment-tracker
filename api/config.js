const db = require('../db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  const token = process.env.GITHUB_TOKEN || '';
  return res.status(200).json({
    port: parseInt(process.env.PORT, 10) || 3000,
    sourceMode: process.env.SOURCE_MODE,
    githubRepo: process.env.GITHUB_REPO,
    githubBranch: process.env.GITHUB_BRANCH || 'main',
    hasServerToken: Boolean(token && token.length > 5),
    dbType: db.getActiveDbType(),
    dbPath: db.DB_PATH
  });
};
