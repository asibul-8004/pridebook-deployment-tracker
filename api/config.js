module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  const token = process.env.GITHUB_TOKEN || '';
  return res.status(200).json({
    sourceMode: process.env.SOURCE_MODE || 'github',
    githubRepo: process.env.GITHUB_REPO || 'pride-erp-local/pride-erp-frontend',
    githubBranch: process.env.GITHUB_BRANCH || 'main',
    hasServerToken: Boolean(token && token.length > 5)
  });
};
