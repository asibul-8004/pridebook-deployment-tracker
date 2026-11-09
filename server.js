/**
 * Pridebook Version Tracker Server
 * Location: /home/asibul/Pridebook/deployment-tracker/server.js
 * Serves the single-page two-tab tracker app and provides live deployments API.
 * Supports .env configuration for port, source mode, and GitHub token.
 * Usage: node server.js [PORT]
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const rootDir = __dirname;

// Native .env file loader (Zero external dependencies)
function loadEnv() {
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx !== -1) {
          const key = line.slice(0, eqIdx).trim();
          let val = line.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    } catch (err) {
      console.warn('Could not read .env file:', err.message);
    }
  }
}

loadEnv();

const PORT = parseInt(process.env.PORT, 10) || parseInt(process.argv[2], 10) || 3000;
const SOURCE_MODE = process.env.SOURCE_MODE || 'local';
const GITHUB_REPO = process.env.GITHUB_REPO || 'pride-erp-local/pride-erp-frontend';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const htmlPath = path.join(rootDir, 'index.html');
const jsonPath = path.join(rootDir, process.env.DEPLOYMENTS_FILE || 'deployments.json');
const frontendJsonPath = fs.existsSync(path.join(rootDir, '..', 'pride-erp-frontend', 'deployments.json'))
  ? path.join(rootDir, '..', 'pride-erp-frontend', 'deployments.json')
  : path.join(rootDir, 'pride-erp-frontend', 'deployments.json');

// Get active deployments.json path
function getJsonPath() {
  if (fs.existsSync(jsonPath)) return jsonPath;
  if (fs.existsSync(frontendJsonPath)) return frontendJsonPath;
  return jsonPath;
}

// Read deployments data safely from local disk
function readDeploymentsLocal() {
  const targetPath = getJsonPath();
  if (!fs.existsSync(targetPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch (err) {
    console.error('Failed to parse deployments.json:', err.message);
    return {};
  }
}

// Fetch deployments directly from GitHub API using server-side token
async function fetchDeploymentsGitHub() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/deployments.json?ref=${GITHUB_BRANCH}`;
  const headers = {
    'User-Agent': 'Pridebook-Version-Tracker-Server',
    'Accept': 'application/vnd.github.v3.raw',
    'Cache-Control': 'no-cache'
  };
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `token ${GITHUB_TOKEN.trim()}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API HTTP ${res.status}: ${res.statusText}`);
  }
  const result = await res.json();
  if (result && result.encoding === 'base64' && result.content) {
    const raw = Buffer.from(result.content, 'base64').toString('utf8');
    return JSON.parse(raw);
  }
  return result;
}

// Write deployments data safely
function writeDeployments(data) {
  const targetPath = getJsonPath();
  const formatted = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(targetPath, formatted, 'utf8');

  // If frontend folder exists, keep it in sync
  if (fs.existsSync(frontendJsonPath) && targetPath !== frontendJsonPath) {
    try {
      fs.writeFileSync(frontendJsonPath, formatted, 'utf8');
    } catch (e) {}
  }
}

// Helper: Normalize structure
function normalizeData(data) {
  const normalized = {};
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object') {
      if (value.current) {
        normalized[key] = value;
      } else {
        normalized[key] = {
          current: { ...value },
          previous: null,
          history: []
        };
      }
    }
  }
  return normalized;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /api/config - Expose safe environment info to frontend
  if (pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(JSON.stringify({
      port: PORT,
      sourceMode: SOURCE_MODE,
      githubRepo: GITHUB_REPO,
      githubBranch: GITHUB_BRANCH,
      hasServerToken: Boolean(GITHUB_TOKEN && GITHUB_TOKEN.length > 5)
    }, null, 2));
    return;
  }

  // GET /deployments.json or /api/deployments
  if ((pathname === '/deployments.json' || pathname === '/api/deployments') && req.method === 'GET') {
    let data = {};
    const mode = parsedUrl.searchParams.get('source') || SOURCE_MODE;

    if (mode === 'github') {
      try {
        data = await fetchDeploymentsGitHub();
      } catch (err) {
        console.warn(`[GitHub Fetch Failed: ${err.message}] Falling back to local deployments.json`);
        data = readDeploymentsLocal();
      }
    } else {
      data = readDeploymentsLocal();
    }

    const shouldNormalize = parsedUrl.searchParams.get('normalized') === 'true';
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(JSON.stringify(shouldNormalize ? normalizeData(data) : data, null, 2));
    return;
  }

  // GET /api/deployments/:client
  if (pathname.startsWith('/api/deployments/') && req.method === 'GET') {
    const client = pathname.replace('/api/deployments/', '').trim();
    const data = readDeploymentsLocal();
    if (data[client]) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(JSON.stringify(data[client], null, 2));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Client '${client}' not found` }));
    }
    return;
  }

  // POST /api/deployments - Record new deployment
  if ((pathname === '/api/deployments' || pathname === '/deployments') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { client, tag, actor = 'system', run_id = '', status = 'success' } = payload;

        if (!client || !tag) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'client and tag are required' }));
          return;
        }

        const data = readDeploymentsLocal();
        const record = {
          version: tag,
          status,
          last_deployed_at: new Date().toISOString(),
          deployed_by: actor,
          run_id: String(run_id)
        };

        if (client === 'stage') {
          if (!data.stage || typeof data.stage !== 'object' || !data.stage.current) {
            data.stage = { current: record, previous: null, history: [] };
          } else {
            if (data.stage.current.version && data.stage.current.version !== 'unknown') {
              data.stage.previous = { ...data.stage.current };
              if (!Array.isArray(data.stage.history)) data.stage.history = [];
              data.stage.history.unshift({ ...data.stage.current });
              if (data.stage.history.length > 50) {
                data.stage.history = data.stage.history.slice(0, 50);
              }
            }
            data.stage.current = record;
          }
        } else {
          data[client] = record;
        }

        writeDeployments(data);
        console.log(`[Deployment Recorded] ${client} -> ${tag} (${status}) by ${actor}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, client, data: data[client] }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload: ' + err.message }));
      }
    });
    return;
  }

  // Serve Single Page Application (HTML)
  if (pathname === '/' || pathname === '/index.html' || pathname === '/version-tracker' || pathname === '/version-tracker.html') {
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(fs.readFileSync(htmlPath, 'utf8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('index.html not found');
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  Pridebook Version Tracker App`);
  console.log(`  Mode       : ${SOURCE_MODE.toUpperCase()}`);
  console.log(`  Dashboard  : http://localhost:${PORT}`);
  console.log(`  Config API : http://localhost:${PORT}/api/config`);
  console.log(`  Deployments: http://localhost:${PORT}/deployments.json`);
  console.log(`=======================================================`);
});
