/**
 * Pridebook Version Tracker - Database & GitHub Sync Layer
 * Location: /home/asibul/Pridebook/deployment-tracker/db.js
 * 
 * Supports:
 * - Oracle Database 19c (Thin Mode - Zero External Client Binaries)
 * - Native SQLite (fallback / local standalone)
 * 
 * Architecture:
 * - Merged client table SA_DEPLOYMENT_TRACKER (Frontend & Backend combined, no STACK column).
 * - Chronological merge tracking for Frontend & Backend deployments.
 * - Security: Database credentials strictly from .env.
 */

const fs = require('fs');
const path = require('path');
let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  // node:sqlite not supported in this runtime
}

const rootDir = __dirname;

// Detect serverless or read-only filesystem environments (Vercel, AWS Lambda)
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;

  const isServerless = Boolean(
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT ||
    process.env.NOW_REGION
  );

  if (isServerless) {
    return path.join('/tmp', 'deployments.db');
  }

  // Test whether root directory is writable
  try {
    const testFile = path.join(rootDir, `.write_test_${Date.now()}`);
    fs.writeFileSync(testFile, '1');
    fs.unlinkSync(testFile);
    return path.join(rootDir, 'deployments.db');
  } catch (e) {
    return path.join('/tmp', 'deployments.db');
  }
}

let activeDbPath = resolveDbPath();
let sqliteInstance = null;
let oracleDb = null;
let mergedHistoryCache = [];
const inMemoryStore = new Map();

function isOracleConfigured() {
  const dbType = (process.env.DB_TYPE || '').toLowerCase();
  return dbType === 'oracle' && Boolean(process.env.ORACLE_HOST);
}

function getOracleModule() {
  if (!oracleDb && isOracleConfigured()) {
    try {
      oracleDb = require('./oracle-db');
    } catch (err) {
      console.warn('[Oracle Driver Warn]:', err.message);
    }
  }
  return oracleDb;
}

function getSqliteDb() {
  if (sqliteInstance) return sqliteInstance;
  if (!DatabaseSync) return null;

  const targetPath = resolveDbPath();
  try {
    sqliteInstance = new DatabaseSync(targetPath);
    initSqliteSchema(sqliteInstance);
    activeDbPath = targetPath;
    return sqliteInstance;
  } catch (err) {
    console.warn(`[SQLite Warn] Could not open database at ${targetPath}: ${err.message}. Falling back to in-memory SQLite.`);
  }

  // Fallback to in-memory SQLite (:memory:)
  try {
    sqliteInstance = new DatabaseSync(':memory:');
    initSqliteSchema(sqliteInstance);
    activeDbPath = ':memory:';
    return sqliteInstance;
  } catch (memErr) {
    console.warn(`[SQLite Warn] In-memory SQLite failed: ${memErr.message}`);
    sqliteInstance = null;
    return null;
  }
}

function initSqliteSchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS SA_DEPLOYMENT_TRACKER (
        deployment_tracker_no INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name TEXT NOT NULL UNIQUE,
        frontend_version TEXT DEFAULT 'unknown',
        backend_version TEXT DEFAULT 'unknown',
        status TEXT DEFAULT 'pending_first_deploy',
        deployed_by TEXT DEFAULT 'system',
        frontend_deployed_at TEXT,
        backend_deployed_at TEXT,
        frontend_run_id TEXT,
        backend_run_id TEXT,
        is_deployable_to_client INTEGER NOT NULL DEFAULT 0 CHECK(is_deployable_to_client IN (0, 1)),
        issue_notes TEXT DEFAULT '',
        synced_at TEXT,
        updated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sa_deploy_client ON SA_DEPLOYMENT_TRACKER(client_name);
      CREATE INDEX IF NOT EXISTS idx_sa_deploy_flag ON SA_DEPLOYMENT_TRACKER(is_deployable_to_client);
    `);
  } catch (err) {
    console.warn('[SQLite Schema Warn]:', err.message);
  }
}

/**
 * Get all merged client deployments from active DB
 */
async function getAllDeployments(filters = {}) {
  const oracle = getOracleModule();
  if (oracle) {
    try {
      return await oracle.getAllDeployments(filters);
    } catch (err) {
      console.warn('[Oracle Fetch Warn]: Falling back to SQLite:', err.message);
    }
  }

  // SQLite fallback
  const db = getSqliteDb();
  if (db) {
    try {
      let sql = `
        SELECT 
          deployment_tracker_no AS id,
          deployment_tracker_no,
          client_name,
          frontend_version,
          backend_version,
          status,
          deployed_by,
          frontend_deployed_at,
          backend_deployed_at,
          frontend_run_id,
          backend_run_id,
          is_deployable_to_client,
          issue_notes,
          synced_at,
          updated_at
        FROM SA_DEPLOYMENT_TRACKER
        WHERE 1=1
      `;
      const params = [];

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
        client_name ASC`;

      const stmt = db.prepare(sql);
      return stmt.all(...params);
    } catch (err) {
      console.warn('[SQLite Query Warn]:', err.message);
    }
  }

  // In-memory fallback
  let list = Array.from(inMemoryStore.values());
  if (filters.client_name) {
    list = list.filter(r => (r.client_name || '').toLowerCase() === filters.client_name.toLowerCase());
  }
  if (filters.is_deployable !== undefined && filters.is_deployable !== null) {
    list = list.filter(r => r.is_deployable_to_client === parseInt(filters.is_deployable, 10));
  }
  return list;
}

