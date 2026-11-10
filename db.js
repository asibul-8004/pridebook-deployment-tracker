/**
 * Pridebook Version Tracker - Database & GitHub Sync Layer
 * Location: /home/asibul/Pridebook/deployment-tracker/db.js
 * 
 * Supports:
 * - Oracle Database 19c (Thin Mode - Zero External Client Binaries)
 * - Native SQLite (fallback / local standalone / serverless)
 * 
 * Master-Detail Architecture:
 * - Master Table: SA_DEPLOYMENT_TRACKER (Client boxes & latest merged version snapshot)
 * - Child Table : SA_DEPLOYMENT_TRACKER_DTL (Chronological deployment & release history)
 * 
 * Synchronization Strategy:
 * - Internally fetches deployment metadata from GitHub repositories.
 * - Compares with database records to detect mismatches / new releases.
 * - Automatically onboards new clients into master table SA_DEPLOYMENT_TRACKER.
 * - Inserts chronological release history into child table SA_DEPLOYMENT_TRACKER_DTL.
 * - ALWAYS returns and renders data directly from the Database.
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
let isOracleFailed = false;
let mergedHistoryCache = [];
const inMemoryStore = new Map();
const workflowJobsCache = new Map();
let lastSyncCheckTime = 0;

function isOracleConfigured() {
  const host = (process.env.ORACLE_HOST || '').trim();
  const isPrivateIp = host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('127.') || host === 'localhost';
  if ((process.env.VERCEL || process.env.NOW_REGION) && isPrivateIp) {
    // Vercel serverless environment in cloud cannot route to private intranet LAN IPs
    return false;
  }
  const dbType = (process.env.DB_TYPE || '').toLowerCase();
  return dbType === 'oracle' && Boolean(host);
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

function loadRegisteredClientsFromDisk() {
  try {
    const candidates = [
      path.join(process.cwd(), process.env.DEPLOYMENTS_FILE || 'deployments.json'),
      path.join(__dirname, process.env.DEPLOYMENTS_FILE || 'deployments.json'),
      path.join(process.cwd(), 'deployments.json'),
      path.join(__dirname, 'deployments.json')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        return Object.keys(parsed)
          .filter(k => !k.startsWith('_'))
          .map(k => k.toLowerCase().trim());
      }
    }
  } catch (err) {
    console.warn('[loadRegisteredClientsFromDisk Warn]:', err.message);
  }
  return [];
}

function initSqliteSchema(db) {
  try {
    // Migration: ensure is_deployable_to_client and is_backend_deployable columns exist on pre-existing SQLite databases
    try {
      db.exec(`ALTER TABLE SA_DEPLOYMENT_TRACKER ADD COLUMN is_deployable_to_client INTEGER NOT NULL DEFAULT 0;`);
    } catch (e) {}
    try {
      db.exec(`ALTER TABLE SA_DEPLOYMENT_TRACKER ADD COLUMN is_backend_deployable INTEGER NOT NULL DEFAULT 0;`);
    } catch (e) {}
    try {
      db.exec(`ALTER TABLE SA_DEPLOYMENT_TRACKER_DTL ADD COLUMN is_deployable_to_client INTEGER NOT NULL DEFAULT 0;`);
    } catch (e) {}
    try {
      db.exec(`ALTER TABLE SA_DEPLOYMENT_TRACKER_DTL ADD COLUMN is_backend_deployable INTEGER NOT NULL DEFAULT 0;`);
    } catch (e) {}

    // Master Table: SA_DEPLOYMENT_TRACKER
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
        is_backend_deployable INTEGER NOT NULL DEFAULT 0 CHECK(is_backend_deployable IN (0, 1)),
        issue_notes TEXT DEFAULT '',
        synced_at TEXT,
        updated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sa_deploy_client ON SA_DEPLOYMENT_TRACKER(client_name);
      CREATE INDEX IF NOT EXISTS idx_sa_deploy_flag ON SA_DEPLOYMENT_TRACKER(is_deployable_to_client);
      CREATE INDEX IF NOT EXISTS idx_sa_deploy_b_flag ON SA_DEPLOYMENT_TRACKER(is_backend_deployable);
    `);

    // Child Detail Table: SA_DEPLOYMENT_TRACKER_DTL
    db.exec(`
      CREATE TABLE IF NOT EXISTS SA_DEPLOYMENT_TRACKER_DTL (
        deployment_tracker_dtl_no INTEGER PRIMARY KEY AUTOINCREMENT,
        deployment_tracker_no INTEGER NOT NULL,
        client_name TEXT NOT NULL,
        event_stack TEXT NOT NULL,
        frontend_version TEXT DEFAULT 'unknown',
        backend_version TEXT DEFAULT 'unknown',
        status TEXT DEFAULT 'success',
        deployed_by TEXT DEFAULT 'system',
        frontend_deployed_at TEXT,
        backend_deployed_at TEXT,
        run_id TEXT,
        event_time TEXT,
        is_deployable_to_client INTEGER NOT NULL DEFAULT 0 CHECK(is_deployable_to_client IN (0, 1)),
        is_backend_deployable INTEGER NOT NULL DEFAULT 0 CHECK(is_backend_deployable IN (0, 1)),
        created_at TEXT,
        FOREIGN KEY (deployment_tracker_no) REFERENCES SA_DEPLOYMENT_TRACKER(deployment_tracker_no) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sa_deploy_dtl_fk ON SA_DEPLOYMENT_TRACKER_DTL(deployment_tracker_no);
      CREATE INDEX IF NOT EXISTS idx_sa_deploy_dtl_client ON SA_DEPLOYMENT_TRACKER_DTL(client_name);
      CREATE INDEX IF NOT EXISTS idx_sa_deploy_dtl_time ON SA_DEPLOYMENT_TRACKER_DTL(event_time);
      CREATE INDEX IF NOT EXISTS idx_sa_deploy_dtl_flag ON SA_DEPLOYMENT_TRACKER_DTL(is_deployable_to_client);
      CREATE INDEX IF NOT EXISTS idx_sa_deploy_dtl_b_flag ON SA_DEPLOYMENT_TRACKER_DTL(is_backend_deployable);
    `);

    // 1. HARD DEDUPLICATION & PURGE BOGUS DUMMY RUNS
    try {
      db.exec(`
        DELETE FROM SA_DEPLOYMENT_TRACKER_DTL 
        WHERE run_id LIKE 'init_%' 
           OR event_time LIKE '2026-11-10T04:22%';

        DELETE FROM SA_DEPLOYMENT_TRACKER_DTL 
        WHERE deployment_tracker_dtl_no NOT IN (
          SELECT MIN(deployment_tracker_dtl_no) 
          FROM SA_DEPLOYMENT_TRACKER_DTL 
          GROUP BY client_name, event_stack, COALESCE(run_id, event_time)
        );
      `);
    } catch (_) {}

    // 2. HARD UNIQUE CONSTRAINT: Prevent any future duplicate runs
    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sa_deploy_dtl_unique_run 
        ON SA_DEPLOYMENT_TRACKER_DTL(client_name, event_stack, run_id)
        WHERE run_id IS NOT NULL AND length(run_id) > 0;
      `);
    } catch (_) {}

    // 3. ENSURE ALL REGISTERED CLIENTS FROM deployments.json EXIST IN MASTER
    const nowIso = new Date().toISOString();
    const regClients = loadRegisteredClientsFromDisk();
    for (const client of regClients) {
      try {
        db.prepare(`
          INSERT INTO SA_DEPLOYMENT_TRACKER (
            client_name, frontend_version, backend_version, status, deployed_by,
            is_deployable_to_client, synced_at, updated_at
          ) VALUES (?, 'unknown', 'unknown', 'pending_first_deploy', 'system', 0, ?, ?)
          ON CONFLICT(client_name) DO NOTHING
        `).run(client, nowIso, nowIso);
      } catch (_) {}
    }

    // 4. HEAL UNKNOWN VERSIONS IN DETAIL TABLE USING MASTER
    try {
      db.exec(`
        UPDATE SA_DEPLOYMENT_TRACKER_DTL 
        SET frontend_version = (
          SELECT m.frontend_version 
          FROM SA_DEPLOYMENT_TRACKER m 
          WHERE LOWER(m.client_name) = LOWER(SA_DEPLOYMENT_TRACKER_DTL.client_name)
            AND m.frontend_version != 'unknown'
        )
        WHERE frontend_version = 'unknown' 
          AND client_name IN (SELECT client_name FROM SA_DEPLOYMENT_TRACKER WHERE frontend_version != 'unknown');

        UPDATE SA_DEPLOYMENT_TRACKER_DTL 
        SET backend_version = (
          SELECT m.backend_version 
          FROM SA_DEPLOYMENT_TRACKER m 
          WHERE LOWER(m.client_name) = LOWER(SA_DEPLOYMENT_TRACKER_DTL.client_name)
            AND m.backend_version != 'unknown'
        )
        WHERE backend_version = 'unknown' 
          AND client_name IN (SELECT client_name FROM SA_DEPLOYMENT_TRACKER WHERE backend_version != 'unknown');
      `);
    } catch (_) {}
  } catch (err) {
    console.warn('[SQLite Schema Warn]:', err.message);
  }
}

/**
 * Get all merged client deployments from active DB (Master Table: SA_DEPLOYMENT_TRACKER)
 */
