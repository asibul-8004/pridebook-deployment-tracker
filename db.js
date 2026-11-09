/**
 * Pridebook Version Tracker - Database & GitHub Sync Layer
 * Location: /home/asibul/Pridebook/deployment-tracker/db.js
 * 
 * Uses Node.js native SQLite (node:sqlite) - zero external npm dependencies required!
 * Manages the client_deployments table with:
 * - stack ('F' for Frontend, 'B' for Backend)
 * - client_name ('stage', 'shinshin', 'karupannya', 'ananta-uat', 'ananta-live', etc.)
 * - version, status, deployed_by, last_deployed_at, run_id
 * - is_deployable_to_client (0 = deployable, 1 = has an issue / not deployable)
 * - synced_at, updated_at
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const rootDir = __dirname;
const DB_PATH = process.env.DB_PATH || path.join(rootDir, 'deployments.db');

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    initSchema(dbInstance);
  }
  return dbInstance;
}

function initSchema(db) {
  // Create table with is_deployable_to_client column:
  // 0 = Deployable (Default: all good / ready to deploy)
  // 1 = Has an issue / not deployable
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT NOT NULL,
      stack TEXT NOT NULL CHECK(stack IN ('F', 'B')),
      version TEXT DEFAULT 'unknown',
      status TEXT DEFAULT 'pending_first_deploy',
      deployed_by TEXT DEFAULT 'system',
      last_deployed_at TEXT,
      run_id TEXT,
      is_deployable_to_client INTEGER NOT NULL DEFAULT 0 CHECK(is_deployable_to_client IN (0, 1)),
      issue_notes TEXT DEFAULT '',
      synced_at TEXT,
      updated_at TEXT,
      UNIQUE(client_name, stack)
    );

    CREATE INDEX IF NOT EXISTS idx_deployments_client ON client_deployments(client_name);
    CREATE INDEX IF NOT EXISTS idx_deployments_stack ON client_deployments(stack);
    CREATE INDEX IF NOT EXISTS idx_deployments_deployable ON client_deployments(is_deployable_to_client);
  `);
}

/**
 * Get all deployments from DB, sorted by client_name asc, stack asc
 */
