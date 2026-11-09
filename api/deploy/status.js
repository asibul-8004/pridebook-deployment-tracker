const deployService = require('../../deploy-service');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const client = req.query?.client || '';
    const frontend_tag = req.query?.frontend_tag || '';
    const backend_tag = req.query?.backend_tag || '';
    const token = process.env.GITHUB_TOKEN || '';

    const status = await deployService.getDeployStatus({
      client,
      frontend_tag,
      backend_tag,
      token
    });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).json({ success: true, ...status });
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ success: false, error: err.message });
  }
};
