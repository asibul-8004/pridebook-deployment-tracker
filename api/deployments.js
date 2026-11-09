const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const repo = process.env.GITHUB_REPO || 'pride-erp-local/pride-erp-frontend';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const token = process.env.GITHUB_TOKEN || '';
  const mode = (req.query && req.query.source) || process.env.SOURCE_MODE || 'github';

  if (mode === 'github') {
    try {
      const url = `https://api.github.com/repos/${repo}/contents/deployments.json?ref=${branch}`;
      const headers = {
        'User-Agent': 'Pridebook-Deployment-Tracker-Vercel',
        'Accept': 'application/vnd.github.v3.raw',
        'Cache-Control': 'no-cache'
      };
      if (token) {
        headers['Authorization'] = `token ${token.trim()}`;
      }

      const ghRes = await fetch(url, { headers });
      if (ghRes.ok) {
        const text = await ghRes.text();
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.encoding === 'base64' && parsed.content) {
            const raw = Buffer.from(parsed.content, 'base64').toString('utf8');
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.status(200).send(raw);
          }
        } catch (e) {}

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.status(200).send(text);
      } else {
        console.warn(`GitHub API returned status ${ghRes.status}: ${ghRes.statusText}`);
      }
    } catch (err) {
      console.warn('Vercel GitHub fetch error:', err.message);
    }
  }

  // Fallback to local deployments.json
  try {
    const localPath = path.join(process.cwd(), 'deployments.json');
    if (fs.existsSync(localPath)) {
      const data = fs.readFileSync(localPath, 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.status(200).send(data);
    }
  } catch (e) {
    console.error('Fallback read error:', e.message);
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({});
};