async function getAllDeployments(filters = {}) {
  const oracle = getOracleModule();
  if (oracle) {
    try {
      const rows = await oracle.getAllDeployments(filters);
      isOracleFailed = false;
      return rows;
    } catch (err) {
      isOracleFailed = true;
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
      let rows = stmt.all(...params);

      // Ensure all registered clients from deployments.json exist in results
      if (!filters.client_name) {
        const existingSet = new Set((rows || []).map(r => (r.client_name || '').toLowerCase()));
        const regClients = loadRegisteredClientsFromDisk();
        const missing = regClients.filter(c => !existingSet.has(c));
        if (missing.length > 0) {
          const nowIso = new Date().toISOString();
          for (const m of missing) {
            try {
              db.prepare(`
                INSERT INTO SA_DEPLOYMENT_TRACKER (
                  client_name, frontend_version, backend_version, status, deployed_by,
                  is_deployable_to_client, synced_at, updated_at
                ) VALUES (?, 'unknown', 'unknown', 'pending_first_deploy', 'system', 0, ?, ?)
                ON CONFLICT(client_name) DO NOTHING
              `).run(m, nowIso, nowIso);
            } catch (_) {}
          }
          rows = stmt.all(...params);
        }
      }

      return rows;
    } catch (err) {
      console.warn('[SQLite Query Warn]:', err.message);
    }
  }

  // In-memory fallback: guarantee registered clients exist
  if (inMemoryStore.size === 0) {
    const regClients = loadRegisteredClientsFromDisk();
    const nowIso = new Date().toISOString();
    for (const c of regClients) {
      inMemoryStore.set(c, {
        deployment_tracker_no: inMemoryStore.size + 1,
        id: inMemoryStore.size + 1,
        client_name: c,
        frontend_version: 'unknown',
        backend_version: 'unknown',
        status: 'pending_first_deploy',
        deployed_by: 'system',
        frontend_deployed_at: null,
        backend_deployed_at: null,
        frontend_run_id: null,
        backend_run_id: null,
        is_deployable_to_client: 0,
        issue_notes: '',
        synced_at: nowIso,
        updated_at: nowIso
      });
    }
  }
  if (filters.client_name) {
    list = list.filter(r => (r.client_name || '').toLowerCase() === filters.client_name.toLowerCase());
  }
  if (filters.is_deployable !== undefined && filters.is_deployable !== null) {
    list = list.filter(r => r.is_deployable_to_client === parseInt(filters.is_deployable, 10));
  }
  return list;
}

