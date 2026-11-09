const deployService = require('../../deploy-service');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-pride-auth');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    let token = '';
    const authHeader = req.headers.authorization || req.headers['x-pride-auth'] || '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (authHeader) {
      token = authHeader.trim();
    }

    if (!token && req.headers.cookie) {
      const match = req.headers.cookie.match(/pride_auth=([^;]+)/);
      if (match) token = match[1];
    }

    if (!token && req.query?.token) {
      token = req.query.token;
    }

    const verified = deployService.verifyAuthToken(token);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (verified && verified.valid) {
      return res.status(200).json({
        success: true,
        authenticated: true,
        username: verified.username
      });
    } else {
      return res.status(401).json({
        success: false,
        authenticated: false,
        error: 'Unauthorized or session expired'
      });
    }
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ success: false, error: err.message });
  }
};