function getAllDeployments(filters = {}) {
  const db = getDb();
  let sql = `SELECT * FROM client_deployments WHERE 1=1`;
  const params = [];

  if (filters.stack && (filters.stack === 'F' || filters.stack === 'B')) {
    sql += ` AND stack = ?`;
    params.push(filters.stack);
  }

  if (filters.client_name) {
    sql += ` AND LOWER(client_name) = LOWER(?)`;
    params.push(filters.client_name);
  }

  if (filters.is_deployable !== undefined && filters.is_deployable !== null) {
    sql += ` AND is_deployable_to_client = ?`;
    params.push(parseInt(filters.is_deployable, 10));
  }

  sql += ` ORDER BY 
    CASE WHEN LOWER(client_name) = 'stage' THEN 0 ELSE 1 END,
    client_name ASC,
    stack ASC`;

  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

/**
 * Update the is_deployable_to_client flag (0 = deployable, 1 = has issue)
 */
function updateDeployableFlag(idOrClient, stackOrValue, maybeValue) {
  const db = getDb();
  const now = new Date().toISOString();

  if (maybeValue !== undefined) {
    // Called with: updateDeployableFlag(client_name, stack, flagValue)
    const client_name = String(idOrClient).toLowerCase().trim();
    const stack = String(stackOrValue).toUpperCase().trim();
    const flagValue = parseInt(maybeValue, 10) === 1 ? 1 : 0;

    const stmt = db.prepare(`
      UPDATE client_deployments 
      SET is_deployable_to_client = ?, updated_at = ?
      WHERE LOWER(client_name) = LOWER(?) AND stack = ?
    `);
    stmt.run(flagValue, now, client_name, stack);

    const selectStmt = db.prepare(`
      SELECT * FROM client_deployments 
      WHERE LOWER(client_name) = LOWER(?) AND stack = ?
    `);
    return selectStmt.get(client_name, stack);
  } else {
    // Called with: updateDeployableFlag(id, flagValue)
    const id = parseInt(idOrClient, 10);
    const flagValue = parseInt(stackOrValue, 10) === 1 ? 1 : 0;

    const stmt = db.prepare(`
      UPDATE client_deployments 
      SET is_deployable_to_client = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(flagValue, now, id);

    const selectStmt = db.prepare(`SELECT * FROM client_deployments WHERE id = ?`);
    return selectStmt.get(id);
  }
}

/**
 * Upsert deployment from GitHub sync without overriding user's is_deployable_to_client setting
 */
function upsertDeployment(record) {
  const db = getDb();
  const client_name = String(record.client_name).toLowerCase().trim();
  const stack = String(record.stack).toUpperCase().trim();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO client_deployments (
      client_name, stack, version, status, deployed_by, last_deployed_at, run_id, is_deployable_to_client, synced_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
    )
    ON CONFLICT(client_name, stack) DO UPDATE SET
      version = excluded.version,
      status = excluded.status,
      deployed_by = excluded.deployed_by,
      last_deployed_at = excluded.last_deployed_at,
      run_id = excluded.run_id,
      synced_at = excluded.synced_at
  `);

  stmt.run(
    client_name,
    stack,
    record.version || 'unknown',
    record.status || 'pending_first_deploy',
    record.deployed_by || 'system',
    record.last_deployed_at || null,
    record.run_id ? String(record.run_id) : null,
    now,
    now
  );
}

/**
 * Fetch Frontend ('F') deployment data from GitHub
 */
async function fetchFrontendDeployments(token) {
  const repo = process.env.GITHUB_FRONTEND_REPO || process.env.GITHUB_REPO || 'pride-erp-local/pride-erp-frontend';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const records = [];

  // 1. Try reading deployments.json from GitHub
  try {
    const url = `https://api.github.com/repos/${repo}/contents/deployments.json?ref=${branch}`;
    const headers = {
      'User-Agent': 'Pridebook-DB-Sync',
      'Accept': 'application/vnd.github.v3+json'
    };
    if (token) headers['Authorization'] = `token ${token.trim()}`;

    const res = await fetch(url, { headers });
    if (res.ok) {
      const result = await res.json();
      let jsonContent = {};
      if (result.content && result.encoding === 'base64') {
        jsonContent = JSON.parse(Buffer.from(result.content, 'base64').toString('utf8'));
      } else if (typeof result === 'object') {
        jsonContent = result;
      }

      for (const [key, val] of Object.entries(jsonContent)) {
        if (!val) continue;
        const current = val.current ? val.current : val;
        records.push({
          client_name: key,
          stack: 'F',
          version: current.version || 'unknown',
          status: current.status || 'pending_first_deploy',
          deployed_by: current.deployed_by || 'system',
          last_deployed_at: current.last_deployed_at || null,
          run_id: current.run_id ? String(current.run_id) : null
        });
      }
    }
  } catch (err) {
    console.warn(`[Sync] Failed to fetch frontend deployments.json from GitHub:`, err.message);
  }

  // Fallback to local deployments.json if GitHub returned nothing
  if (records.length === 0) {
    const localJsonPath = path.join(rootDir, 'deployments.json');
    if (fs.existsSync(localJsonPath)) {
      try {
        const localData = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'));
        for (const [key, val] of Object.entries(localData)) {
          const current = val.current ? val.current : val;
          records.push({
            client_name: key,
            stack: 'F',
            version: current.version || 'unknown',
            status: current.status || 'pending_first_deploy',
            deployed_by: current.deployed_by || 'system',
            last_deployed_at: current.last_deployed_at || null,
            run_id: current.run_id ? String(current.run_id) : null
          });
        }
      } catch (e) {}
    }
  }

  // Ensure default client boxes exist for frontend
  const standardClients = ['stage', 'shinshin', 'karupannya', 'ananta-uat', 'ananta-live'];
  for (const client of standardClients) {
    if (!records.some(r => r.client_name === client)) {
      records.push({
        client_name: client,
        stack: 'F',
        version: 'unknown',
        status: 'pending_first_deploy',
        deployed_by: null,
        last_deployed_at: null,
        run_id: null
      });
    }
  }

  return records;
}

/**
 * Fetch Backend ('B') deployment data from GitHub
 */
async function fetchBackendDeployments(token) {
  const repo = process.env.GITHUB_BACKEND_REPO || 'pride-erp-local/pride-erp-backend';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const records = [];
  const standardClients = ['stage', 'shinshin', 'karupannya', 'ananta-uat', 'ananta-live'];
  const clientLatestMap = new Map();

  const headers = {
    'User-Agent': 'Pridebook-DB-Sync',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) headers['Authorization'] = `token ${token.trim()}`;

  // 1. Try reading deployments.json if backend repo adds it in future
  try {
    const url = `https://api.github.com/repos/${repo}/contents/deployments.json?ref=${branch}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const result = await res.json();
      let jsonContent = {};
      if (result.content && result.encoding === 'base64') {
        jsonContent = JSON.parse(Buffer.from(result.content, 'base64').toString('utf8'));
      }
      for (const [key, val] of Object.entries(jsonContent)) {
        const current = val.current ? val.current : val;
        clientLatestMap.set(key.toLowerCase(), {
          client_name: key.toLowerCase(),
          stack: 'B',
          version: current.version || 'unknown',
          status: current.status || 'pending_first_deploy',
          deployed_by: current.deployed_by || 'system',
          last_deployed_at: current.last_deployed_at || null,
          run_id: current.run_id ? String(current.run_id) : null
        });
      }
    }
  } catch (e) {}

  // 2. Query GitHub Actions workflow runs for backend "Release Deploy (API)"
  if (token) {
    try {
      const runsUrl = `https://api.github.com/repos/${repo}/actions/runs?event=workflow_dispatch&per_page=12`;
      const res = await fetch(runsUrl, { headers });
      if (res.ok) {
        const runsData = await res.json();
        const runs = runsData.workflow_runs || [];

        // Fetch jobs in parallel
        await Promise.all(runs.map(async (run) => {
          try {
            const jobsRes = await fetch(run.jobs_url, { headers });
            if (!jobsRes.ok) return;
            const jobsData = await jobsRes.json();
            const jobs = jobsData.jobs || [];

            for (const job of jobs) {
              const match = job.name.match(/(?:Deploy|Validate release)\s+(v[0-9.]+)\s+(?:to|for)\s+([a-zA-Z0-9_-]+)/i);
              if (match) {
                const tag = match[1];
                const client = match[2].toLowerCase().trim();

                if (!clientLatestMap.has(client)) {
                  clientLatestMap.set(client, {
                    client_name: client,
                    stack: 'B',
                    version: tag,
                    status: run.conclusion === 'success' ? 'success' : (run.conclusion || run.status || 'pending'),
                    deployed_by: run.actor ? run.actor.login : 'system',
                    last_deployed_at: run.created_at,
                    run_id: String(run.id)
                  });
                }
              }
            }
          } catch (e) {}
        }));
      }
    } catch (err) {
      console.warn(`[Sync] Could not inspect backend workflow runs:`, err.message);
    }
  }

  // Ensure standard clients exist for backend
  for (const client of standardClients) {
    if (!clientLatestMap.has(client)) {
      clientLatestMap.set(client, {
        client_name: client,
        stack: 'B',
        version: 'unknown',
        status: 'pending_first_deploy',
        deployed_by: null,
        last_deployed_at: null,
        run_id: null
      });
    }
  }

  return Array.from(clientLatestMap.values());
}

/**
 * Synchronize DB table from GitHub repositories
 */
async function syncDatabaseFromGitHub(token) {
  const frontendRecords = await fetchFrontendDeployments(token);
  const backendRecords = await fetchBackendDeployments(token);
  const allRecords = [...frontendRecords, ...backendRecords];

  for (const rec of allRecords) {
    upsertDeployment(rec);
  }

  return getAllDeployments();
}

module.exports = {
  getDb,
  getAllDeployments,
  updateDeployableFlag,
  upsertDeployment,
  syncDatabaseFromGitHub,
  DB_PATH
};