/**
 * Get deployment history from active DB (Child Table: SA_DEPLOYMENT_TRACKER_DTL)
 */
async function getDeploymentHistory(clientFilter) {
  const oracle = getOracleModule();
  if (oracle) {
    try {
      const history = await oracle.getDeploymentHistory(clientFilter);
      if (Array.isArray(history) && history.length > 0) {
        return history;
      }
    } catch (err) {
      console.warn('[Oracle History Warn]: Falling back to SQLite/memory:', err.message);
    }
  }

  // SQLite fallback
  const db = getSqliteDb();
  if (db) {
    try {
      let sql = `
        SELECT 
          dtl.deployment_tracker_dtl_no AS id,
          dtl.deployment_tracker_dtl_no,
          dtl.deployment_tracker_no,
          dtl.client_name,
          dtl.event_stack,
          dtl.frontend_version,
          dtl.backend_version,
          dtl.status,
          dtl.deployed_by,
          dtl.frontend_deployed_at,
          dtl.backend_deployed_at,
          dtl.RUN_ID AS run_id,
          dtl.EVENT_TIME AS event_time,
          COALESCE(dtl.is_deployable_to_client, COALESCE(m.is_deployable_to_client, 0)) AS is_deployable_to_client,
          COALESCE(dtl.is_backend_deployable, COALESCE(m.is_backend_deployable, 0)) AS is_backend_deployable
        FROM SA_DEPLOYMENT_TRACKER_DTL dtl
        LEFT JOIN SA_DEPLOYMENT_TRACKER m ON dtl.deployment_tracker_no = m.deployment_tracker_no
        WHERE 1=1
      `;
      const params = [];
      if (clientFilter && clientFilter !== 'all') {
        sql += ` AND LOWER(dtl.client_name) = LOWER(?)`;
        params.push(clientFilter);
      }
      sql += ` ORDER BY dtl.event_time DESC, dtl.deployment_tracker_dtl_no DESC`;

      const stmt = db.prepare(sql);
      const rows = stmt.all(...params);
      if (rows && rows.length > 0) {
        // Group by client
        const byClient = {};
        for (const r of rows) {
          const c = (r.client_name || '').toLowerCase();
          if (!byClient[c]) byClient[c] = [];
          byClient[c].push(r);
        }

        // Get master map for any missing baseline info
        const masterMap = new Map();
        try {
          const masters = db.prepare('SELECT LOWER(client_name) AS name, frontend_version, backend_version, frontend_deployed_at, backend_deployed_at, deployed_by, frontend_run_id, backend_run_id FROM SA_DEPLOYMENT_TRACKER').all();
          for (const m of masters) {
            masterMap.set(m.name, m);
          }
        } catch (_) {}

        const dedupedHistory = [];

        for (const [cName, clientRows] of Object.entries(byClient)) {
          // Sort descending by event_time
          clientRows.sort((a, b) => new Date(b.event_time || 0) - new Date(a.event_time || 0));

          const master = masterMap.get(cName);
          const seenRuns = new Set();
          const seenCombos = new Set();

          for (let i = 0; i < clientRows.length; i++) {
            const r = clientRows[i];

            if (r.event_stack === 'F') {
              r.frontend_run_id = r.run_id;
              r.frontend_deployed_at = r.event_time || r.frontend_deployed_at;
              // Find matching B event at or before this event_time
              let otherB = clientRows.slice(i).find(x => x.event_stack === 'B');
              if (!otherB) otherB = clientRows.find(x => x.event_stack === 'B');
              if (otherB) {
                if (!r.backend_version || r.backend_version === 'unknown') {
                  r.backend_version = otherB.backend_version;
                }
                r.backend_deployed_at = otherB.event_time || otherB.backend_deployed_at;
                r.backend_run_id = otherB.run_id;
              } else if (master) {
                if (!r.backend_version || r.backend_version === 'unknown') {
                  r.backend_version = master.backend_version;
                }
                if (!r.backend_deployed_at) r.backend_deployed_at = master.backend_deployed_at;
                if (!r.backend_run_id) r.backend_run_id = master.backend_run_id;
              }
            } else if (r.event_stack === 'B') {
              r.backend_run_id = r.run_id;
              r.backend_deployed_at = r.event_time || r.backend_deployed_at;
              // Find matching F event at or before this event_time
              let otherF = clientRows.slice(i).find(x => x.event_stack === 'F');
              if (!otherF) otherF = clientRows.find(x => x.event_stack === 'F');
              if (otherF) {
                if (!r.frontend_version || r.frontend_version === 'unknown') {
                  r.frontend_version = otherF.frontend_version;
                }
                r.frontend_deployed_at = otherF.event_time || otherF.frontend_deployed_at;
                r.frontend_run_id = otherF.run_id;
              } else if (master) {
                if (!r.frontend_version || r.frontend_version === 'unknown') {
                  r.frontend_version = master.frontend_version;
                }
                if (!r.frontend_deployed_at) r.frontend_deployed_at = master.frontend_deployed_at;
                if (!r.frontend_run_id) r.frontend_run_id = master.frontend_run_id;
              }
            }

            // Deduplication keys:
            // 1. Uniqueness by frontend_run_id + backend_run_id
            const runKey = (r.frontend_run_id && r.backend_run_id) 
              ? `${cName}|${r.frontend_run_id}|${r.backend_run_id}` 
              : null;
            // 2. Uniqueness by versions and deployment timestamps
            const comboKey = `${cName}|${r.frontend_version || ''}|${r.backend_version || ''}|${r.frontend_deployed_at || ''}|${r.backend_deployed_at || ''}`;

            if ((runKey && seenRuns.has(runKey)) || seenCombos.has(comboKey)) {
              continue; // Duplicate record, skip!
            }
            if (runKey) seenRuns.add(runKey);
            seenCombos.add(comboKey);
            dedupedHistory.push(r);
          }
        }

        dedupedHistory.sort((a, b) => new Date(b.event_time || 0) - new Date(a.event_time || 0));
        return dedupedHistory;
      }
    } catch (err) {
      // In case detail table not populated yet
    }
  }

  // Fallback to memory cache
  if (clientFilter && clientFilter !== 'all') {
    return mergedHistoryCache.filter(h => h.client_name.toLowerCase() === clientFilter.toLowerCase());
  }
  return mergedHistoryCache;
}