/**
 * Update the is_deployable_to_client flag (0 = deployable, 1 = has issue)
 */
async function updateDeployableFlag(idOrClient, flagValue) {
  const oracle = getOracleModule();
  if (oracle) {
    try {
      return await oracle.updateDeployableFlag(idOrClient, flagValue);
    } catch (err) {
      console.warn('[Oracle Update Warn]: Falling back to SQLite:', err.message);
    }
  }

  const now = new Date().toISOString();
  const flagVal = parseInt(flagValue, 10) === 1 ? 1 : 0;
  const isNum = !isNaN(Number(idOrClient)) && String(idOrClient).trim() !== '';

  // SQLite fallback
  const db = getSqliteDb();
  if (db) {
    try {
      if (isNum) {
        const id = parseInt(idOrClient, 10);
        const stmt = db.prepare(`
          UPDATE SA_DEPLOYMENT_TRACKER 
          SET is_deployable_to_client = ?, updated_at = ?
          WHERE deployment_tracker_no = ?
        `);
        stmt.run(flagVal, now, id);

        const selectStmt = db.prepare(`SELECT * FROM SA_DEPLOYMENT_TRACKER WHERE deployment_tracker_no = ?`);
        const row = selectStmt.get(id);
        if (row && row.client_name) {
          const m = inMemoryStore.get(row.client_name.toLowerCase());
          if (m) m.is_deployable_to_client = flagVal;
        }
        return row;
      } else {
        const client_name = String(idOrClient).toLowerCase().trim();
        const stmt = db.prepare(`
          UPDATE SA_DEPLOYMENT_TRACKER 
          SET is_deployable_to_client = ?, updated_at = ?
          WHERE LOWER(client_name) = LOWER(?)
        `);
        stmt.run(flagVal, now, client_name);

        const selectStmt = db.prepare(`SELECT * FROM SA_DEPLOYMENT_TRACKER WHERE LOWER(client_name) = LOWER(?)`);
        const row = selectStmt.get(client_name);
        const m = inMemoryStore.get(client_name);
        if (m) m.is_deployable_to_client = flagVal;
        return row;
      }
    } catch (err) {
      console.warn('[SQLite Update Warn]:', err.message);
    }
  }

  // In-memory fallback
  const targetKey = String(idOrClient).toLowerCase().trim();
  for (const [key, val] of inMemoryStore.entries()) {
    if (key === targetKey || String(val.deployment_tracker_no) === String(idOrClient) || String(val.id) === String(idOrClient)) {
      val.is_deployable_to_client = flagVal;
      val.updated_at = now;
      return val;
    }
  }
  return null;
}

/**
 * Upsert deployment record into SQLite fallback
 */
