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
const db = require('./db');

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
const SOURCE_MODE = process.env.SOURCE_MODE;
const GITHUB_REPO = process.env.GITHUB_REPO;
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
  try {
    const targetPath = getJsonPath();
    const formatted = JSON.stringify(data, null, 2) + '\n';
    fs.writeFileSync(targetPath, formatted, 'utf8');

    // If frontend folder exists, keep it in sync
    if (fs.existsSync(frontendJsonPath) && targetPath !== frontendJsonPath) {
      try {
        fs.writeFileSync(frontendJsonPath, formatted, 'utf8');
      } catch (e) {}
    }
  } catch (err) {
    console.warn('[Write Notice]: Read-only filesystem, skipped disk file write:', err.message);
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
  try {
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
      try {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(JSON.stringify({
          port: PORT,
          sourceMode: Boolean(GITHUB_TOKEN && GITHUB_TOKEN.length > 5) ? 'github' : SOURCE_MODE,
          githubRepo: GITHUB_REPO,
          githubBranch: GITHUB_BRANCH,
          hasServerToken: Boolean(GITHUB_TOKEN && GITHUB_TOKEN.length > 5),
          dbType: db.getActiveDbType(),
          dbPath: db.DB_PATH
        }, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /api/db/deployments - Query database records (with optional sync & stack filters)
    // GET /api/deployments or /api/db/deployments
    if ((pathname === '/api/deployments' || pathname === '/api/db/deployments') && req.method === 'GET') {
      try {
        const forceSync = parsedUrl.searchParams.get('sync') === 'true' || parsedUrl.searchParams.get('sync') === '1';
        const clientFilter = parsedUrl.searchParams.get('client');

        // Internal synchronization: checks GitHub against DB, onboards new clients, updates DB, records history in DTL table
        const result = await db.getDeploymentsWithSync({ token: GITHUB_TOKEN, forceSync });
        let rows = result.data || [];

        if (clientFilter && clientFilter !== 'all') {
          rows = rows.filter(r => (r.client_name || '').toLowerCase() === clientFilter.toLowerCase());
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(JSON.stringify({
          success: true,
          db_type: result.db_type,
          source: 'database',
          count: rows.length,
          deployable_count: rows.filter(r => r.is_deployable_to_client === 0).length,
          issue_count: rows.filter(r => r.is_deployable_to_client === 1).length,
          data: rows,
          history: result.history || [],
          synced_at: result.synced_at
        }, null, 2));
      } catch (err) {
        console.error('[API Error /api/deployments]:', err.message);
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(JSON.stringify({
          success: false,
          error: err.message
        }, null, 2));
      }
      return;
    }

    // GET /api/deployments/history or /api/db/history - Child Table (SA_DEPLOYMENT_TRACKER_DTL) history
    if ((pathname === '/api/deployments/history' || pathname === '/api/db/history') && req.method === 'GET') {
      try {
        const clientFilter = parsedUrl.searchParams.get('client');
        const history = await db.getDeploymentHistory(clientFilter);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(JSON.stringify({
          success: true,
          db_type: db.getActiveDbType(),
          source: 'database',
          count: history ? history.length : 0,
          data: history || []
        }, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // POST or GET /api/db/sync - Trigger explicit synchronization with GitHub into Database
    if ((pathname === '/api/db/sync' || pathname === '/api/sync') && (req.method === 'POST' || req.method === 'GET')) {
      try {
        const result = await db.getDeploymentsWithSync({ token: GITHUB_TOKEN, forceSync: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `Synchronized with GitHub into ${result.db_type} successfully`,
          count: result.count,
          data: result.data,
          history: result.history
        }, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // POST /api/deployments/toggle-deployable - Update is_deployable_to_client flag (0 or 1)
    if ((pathname === '/api/deployments/toggle-deployable' || pathname === '/api/deployable') && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const { id, dtl_id, history_id, client_name, client, is_deployable_to_client, is_deployable } = payload;
          const rawFlag = is_deployable_to_client !== undefined ? is_deployable_to_client : is_deployable;
          const flagVal = parseInt(rawFlag, 10) === 1 ? 1 : 0;
          const historyTarget = dtl_id || history_id;

          if (historyTarget) {
            const record = await db.updateHistoryDeployableFlag(historyTarget, flagVal);
            console.log(`[DB History Updated] DTL ID ${historyTarget}: is_deployable_to_client = ${flagVal}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              table: 'SA_DEPLOYMENT_TRACKER_DTL',
              message: flagVal === 0 ? 'History release marked as Deployable (0)' : 'History release marked as Has Issue (1)',
              record
            }));
            return;
          }

          const target = id || client_name || client;
          if (!target) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'dtl_id, id, or client_name required' }));
            return;
          }

          const record = await db.updateDeployableFlag(target, flagVal);
          console.log(`[DB Updated] ${record?.client_name || target}: is_deployable_to_client = ${flagVal} (${flagVal === 0 ? 'Deployable' : 'Has Issue'})`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            table: 'SA_DEPLOYMENT_TRACKER',
            message: flagVal === 0 ? 'Marked as Deployable (0)' : 'Marked as Has Issue / Not Deployable (1)',
            record
          }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON payload: ' + err.message }));
        }
      });
      return;
    }

    // GET /deployments.json - Always backed by Database
    if (pathname === '/deployments.json' && req.method === 'GET') {
      try {
        const forceSync = parsedUrl.searchParams.get('sync') === 'true';
        const result = await db.getDeploymentsWithSync({ token: GITHUB_TOKEN, forceSync });
        const format = parsedUrl.searchParams.get('format');

        if (format === 'db' || format === 'array') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          });
          res.end(JSON.stringify(result.data, null, 2));
          return;
        }

        const dict = {};
        for (const row of (result.data || [])) {
          dict[row.client_name] = {
            client: row.client_name,
            frontend_version: row.frontend_version,
            backend_version: row.backend_version,
            status: row.status,
            deployed_by: row.deployed_by,
            frontend_deployed_at: row.frontend_deployed_at,
            backend_deployed_at: row.backend_deployed_at,
            is_deployable_to_client: row.is_deployable_to_client,
            current: {
              version: row.frontend_version,
              status: row.status,
              deployed_by: row.deployed_by,
              last_deployed_at: row.frontend_deployed_at,
              run_id: row.frontend_run_id
            }
          };
        }
        dict._db_deployments = result.data;
        dict._db_history = result.history;
        dict._source = 'database';
        dict._db_type = result.db_type;

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(JSON.stringify(dict, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
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
  } catch (fatalErr) {
    console.error('[Server Fatal Error]:', fatalErr.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: fatalErr.message }));
    }
  }
});

// Auto-start listener when run directly (not imported as module)
if (require.main === module || !process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`  Pridebook Version Tracker App`);
    console.log(`  Mode       : ${SOURCE_MODE.toUpperCase()}`);
    console.log(`  Database   : ${db.getActiveDbType()}`);
    console.log(`  Dashboard  : http://localhost:${PORT}`);
    console.log(`  Config API : http://localhost:${PORT}/api/config`);
    console.log(`  DB API     : http://localhost:${PORT}/api/db/deployments`);
    console.log(`  Deployments: http://localhost:${PORT}/deployments.json`);
    console.log(`=======================================================`);

    // Background sync from GitHub into DB table on server start
    db.syncDatabaseFromGitHub(GITHUB_TOKEN)
      .then(rows => console.log(`[DB] Startup sync completed: ${rows.length} records in ${db.getActiveDbType()}.`))
      .catch(err => console.warn(`[DB] Startup sync warn: ${err.message}`));
  });
}

module.exports = server;