/**
 * Update the deployable flag on a specific history record in SA_DEPLOYMENT_TRACKER_DTL
 * Supports stackType: 'frontend' (is_deployable_to_client) or 'backend' (is_backend_deployable)
 */
async function updateHistoryDeployableFlag(dtlId, flagValue, stackType = 'frontend') {
  const flagVal = parseInt(flagValue, 10) === 1 ? 1 : 0;
  const idNum = parseInt(dtlId, 10);
  const isBackend = stackType === 'backend' || stackType === 'B';
  const colName = isBackend ? 'is_backend_deployable' : 'is_deployable_to_client';

  const oracle = getOracleModule();
  if (oracle) {
    try {
      const rec = await oracle.updateHistoryDeployableFlag(dtlId, flagVal, stackType);
      if (rec) {
        // Also update memory cache
        for (const h of mergedHistoryCache) {
          if (h.id === idNum || h.deployment_tracker_dtl_no === idNum) {
            h[colName] = flagVal;
          }
        }
        return rec;
      }
    } catch (err) {
      console.warn('[Oracle History Toggle Warn]:', err.message);
    }
  }

  // SQLite fallback
  const db = getSqliteDb();
  if (db) {
    try {
      const stmt = db.prepare(`
        UPDATE SA_DEPLOYMENT_TRACKER_DTL 
        SET ${colName} = ?
        WHERE deployment_tracker_dtl_no = ?
      `);
      stmt.run(flagVal, idNum);

      const row = db.prepare(`SELECT * FROM SA_DEPLOYMENT_TRACKER_DTL WHERE deployment_tracker_dtl_no = ?`).get(idNum);
      if (row) {
        row.id = row.deployment_tracker_dtl_no;
        for (const h of mergedHistoryCache) {
          if (h.id === idNum || h.deployment_tracker_dtl_no === idNum) {
            h[colName] = flagVal;
          }
        }
        return row;
      }
    } catch (err) {
      console.warn('[SQLite History Toggle Warn]:', err.message);
    }
  }

  // In-memory fallback
  for (const h of mergedHistoryCache) {
    if (h.id === idNum || h.deployment_tracker_dtl_no === idNum) {
      h[colName] = flagVal;
      return h;
    }
  }
  return null;
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
 * Upsert deployment record into master table. Auto-onboards client if not present.
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
  let trackerNo = null;

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

      const row = db.prepare('SELECT deployment_tracker_no FROM SA_DEPLOYMENT_TRACKER WHERE client_name = ?').get(client_name);
      if (row) trackerNo = row.deployment_tracker_no;
    } catch (err) {
      console.warn('[SQLite Upsert Warn]:', err.message);
    }
  }

  // Secondary in-memory cache update
  const existing = inMemoryStore.get(client_name) || { is_deployable_to_client: 0, deployment_tracker_no: inMemoryStore.size + 1 };
  const calculatedNo = trackerNo || existing.deployment_tracker_no || (inMemoryStore.size + 1);

  inMemoryStore.set(client_name, {
    id: calculatedNo,
    deployment_tracker_no: calculatedNo,
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

  return calculatedNo;
}

/**
 * Check if a status string represents a terminal (final) state
 */
function isTerminalStatus(status) {
  if (!status) return false;
  const s = String(status).toLowerCase().trim();
  return s === 'success' || s === 'completed' || s === 'failure' || s === 'failed' || s === 'cancelled' || s === 'timed_out';
}

/**
 * Get map of known run_id -> status from database (Detail Table: SA_DEPLOYMENT_TRACKER_DTL)
 */
async function getKnownRunsMap() {
  const oracle = getOracleModule();
  if (oracle) {
    try {
      const map = await oracle.getKnownRunsMap();
      if (map && map.size > 0) return map;
    } catch (err) {
      console.warn('[Oracle Known Runs Warn]: Falling back to SQLite:', err.message);
    }
  }

  // SQLite fallback
  const db = getSqliteDb();
  const map = new Map();
  if (db) {
    try {
      const rows = db.prepare('SELECT run_id, status FROM SA_DEPLOYMENT_TRACKER_DTL WHERE run_id IS NOT NULL AND length(run_id) > 0').all();
      for (const r of rows) {
        if (r.run_id) map.set(String(r.run_id), (r.status || '').toLowerCase());
      }
    } catch (_) {}
  }
  return map;
}

/**
 * Update the status of a specific history record by its run_id
 */
async function updateHistoryStatus(runId, status) {
  if (!runId) return;
  const oracle = getOracleModule();
  if (oracle) {
    try {
      await oracle.updateHistoryStatus(runId, status);
    } catch (_) {}
  }

  const db = getSqliteDb();
  if (db) {
    try {
      db.prepare('UPDATE SA_DEPLOYMENT_TRACKER_DTL SET status = ? WHERE run_id = ?').run(status, String(runId));
    } catch (_) {}
  }

  for (const h of mergedHistoryCache) {
    if (String(h.run_id) === String(runId)) {
      h.status = status;
    }
  }
}

/**
 * Refresh master table client versions (SA_DEPLOYMENT_TRACKER) from latest detail events (SA_DEPLOYMENT_TRACKER_DTL)
 */
async function refreshMasterClientsFromDtl(clientList) {
  let targets = clientList;
  if (!targets || targets.length === 0) {
    const curDb = getSqliteDb();
    if (curDb) {
      try {
        const rows = curDb.prepare(`
          SELECT DISTINCT client_name FROM SA_DEPLOYMENT_TRACKER
          UNION
          SELECT DISTINCT client_name FROM SA_DEPLOYMENT_TRACKER_DTL
        `).all();
        targets = rows.map(r => r.client_name).filter(Boolean);
      } catch (_) {}
    }
    if (!targets || targets.length === 0) {
      targets = loadRegisteredClientsFromDisk();
    }
  }

  // 1. Oracle refresh
  const oracle = getOracleModule();
  if (oracle) {
    try {
      await oracle.refreshMasterClients(targets);
    } catch (err) {
      console.warn('[Oracle Master Refresh Warn]:', err.message);
    }
  }

  // 2. SQLite refresh
  const db = getSqliteDb();
  if (db) {
    const now = new Date().toISOString();
    try {
      for (const rawClient of targets) {
        const client = rawClient.toLowerCase().trim();
        const existingMaster = db.prepare('SELECT * FROM SA_DEPLOYMENT_TRACKER WHERE LOWER(client_name) = ?').get(client);

        const latestF = db.prepare(`
          SELECT frontend_version, deployed_by, event_time, run_id, status 
          FROM SA_DEPLOYMENT_TRACKER_DTL 
          WHERE LOWER(client_name) = ? AND event_stack = 'F' 
            AND run_id NOT LIKE 'init_%'
            AND event_time NOT LIKE '2026-11-10T04:22%'
          ORDER BY event_time DESC, deployment_tracker_dtl_no DESC LIMIT 1
        `).get(client);

        const latestB = db.prepare(`
          SELECT backend_version, deployed_by, event_time, run_id, status 
          FROM SA_DEPLOYMENT_TRACKER_DTL 
          WHERE LOWER(client_name) = ? AND event_stack = 'B' 
            AND run_id NOT LIKE 'init_%'
            AND event_time NOT LIKE '2026-11-10T04:22%'
          ORDER BY event_time DESC, deployment_tracker_dtl_no DESC LIMIT 1
        `).get(client);

        const fVer = (latestF && latestF.frontend_version && latestF.frontend_version !== 'unknown')
          ? latestF.frontend_version
          : (existingMaster?.frontend_version || 'unknown');

        const bVer = (latestB && latestB.backend_version && latestB.backend_version !== 'unknown')
          ? latestB.backend_version
          : (existingMaster?.backend_version || 'unknown');

        const fAt = (latestF && latestF.event_time)
          ? latestF.event_time
          : (existingMaster?.frontend_deployed_at || null);

        const bAt = (latestB && latestB.event_time)
          ? latestB.event_time
          : (existingMaster?.backend_deployed_at || null);

        const fRun = (latestF && latestF.run_id)
          ? latestF.run_id
          : (existingMaster?.frontend_run_id || null);

        const bRun = (latestB && latestB.run_id)
          ? latestB.run_id
          : (existingMaster?.backend_run_id || null);

        const actor = (latestF?.deployed_by && latestF.deployed_by !== 'system')
          ? latestF.deployed_by
          : ((latestB?.deployed_by && latestB.deployed_by !== 'system')
            ? latestB.deployed_by
            : (existingMaster?.deployed_by || 'system'));

        let status = 'pending_first_deploy';
        if ((latestF && latestF.status === 'success') || (latestB && latestB.status === 'success') || existingMaster?.status === 'success') {
          status = 'success';
        } else if (latestF?.status || latestB?.status) {
          status = latestF?.status || latestB?.status;
        } else if (existingMaster?.status) {
          status = existingMaster.status;
        }

        db.prepare(`
          INSERT INTO SA_DEPLOYMENT_TRACKER (
            client_name, frontend_version, backend_version, status, deployed_by,
            frontend_deployed_at, backend_deployed_at, frontend_run_id, backend_run_id,
            is_deployable_to_client, synced_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
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
        `).run(client, fVer, bVer, status, actor, fAt, bAt, fRun, bRun, now, now);

        const mem = inMemoryStore.get(client);
        if (mem) {
          mem.frontend_version = fVer;
          mem.backend_version = bVer;
          mem.status = status;
          mem.frontend_deployed_at = fAt;
          mem.backend_deployed_at = bAt;
          mem.synced_at = now;
        }
      }
    } catch (err) {
      console.warn('[SQLite Master Refresh Warn]:', err.message);
    }
  }
}

/**
 * Fetch incremental workflow runs from GitHub Actions (ONLY runs NOT in DB or non-terminal)
 */
async function fetchIncrementalWorkflowRuns({ repo, stack, token, knownRunsMap }) {
  const headers = {
    'User-Agent': 'Pridebook-DB-Sync',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) headers['Authorization'] = `token ${token.trim()}`;

  const runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/release-deploy.yml/runs?per_page=12`;
  const res = await fetch(runsUrl, { headers });
  if (!res.ok) return [];

  const data = await res.json();
  const runs = data.workflow_runs || [];
  const events = [];

  for (const run of runs) {
    const runIdStr = String(run.id);
    const knownStatus = knownRunsMap.get(runIdStr);

    // Standard Incremental Rule: If run is already recorded with terminal status, SKIP!
    if (knownStatus && isTerminalStatus(knownStatus)) {
      continue;
    }

    // Run is either brand new (not in DB) or needs status update from pending
    let jobs = workflowJobsCache.get(run.id);
    if (!jobs) {
      try {
        const jobsRes = await fetch(run.jobs_url, { headers });
        if (jobsRes.ok) {
          const jobsData = await jobsRes.json();
          jobs = jobsData.jobs || [];
          if (run.status === 'completed') {
            workflowJobsCache.set(run.id, jobs);
          }
        }
      } catch (_) {}
    }

    for (const job of (jobs || [])) {
      const match = job.name.match(/(?:Deploy|Validate release)\s+(v[0-9.]+)\s+(?:to|for)\s+([a-zA-Z0-9_-]+)/i);
      if (match && job.name.startsWith('Deploy')) {
        const client = match[2].toLowerCase().trim();
        let status = 'pending';
        if (run.conclusion === 'success' || job.conclusion === 'success') status = 'success';
        else if (run.conclusion === 'cancelled' || job.conclusion === 'cancelled') status = 'cancelled';
        else if (run.conclusion === 'failure' || job.conclusion === 'failure') status = 'failed';
        else if (run.status === 'in_progress') status = 'in_progress';
        else if (run.status === 'queued') status = 'queued';

        let fVer = stack === 'F' ? match[1] : 'unknown';
        let bVer = stack === 'B' ? match[1] : 'unknown';

        const curDb = getSqliteDb();
        if (curDb) {
          try {
            const m = curDb.prepare('SELECT frontend_version, backend_version FROM SA_DEPLOYMENT_TRACKER WHERE LOWER(client_name) = ?').get(client);
            if (m) {
              if (stack !== 'F' && m.frontend_version && m.frontend_version !== 'unknown') fVer = m.frontend_version;
              if (stack !== 'B' && m.backend_version && m.backend_version !== 'unknown') bVer = m.backend_version;
            }
          } catch (_) {}
        }

        events.push({
          client_name: client,
          event_stack: stack,
          frontend_version: fVer,
          backend_version: bVer,
          status,
          deployed_by: run.actor?.login || 'system',
          frontend_deployed_at: stack === 'F' ? (job.completed_at || run.created_at) : null,
          backend_deployed_at: stack === 'B' ? (job.completed_at || run.created_at) : null,
          run_id: runIdStr,
          event_time: job.completed_at || run.created_at,
          is_deployable_to_client: 0,
          isNew: !knownRunsMap.has(runIdStr)
        });
      }
    }
  }

  return events;
}

/**
 * Fetch all historical workflow runs and parse jobs during initial database bootstrap
 */
async function fetchAllHistoricalWorkflowRuns({ repo, stack, token }) {
  const headers = {
    'User-Agent': 'Pridebook-DB-Bootstrap',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) headers['Authorization'] = `token ${token.trim()}`;

  const runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/release-deploy.yml/runs?per_page=100`;
  const res = await fetch(runsUrl, { headers });
  if (!res.ok) return [];

  const data = await res.json();
  const runs = data.workflow_runs || [];
  const events = [];

  // Inspect jobs in batches of 5
  for (let i = 0; i < runs.length; i += 5) {
    const batch = runs.slice(i, i + 5);
    await Promise.all(batch.map(async run => {
      let jobs = workflowJobsCache.get(run.id);
      if (!jobs) {
        try {
          const jobsRes = await fetch(run.jobs_url, { headers });
          if (jobsRes.ok) {
            const jobsData = await jobsRes.json();
            jobs = jobsData.jobs || [];
            if (run.status === 'completed') {
              workflowJobsCache.set(run.id, jobs);
            }
          }
        } catch (_) {}
      }

      for (const job of (jobs || [])) {
        const match = job.name.match(/(?:Deploy|Validate release)\s+(v[0-9.]+)\s+(?:to|for)\s+([a-zA-Z0-9_-]+)/i);
        if (match && job.name.startsWith('Deploy')) {
          const client = match[2].toLowerCase().trim();
          let status = 'pending';
          if (run.conclusion === 'success' || job.conclusion === 'success') status = 'success';
          else if (run.conclusion === 'cancelled' || job.conclusion === 'cancelled') status = 'cancelled';
          else if (run.conclusion === 'failure' || job.conclusion === 'failure') status = 'failed';
          else if (run.status === 'in_progress') status = 'in_progress';
          else if (run.status === 'queued') status = 'queued';

          events.push({
            client_name: client,
            event_stack: stack,
            version: match[1],
            status,
            deployed_by: run.actor?.login || 'system',
            event_time: job.completed_at || run.created_at,
            run_id: String(run.id)
          });
        }
      }
    }));
  }

  return events;
}

/**
 * Bootstrap initial database if detail table is completely empty
 */
async function bootstrapInitialDatabase(token) {
  const repoF = process.env.GITHUB_FRONTEND_REPO || process.env.GITHUB_REPO || 'pride-erp-local/pride-erp-frontend';
  const repoB = process.env.GITHUB_BACKEND_REPO || (process.env.GITHUB_REPO ? process.env.GITHUB_REPO.replace(/-frontend$/, '-backend') : '') || 'pride-erp-local/pride-erp-backend';

  const [fEvents, bEvents] = await Promise.all([
    fetchAllHistoricalWorkflowRuns({ repo: repoF, stack: 'F', token }),
    fetchAllHistoricalWorkflowRuns({ repo: repoB, stack: 'B', token })
  ]);

  const allEvents = [...fEvents, ...bEvents].sort((a, b) => new Date(a.event_time) - new Date(b.event_time));
  console.log(`[DB Bootstrap] Discovered ${allEvents.length} deployment events across GitHub Actions history.`);

  if (allEvents.length > 0) {
    const db = getSqliteDb();
    if (db) {
      const nowIso = new Date().toISOString();
      for (const ev of allEvents) {
        let trackerNo = await upsertDeployment({
          client_name: ev.client_name,
          frontend_version: ev.event_stack === 'F' ? ev.version : 'unknown',
          backend_version: ev.event_stack === 'B' ? ev.version : 'unknown',
          status: ev.status
        });
        try {
          db.prepare(`
            INSERT INTO SA_DEPLOYMENT_TRACKER_DTL (
              deployment_tracker_no, client_name, event_stack, frontend_version,
              backend_version, status, deployed_by, frontend_deployed_at,
              backend_deployed_at, run_id, event_time, is_deployable_to_client, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT DO NOTHING
          `).run(
            trackerNo,
            ev.client_name,
            ev.event_stack,
            ev.event_stack === 'F' ? ev.version : 'unknown',
            ev.event_stack === 'B' ? ev.version : 'unknown',
            ev.status,
            ev.deployed_by,
            ev.event_stack === 'F' ? ev.event_time : null,
            ev.event_stack === 'B' ? ev.event_time : null,
            ev.run_id,
            ev.event_time,
            nowIso
          );
        } catch (_) {}
      }
    }

    const oracle = getOracleModule();
    if (oracle) {
      try {
        await oracle.syncHistoryEvents(allEvents);
      } catch (_) {}
    }

    await refreshMasterClientsFromDtl();
  }
}

/**
 * Standard Incremental DB Sync:
 * - Checks GitHub for only new runs not yet in DB, or runs with pending status.
 * - Does NOT scan entire historical runs or hit rate limits.
 * - ALWAYS returns data directly from the Database.
 */
async function getDeploymentsWithSync(options = {}) {
  const token = options.token || process.env.GITHUB_TOKEN || '';
  const forceSync = options.forceSync === true;
  const now = Date.now();

  // Rate-limit automated checks to at most once every 10 seconds unless forced
  const shouldCheckGitHub = forceSync || (now - lastSyncCheckTime > 10000);

  if (shouldCheckGitHub) {
    lastSyncCheckTime = now;
    try {
      const knownRunsMap = await getKnownRunsMap();

      if (knownRunsMap.size === 0) {
        console.log('[DB Sync] Blank DB detected. Bootstrapping initial records from GitHub...');
        await bootstrapInitialDatabase(token);
      } else {
        const repoF = process.env.GITHUB_FRONTEND_REPO || process.env.GITHUB_REPO || 'pride-erp-local/pride-erp-frontend';
        const repoB = process.env.GITHUB_BACKEND_REPO || (process.env.GITHUB_REPO ? process.env.GITHUB_REPO.replace(/-frontend$/, '-backend') : '') || 'pride-erp-local/pride-erp-backend';

        // Incremental: Only fetch runs not in DB or non-terminal
        const [fNew, bNew] = await Promise.all([
          fetchIncrementalWorkflowRuns({ repo: repoF, stack: 'F', token, knownRunsMap }),
          fetchIncrementalWorkflowRuns({ repo: repoB, stack: 'B', token, knownRunsMap })
        ]);

        const newEvents = [...fNew, ...bNew];

        if (newEvents.length > 0) {
          console.log(`[DB Incremental Sync] Processing ${newEvents.length} new or updated run(s) from GitHub...`);

          // 1. Sync Oracle detail table if active
          const oracle = getOracleModule();
          if (oracle) {
            try {
              await oracle.syncHistoryEvents(newEvents);
            } catch (e) {
              console.warn('[Oracle Incremental Sync Warn]:', e.message);
            }
          }

          // 2. Sync SQLite detail table
          const db = getSqliteDb();
          if (db) {
            try {
              const masterRows = db.prepare('SELECT deployment_tracker_no, LOWER(client_name) AS name FROM SA_DEPLOYMENT_TRACKER').all();
              const clientTrackerMap = {};
              for (const r of masterRows) clientTrackerMap[r.name] = r.deployment_tracker_no;

              const insertDtlStmt = db.prepare(`
                INSERT OR IGNORE INTO SA_DEPLOYMENT_TRACKER_DTL (
                  deployment_tracker_no, client_name, event_stack, frontend_version,
                  backend_version, status, deployed_by, frontend_deployed_at,
                  backend_deployed_at, run_id, event_time, is_deployable_to_client, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
              `);

              const updateDtlStmt = db.prepare(`
                UPDATE SA_DEPLOYMENT_TRACKER_DTL 
                SET status = ?, 
                    frontend_version = CASE WHEN ? != 'unknown' THEN ? ELSE frontend_version END,
                    backend_version = CASE WHEN ? != 'unknown' THEN ? ELSE backend_version END,
                    deployed_by = ?
                WHERE run_id = ?
              `);

              for (const ev of newEvents) {
                const client = ev.client_name.toLowerCase();
                let trackerNo = clientTrackerMap[client];
                if (!trackerNo) {
                  trackerNo = await upsertDeployment({
                    client_name: client,
                    frontend_version: ev.event_stack === 'F' ? ev.frontend_version : 'unknown',
                    backend_version: ev.event_stack === 'B' ? ev.backend_version : 'unknown',
                    status: ev.status
                  });
                  clientTrackerMap[client] = trackerNo;
                }

                if (ev.isNew) {
                  const exists = db.prepare('SELECT deployment_tracker_dtl_no FROM SA_DEPLOYMENT_TRACKER_DTL WHERE client_name = ? AND event_stack = ? AND run_id = ?').get(ev.client_name, ev.event_stack, ev.run_id);
                  if (!exists) {
                    insertDtlStmt.run(
                      trackerNo,
                      ev.client_name,
                      ev.event_stack,
                      ev.frontend_version,
                      ev.backend_version,
                      ev.status,
                      ev.deployed_by,
                      ev.frontend_deployed_at,
                      ev.backend_deployed_at,
                      ev.run_id,
                      ev.event_time,
                      new Date().toISOString()
                    );
                  }
                } else {
                  updateDtlStmt.run(ev.status, ev.frontend_version, ev.frontend_version, ev.backend_version, ev.backend_version, ev.deployed_by || 'system', ev.run_id);
                }
              }
            } catch (sqliteErr) {
              console.warn('[SQLite Incremental Sync Warn]:', sqliteErr.message);
            }
          }

          // Update master table for any affected clients
          const affectedClients = Array.from(new Set(newEvents.map(e => e.client_name.toLowerCase())));
          await refreshMasterClientsFromDtl(affectedClients);
        }
      }
    } catch (err) {
      console.warn('[DB Incremental Sync Warn]:', err.message);
    }
  }

  // Ensure master table is populated if it ever lost sync
  const currentMaster = await getAllDeployments();
  const needsMasterRefresh = currentMaster.some(m => m.client_name !== 'stage' && (m.frontend_version === 'unknown' || m.status === 'pending_first_deploy'));
  if (needsMasterRefresh) {
    await refreshMasterClientsFromDtl();
  }

  // 4. ALWAYS return data directly from the Database!
  const finalDeployments = await getAllDeployments();
  const finalHistory = await getDeploymentHistory();

  return {
    success: true,
    db_type: getActiveDbType(),
    source: 'database',
    count: finalDeployments.length,
    deployable_count: finalDeployments.filter(c => c.is_deployable_to_client === 0).length,
    issue_count: finalDeployments.filter(c => c.is_deployable_to_client === 1).length,
    data: finalDeployments,
    history: finalHistory || [],
    synced_at: new Date().toISOString()
  };
}

/**
 * Legacy compatibility wrapper for explicit sync triggers
 */
async function syncDatabaseFromGitHub(token) {
  return await getDeploymentsWithSync({ token, forceSync: true });
}

function getActiveDbType() {
  if (isOracleConfigured()) {
    return isOracleFailed ? 'SQLite (Failover)' : 'Oracle (19c)';
  }
  return 'SQLite';
}

module.exports = {
  getAllDeployments,
  getDeploymentHistory,
  getKnownRunsMap,
  updateHistoryStatus,
  refreshMasterClientsFromDtl,
  updateDeployableFlag,
  updateHistoryDeployableFlag,
  upsertDeployment,
  getDeploymentsWithSync,
  syncDatabaseFromGitHub,
  getActiveDbType,
  get DB_PATH() {
    return activeDbPath;
  },
  resolveDbPath
};