async function upsertDeployment(record) {
  const oracle = getOracleModule();
  if (oracle) {
    try {
      return await oracle.upsertDeployment(record);
    } catch (err) {
      console.warn('[Oracle Upsert Warn]: Falling back to SQLite:', err.message);
    }
  }

  const now = new Date().toISOString();
  const client_name = String(record.client_name).toLowerCase().trim();

  // SQLite fallback
  const db = getSqliteDb();
  if (db) {
    try {
      const stmt = db.prepare(`
        INSERT INTO SA_DEPLOYMENT_TRACKER (
          client_name, frontend_version, backend_version, status, deployed_by,
          frontend_deployed_at, backend_deployed_at, frontend_run_id, backend_run_id,
          is_deployable_to_client, synced_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(client_name) DO UPDATE SET
          frontend_version = excluded.frontend_version,
          backend_version = excluded.backend_version,
          status = excluded.status,
          deployed_by = excluded.deployed_by,
          frontend_deployed_at = excluded.frontend_deployed_at,
          backend_deployed_at = excluded.backend_deployed_at,
          frontend_run_id = excluded.frontend_run_id,
          backend_run_id = excluded.backend_run_id,
          synced_at = excluded.synced_at,
          updated_at = excluded.updated_at
      `);

      stmt.run(
        client_name,
        record.frontend_version || 'unknown',
        record.backend_version || 'unknown',
        record.status || 'pending_first_deploy',
        record.deployed_by || 'system',
        record.frontend_deployed_at || null,
        record.backend_deployed_at || null,
        record.frontend_run_id ? String(record.frontend_run_id) : null,
        record.backend_run_id ? String(record.backend_run_id) : null,
        now,
        now
      );
    } catch (err) {
      console.warn('[SQLite Upsert Warn]:', err.message);
    }
  }

  // Secondary in-memory cache update
  const existing = inMemoryStore.get(client_name) || { is_deployable_to_client: 0, deployment_tracker_no: inMemoryStore.size + 1 };
  inMemoryStore.set(client_name, {
    id: existing.deployment_tracker_no || inMemoryStore.size + 1,
    deployment_tracker_no: existing.deployment_tracker_no || inMemoryStore.size + 1,
    client_name,
    frontend_version: record.frontend_version || 'unknown',
    backend_version: record.backend_version || 'unknown',
    status: record.status || 'pending_first_deploy',
    deployed_by: record.deployed_by || 'system',
    frontend_deployed_at: record.frontend_deployed_at || null,
    backend_deployed_at: record.backend_deployed_at || null,
    frontend_run_id: record.frontend_run_id ? String(record.frontend_run_id) : null,
    backend_run_id: record.backend_run_id ? String(record.backend_run_id) : null,
    is_deployable_to_client: existing.is_deployable_to_client ?? 0,
    issue_notes: record.issue_notes || null,
    synced_at: now,
    updated_at: now
  });
}

/**
 * Fetch raw deployment history from GitHub Frontend repository
 */
async function fetchFrontendRawData(token) {
  const repo = process.env.GITHUB_FRONTEND_REPO || process.env.GITHUB_REPO || 'pride-erp-local/pride-erp-frontend';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const eventsByClient = {};

  const headers = {
    'User-Agent': 'Pridebook-DB-Sync',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) headers['Authorization'] = `token ${token.trim()}`;

  try {
    const url = `https://api.github.com/repos/${repo}/contents/deployments.json?ref=${branch}`;
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
        const client = key.toLowerCase().trim();
        if (!eventsByClient[client]) eventsByClient[client] = [];

        // Historical runs
        if (val.history && Array.isArray(val.history)) {
          for (const h of val.history) {
            if (h.version) {
              eventsByClient[client].push({
                stack: 'F',
                version: h.version,
                timestamp: h.last_deployed_at || null,
                deployed_by: h.deployed_by || 'system',
                status: h.status || 'success',
                run_id: h.run_id ? String(h.run_id) : null
              });
            }
          }
        }

        // Current run
        const current = val.current ? val.current : val;
        if (current.version) {
          eventsByClient[client].push({
            stack: 'F',
            version: current.version,
            timestamp: current.last_deployed_at || null,
            deployed_by: current.deployed_by || 'system',
            status: current.status || 'success',
            run_id: current.run_id ? String(current.run_id) : null
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[Sync] Failed to fetch frontend deployments.json:`, err.message);
  }

  // Fallback to local deployments.json if needed
  const localJsonPath = path.join(rootDir, 'deployments.json');
  if (Object.keys(eventsByClient).length === 0 && fs.existsSync(localJsonPath)) {
    try {
      const localData = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'));
      for (const [key, val] of Object.entries(localData)) {
        const client = key.toLowerCase().trim();
        if (!eventsByClient[client]) eventsByClient[client] = [];
        const current = val.current ? val.current : val;
        eventsByClient[client].push({
          stack: 'F',
          version: current.version || 'unknown',
          timestamp: current.last_deployed_at || null,
          deployed_by: current.deployed_by || 'system',
          status: current.status || 'pending_first_deploy',
          run_id: current.run_id ? String(current.run_id) : null
        });
      }
    } catch (e) {}
  }

  return eventsByClient;
}

/**
 * Fetch raw deployment history from GitHub Backend repository
 */
async function fetchBackendRawData(token) {
  const repo = process.env.GITHUB_BACKEND_REPO || 'pride-erp-local/pride-erp-backend';
  const eventsByClient = {};

  const headers = {
    'User-Agent': 'Pridebook-DB-Sync',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) headers['Authorization'] = `token ${token.trim()}`;

  if (token) {
    try {
      const runsUrl = `https://api.github.com/repos/${repo}/actions/runs?per_page=35`;
      const res = await fetch(runsUrl, { headers });
      if (res.ok) {
        const runsData = await res.json();
        const runs = runsData.workflow_runs || [];

        // Check each release deploy workflow
        await Promise.all(runs.map(async (run) => {
          if (!run.name || !run.name.includes('Release Deploy')) return;
          try {
            const jobsRes = await fetch(run.jobs_url, { headers });
            if (!jobsRes.ok) return;
            const jobsData = await jobsRes.json();
            for (const job of jobsData.jobs || []) {
              const match = job.name.match(/(?:Deploy|Validate release)\s+(v[0-9.]+)\s+(?:to|for)\s+([a-zA-Z0-9_-]+)/i);
              if (match && job.name.startsWith('Deploy')) {
                const client = match[2].toLowerCase().trim();
                if (!eventsByClient[client]) eventsByClient[client] = [];
                eventsByClient[client].push({
                  stack: 'B',
                  version: match[1],
                  timestamp: job.completed_at || run.created_at,
                  deployed_by: run.actor?.login || 'system',
                  status: job.conclusion === 'success' ? 'success' : (job.conclusion || 'pending'),
                  run_id: String(run.id)
                });
              }
            }
          } catch (e) {}
        }));
      }
    } catch (err) {
      console.warn(`[Sync] Could not inspect backend workflow runs:`, err.message);
    }
  }

  return eventsByClient;
}

/**
 * Synchronize DB table from GitHub repositories using chronological merge
 */
async function syncDatabaseFromGitHub(token) {
  const frontendEvents = await fetchFrontendRawData(token);
  const backendEvents = await fetchBackendRawData(token);

  const standardClients = ['stage', 'shinshin', 'bengal', 'karupannya', 'ananta-uat', 'ananta-live'];
  const allClientNames = Array.from(new Set([
    ...standardClients,
    ...Object.keys(frontendEvents),
    ...Object.keys(backendEvents)
  ]));

  const latestMergedClients = [];
  const fullMergedTimeline = [];

  for (const client of allClientNames) {
    const rawF = (frontendEvents[client] || []).filter(e => e.timestamp);
    const rawB = (backendEvents[client] || []).filter(e => e.timestamp);

    // Sort all events chronologically (oldest to newest)
    const combinedEvents = [...rawF, ...rawB].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let curF = { version: 'unknown', deployed_at: null, deployed_by: null, run_id: null, status: 'pending_first_deploy' };
    let curB = { version: 'unknown', deployed_at: null, deployed_by: null, run_id: null, status: 'pending_first_deploy' };

    for (const ev of combinedEvents) {
      if (ev.stack === 'F') {
        curF = {
          version: ev.version,
          deployed_at: ev.timestamp,
          deployed_by: ev.deployed_by,
          run_id: ev.run_id,
          status: ev.status
        };
      } else if (ev.stack === 'B') {
        curB = {
          version: ev.version,
          deployed_at: ev.timestamp,
          deployed_by: ev.deployed_by,
          run_id: ev.run_id,
          status: ev.status
        };
      }

      // Snapshot at this point in time
      fullMergedTimeline.push({
        client_name: client,
        event_stack: ev.stack, // which component triggered this event ('F' or 'B')
        frontend_version: curF.version,
        backend_version: curB.version,
        frontend_deployed_at: curF.deployed_at,
        backend_deployed_at: curB.deployed_at,
        deployed_by: ev.deployed_by || 'system',
        status: ev.status || 'success',
        run_id: ev.run_id,
        event_time: ev.timestamp
      });
    }

    // Determine latest combined status
    const overallStatus = (curF.status === 'success' || curB.status === 'success') 
      ? 'success' 
      : (curF.status || curB.status || 'pending_first_deploy');

    const mergedRecord = {
      client_name: client,
      frontend_version: curF.version,
      backend_version: curB.version,
      status: overallStatus,
      deployed_by: curF.deployed_by || curB.deployed_by || 'system',
      frontend_deployed_at: curF.deployed_at,
      backend_deployed_at: curB.deployed_at,
      frontend_run_id: curF.run_id,
      backend_run_id: curB.run_id,
      is_deployable_to_client: 0
    };

    latestMergedClients.push(mergedRecord);

    // Upsert into active DB table SA_DEPLOYMENT_TRACKER
    await upsertDeployment(mergedRecord);
  }

  // Update memory cache for history queries (newest first)
  mergedHistoryCache = fullMergedTimeline.sort((a, b) => new Date(b.event_time) - new Date(a.event_time));

  return await getAllDeployments();
}

/**
 * Get merged history timeline (for Tab 2)
 */
function getMergedHistory(clientFilter) {
  if (clientFilter && clientFilter !== 'all') {
    return mergedHistoryCache.filter(h => h.client_name.toLowerCase() === clientFilter.toLowerCase());
  }
  return mergedHistoryCache;
}

function getActiveDbType() {
  return isOracleConfigured() ? 'Oracle (19c)' : 'SQLite';
}

module.exports = {
  getAllDeployments,
  updateDeployableFlag,
  upsertDeployment,
  syncDatabaseFromGitHub,
  getMergedHistory,
  getActiveDbType,
  get DB_PATH() {
    return activeDbPath;
  },
  resolveDbPath
};
