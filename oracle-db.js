/**
 * Pridebook Version Tracker - Oracle Database Adapter
 * Location: /home/asibul/Pridebook/deployment-tracker/oracle-db.js
 * 
 * Tables:
 * - Master: SA_DEPLOYMENT_TRACKER (Stores merged latest deployment status per client box)
 * - Detail: SA_DEPLOYMENT_TRACKER_DTL (Stores chronological release history progression)
 * 
 * Primary Keys:
 * - Master: DEPLOYMENT_TRACKER_NO
 * - Detail: DEPLOYMENT_TRACKER_DTL_NO (Foreign Key: DEPLOYMENT_TRACKER_NO)
 * 
 * NOTE: The application does NOT execute any DDL / CREATE TABLE statements on Oracle.
 * Table creation is managed separately via DBA / manual scripts.
 * 
 * Credentials read securely from process.env (.env):
 * - ORACLE_HOST
 * - ORACLE_PORT
 * - ORACLE_SERVICE_NAME
 * - ORACLE_USER
 * - ORACLE_PASSWORD
 */

const oracledb = require('oracledb');
const fs = require('fs');
const path = require('path');

// Ensure .env is loaded if running in standalone script or worker
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
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
    } catch (e) {}
  }
}
loadEnv();

// Configure Oracle driver defaults
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;

const TABLE_NAME = process.env.ORACLE_TABLE_NAME || 'SA_DEPLOYMENT_TRACKER';
const DTL_TABLE_NAME = process.env.ORACLE_DTL_TABLE_NAME || 'SA_DEPLOYMENT_TRACKER_DTL';

let pool = null;

function getConnectString() {
  const host = process.env.ORACLE_HOST;
  const port = process.env.ORACLE_PORT;
  const serviceName = process.env.ORACLE_SERVICE_NAME;
  if (!host || !port || !serviceName) {
    throw new Error('Oracle configuration missing in .env (ORACLE_HOST, ORACLE_PORT, ORACLE_SERVICE_NAME required)');
  }
  return `${host}:${port}/${serviceName}`;
}

async function getPool() {
  if (!pool) {
    const user = process.env.ORACLE_USER;
    const password = process.env.ORACLE_PASSWORD;
    if (!user || !password) {
      throw new Error('Oracle credentials missing in .env (ORACLE_USER, ORACLE_PASSWORD required)');
    }
    const connectString = getConnectString();

    pool = await oracledb.createPool({
      user,
      password,
      connectString,
      poolMin: 1,
      poolMax: 10,
      poolIncrement: 1,
      poolTimeout: 10,
      connectTimeout: 4
    });
  }
  return pool;
}

async function getConnection() {
  const timeoutMs = 4000;
  return await Promise.race([
    (async () => {
      const p = await getPool();
      return await p.getConnection();
    })(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Oracle connection timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

/**
 * Fetch next sequence value or calculate MAX(DEPLOYMENT_TRACKER_NO) + 1 for Master Table
 */
async function getNextTrackerNo(conn) {
  try {
    const resSeq = await conn.execute(`SELECT S_SA_DEPLOYMENT_TRACKER.NEXTVAL AS "next_no" FROM dual`);
    if (resSeq.rows && resSeq.rows[0]) {
      return resSeq.rows[0].next_no || resSeq.rows[0].NEXT_NO;
    }
  } catch (err) {
    // Sequence not present, fallback to max + 1
  }
  try {
    const resMax = await conn.execute(`SELECT NVL(MAX(DEPLOYMENT_TRACKER_NO), 0) + 1 AS "next_no" FROM ${TABLE_NAME}`);
    if (resMax.rows && resMax.rows[0]) {
      return resMax.rows[0].next_no || resMax.rows[0].NEXT_NO;
    }
  } catch (err) {
    // In case table does not exist yet
  }
  return 1;
}

/**
 * Fetch next sequence value or calculate MAX(DEPLOYMENT_TRACKER_DTL_NO) + 1 for Detail Table
 */
async function getNextTrackerDtlNo(conn) {
  try {
    const resSeq = await conn.execute(`SELECT S_SA_DEPLOYMENT_TRACKER_DTL.NEXTVAL AS "next_no" FROM dual`);
    if (resSeq.rows && resSeq.rows[0]) {
      return resSeq.rows[0].next_no || resSeq.rows[0].NEXT_NO;
    }
  } catch (err) {
    // Sequence not present, fallback to max + 1
  }
  try {
    const resMax = await conn.execute(`SELECT NVL(MAX(DEPLOYMENT_TRACKER_DTL_NO), 0) + 1 AS "next_no" FROM ${DTL_TABLE_NAME}`);
    if (resMax.rows && resMax.rows[0]) {
      return resMax.rows[0].next_no || resMax.rows[0].NEXT_NO;
    }
  } catch (err) {
    // In case table does not exist yet
  }
  return 1;
}

/**
 * Get all merged client deployments from Oracle table SA_DEPLOYMENT_TRACKER
 */
async function getAllDeployments(filters = {}) {
  const conn = await getConnection();
  try {
    let sql = `
      SELECT 
        DEPLOYMENT_TRACKER_NO AS "id",
        DEPLOYMENT_TRACKER_NO AS "deployment_tracker_no",
        CLIENT_NAME AS "client_name",
        FRONTEND_VERSION AS "frontend_version",
        BACKEND_VERSION AS "backend_version",
        STATUS AS "status",
        DEPLOYED_BY AS "deployed_by",
        FRONTEND_DEPLOYED_AT AS "frontend_deployed_at",
        BACKEND_DEPLOYED_AT AS "backend_deployed_at",
        FRONTEND_RUN_ID AS "frontend_run_id",
        BACKEND_RUN_ID AS "backend_run_id",
        IS_DEPLOYABLE_TO_CLIENT AS "is_deployable_to_client",
        ISSUE_NOTES AS "issue_notes",
        SYNCED_AT AS "synced_at",
        UPDATED_AT AS "updated_at",
        SS_CREATOR AS "ss_creator",
        SS_CREATED_ON AS "ss_created_on",
        SS_MODIFIER AS "ss_modifier",
        SS_MODIFIED_ON AS "ss_modified_on",
        COMPANY_NO AS "company_no",
        SS_OG_NO AS "ss_og_no",
        SS_UPLOADED_ON AS "ss_uploaded_on",
        SS_IS_DELETED AS "ss_is_deleted",
        SS_IS_UPLOADED AS "ss_is_uploaded"
      FROM ${TABLE_NAME}
      WHERE 1=1
    `;
    const binds = {};

    if (filters.client_name) {
      sql += ` AND LOWER(CLIENT_NAME) = LOWER(:client_name)`;
      binds.client_name = filters.client_name;
    }

    if (filters.is_deployable !== undefined && filters.is_deployable !== null) {
      sql += ` AND IS_DEPLOYABLE_TO_CLIENT = :is_deployable`;
      binds.is_deployable = parseInt(filters.is_deployable, 10);
    }

    sql += ` ORDER BY 
      CASE WHEN LOWER(CLIENT_NAME) = 'stage' THEN 0 ELSE 1 END,
      CLIENT_NAME ASC`;

    const result = await conn.execute(sql, binds);
    return result.rows || [];
  } catch (err) {
    if (err.message && err.message.includes('ORA-00942')) {
      console.warn(`[Oracle Notice] Table ${TABLE_NAME} does not exist yet. Please run the table creation DDL script.`);
      return [];
    }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Get deployment history from child table SA_DEPLOYMENT_TRACKER_DTL
 */
async function getDeploymentHistory(clientFilter) {
  const conn = await getConnection();
  try {
    let sql = `
      SELECT 
        dtl.DEPLOYMENT_TRACKER_DTL_NO AS "id",
        dtl.DEPLOYMENT_TRACKER_DTL_NO AS "deployment_tracker_dtl_no",
        dtl.DEPLOYMENT_TRACKER_NO AS "deployment_tracker_no",
        dtl.CLIENT_NAME AS "client_name",
        dtl.EVENT_STACK AS "event_stack",
        dtl.FRONTEND_VERSION AS "frontend_version",
        dtl.BACKEND_VERSION AS "backend_version",
        dtl.STATUS AS "status",
        dtl.DEPLOYED_BY AS "deployed_by",
        dtl.FRONTEND_DEPLOYED_AT AS "frontend_deployed_at",
        dtl.BACKEND_DEPLOYED_AT AS "backend_deployed_at",
        dtl.RUN_ID AS "run_id",
        dtl.EVENT_TIME AS "event_time",
        NVL(dtl.IS_DEPLOYABLE_TO_CLIENT, NVL(m.IS_DEPLOYABLE_TO_CLIENT, 0)) AS "is_deployable_to_client"
      FROM ${DTL_TABLE_NAME} dtl
      LEFT JOIN ${TABLE_NAME} m ON dtl.DEPLOYMENT_TRACKER_NO = m.DEPLOYMENT_TRACKER_NO
      WHERE 1=1
    `;
    const binds = {};
    if (clientFilter && clientFilter !== 'all') {
      sql += ` AND LOWER(dtl.CLIENT_NAME) = LOWER(:clientFilter)`;
      binds.clientFilter = clientFilter;
    }
    sql += ` ORDER BY dtl.EVENT_TIME DESC, dtl.DEPLOYMENT_TRACKER_DTL_NO DESC`;

    const result = await conn.execute(sql, binds);
    return result.rows || [];
  } catch (err) {
    if (err.message && err.message.includes('ORA-00942')) {
      // Table SA_DEPLOYMENT_TRACKER_DTL does not exist yet
      return null;
    }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Upsert merged client deployment record into Oracle table SA_DEPLOYMENT_TRACKER.
 * If new client onboards, automatically inserts into SA_DEPLOYMENT_TRACKER.
 * Returns the DEPLOYMENT_TRACKER_NO.
 */
async function upsertDeployment(record) {
  const conn = await getConnection();
  const client_name = String(record.client_name).toLowerCase().trim();
  const now = new Date().toISOString();

  try {
    const checkRes = await conn.execute(
      `SELECT DEPLOYMENT_TRACKER_NO AS "tracker_no" FROM ${TABLE_NAME} WHERE LOWER(CLIENT_NAME) = LOWER(:client_name)`,
      { client_name }
    );

    let trackerNo = null;

    if (checkRes.rows && checkRes.rows.length > 0) {
      trackerNo = checkRes.rows[0].tracker_no || checkRes.rows[0].TRACKER_NO;
      await conn.execute(
        `UPDATE ${TABLE_NAME} SET
           FRONTEND_VERSION = :frontend_version,
           BACKEND_VERSION = :backend_version,
           STATUS = :status,
           DEPLOYED_BY = :deployed_by,
           FRONTEND_DEPLOYED_AT = :frontend_deployed_at,
           BACKEND_DEPLOYED_AT = :backend_deployed_at,
           FRONTEND_RUN_ID = :frontend_run_id,
           BACKEND_RUN_ID = :backend_run_id,
           SYNCED_AT = :synced_at,
           UPDATED_AT = :synced_at,
           SS_MODIFIED_ON = :synced_at
         WHERE DEPLOYMENT_TRACKER_NO = :trackerNo`,
        {
          trackerNo,
          frontend_version: record.frontend_version || 'unknown',
          backend_version: record.backend_version || 'unknown',
          status: record.status || 'pending_first_deploy',
          deployed_by: record.deployed_by || 'system',
          frontend_deployed_at: record.frontend_deployed_at || null,
          backend_deployed_at: record.backend_deployed_at || null,
          frontend_run_id: record.frontend_run_id ? String(record.frontend_run_id) : null,
          backend_run_id: record.backend_run_id ? String(record.backend_run_id) : null,
          synced_at: now
        },
        { autoCommit: true }
      );
      await conn.commit();
    } else {
      // New client onboarded! Auto-add in main table
      trackerNo = await getNextTrackerNo(conn);
      await conn.execute(
        `INSERT INTO ${TABLE_NAME} (
           DEPLOYMENT_TRACKER_NO, CLIENT_NAME, FRONTEND_VERSION, BACKEND_VERSION,
           STATUS, DEPLOYED_BY, FRONTEND_DEPLOYED_AT, BACKEND_DEPLOYED_AT,
           FRONTEND_RUN_ID, BACKEND_RUN_ID, IS_DEPLOYABLE_TO_CLIENT,
           SYNCED_AT, UPDATED_AT, SS_CREATED_ON, SS_MODIFIED_ON, SS_IS_DELETED, SS_IS_UPLOADED
         ) VALUES (
           :trackerNo, :client_name, :frontend_version, :backend_version,
           :status, :deployed_by, :frontend_deployed_at, :backend_deployed_at,
           :frontend_run_id, :backend_run_id, 0,
           :synced_at, :synced_at, :synced_at, :synced_at, 0, 0
         )`,
        {
          trackerNo,
          client_name,
          frontend_version: record.frontend_version || 'unknown',
          backend_version: record.backend_version || 'unknown',
          status: record.status || 'pending_first_deploy',
          deployed_by: record.deployed_by || 'system',
          frontend_deployed_at: record.frontend_deployed_at || null,
          backend_deployed_at: record.backend_deployed_at || null,
          frontend_run_id: record.frontend_run_id ? String(record.frontend_run_id) : null,
          backend_run_id: record.backend_run_id ? String(record.backend_run_id) : null,
          synced_at: now
        },
        { autoCommit: true }
      );
      await conn.commit();
      console.log(`[Oracle Onboard] Auto-added new client "${client_name}" into ${TABLE_NAME} (ID: ${trackerNo})`);
    }

    return trackerNo;
  } catch (err) {
    if (err.message && err.message.includes('ORA-00942')) {
      console.warn(`[Oracle Notice] Table ${TABLE_NAME} does not exist yet. Please run the table creation DDL script.`);
      return null;
    }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Synchronize history events into SA_DEPLOYMENT_TRACKER_DTL.
 * Ensures client exists in main table, then inserts history records under dtl table.
 */
async function syncHistoryEvents(historyEvents) {
  if (!historyEvents || historyEvents.length === 0) return 0;
  const conn = await getConnection();
  let inserted = 0;

  try {
    // Map existing tracker_nos
    const masterRows = await conn.execute(`SELECT DEPLOYMENT_TRACKER_NO AS "no", LOWER(CLIENT_NAME) AS "name" FROM ${TABLE_NAME}`);
    const clientTrackerMap = {};
    for (const r of (masterRows.rows || [])) {
      clientTrackerMap[r.name || r.NAME] = r.no || r.NO;
    }

    for (const ev of historyEvents) {
      const client = String(ev.client_name).toLowerCase().trim();
      let trackerNo = clientTrackerMap[client];

      if (!trackerNo) {
        // Auto-add client into main table first
        trackerNo = await getNextTrackerNo(conn);
        const now = new Date().toISOString();
        await conn.execute(
          `INSERT INTO ${TABLE_NAME} (
             DEPLOYMENT_TRACKER_NO, CLIENT_NAME, FRONTEND_VERSION, BACKEND_VERSION,
             STATUS, DEPLOYED_BY, FRONTEND_DEPLOYED_AT, BACKEND_DEPLOYED_AT,
             FRONTEND_RUN_ID, BACKEND_RUN_ID, IS_DEPLOYABLE_TO_CLIENT,
             SYNCED_AT, UPDATED_AT, SS_CREATED_ON, SS_MODIFIED_ON, SS_IS_DELETED, SS_IS_UPLOADED
           ) VALUES (
             :trackerNo, :client, :fVer, :bVer,
             :status, :deployedBy, :fAt, :bAt,
             :fRun, :bRun, 0,
             :now, :now, :now, :now, 0, 0
           )`,
          {
            trackerNo,
            client,
            fVer: ev.frontend_version || 'unknown',
            bVer: ev.backend_version || 'unknown',
            status: ev.status || 'success',
            deployedBy: ev.deployed_by || 'system',
            fAt: ev.frontend_deployed_at || null,
            bAt: ev.backend_deployed_at || null,
            fRun: ev.event_stack === 'F' ? String(ev.run_id || '') : null,
            bRun: ev.event_stack === 'B' ? String(ev.run_id || '') : null,
            now
          },
          { autoCommit: true }
        );
        await conn.commit();
        clientTrackerMap[client] = trackerNo;
        console.log(`[Oracle Onboard] Auto-added client "${client}" to ${TABLE_NAME} for history sync (ID: ${trackerNo})`);
      }

      // Check if this history entry is already in DTL
      const eventTime = ev.event_time || ev.timestamp || '';
      const eventStack = ev.event_stack || ev.stack || 'F';
      const runId = ev.run_id ? String(ev.run_id) : null;

      let checkSql = `SELECT COUNT(*) AS "cnt" FROM ${DTL_TABLE_NAME} WHERE DEPLOYMENT_TRACKER_NO = :trackerNo AND EVENT_STACK = :eventStack AND EVENT_TIME = :eventTime`;
      let binds = { trackerNo, eventStack, eventTime };

      if (runId) {
        checkSql = `SELECT COUNT(*) AS "cnt" FROM ${DTL_TABLE_NAME} WHERE DEPLOYMENT_TRACKER_NO = :trackerNo AND EVENT_STACK = :eventStack AND (RUN_ID = :runId OR EVENT_TIME = :eventTime)`;
        binds.runId = runId;
      }

      const checkRes = await conn.execute(checkSql, binds);
      const exists = (checkRes.rows && checkRes.rows[0]) ? (checkRes.rows[0].cnt || checkRes.rows[0].CNT || 0) : 0;

      if (exists === 0) {
        const dtlNo = await getNextTrackerDtlNo(conn);
        const now = new Date().toISOString();
        const isDepVal = ev.is_deployable_to_client !== undefined ? parseInt(ev.is_deployable_to_client, 10) : 0;
        await conn.execute(
          `INSERT INTO ${DTL_TABLE_NAME} (
             DEPLOYMENT_TRACKER_DTL_NO, DEPLOYMENT_TRACKER_NO, CLIENT_NAME,
             EVENT_STACK, FRONTEND_VERSION, BACKEND_VERSION, STATUS,
             DEPLOYED_BY, FRONTEND_DEPLOYED_AT, BACKEND_DEPLOYED_AT,
             RUN_ID, EVENT_TIME, IS_DEPLOYABLE_TO_CLIENT,
             SS_CREATED_ON, SS_MODIFIED_ON, SS_IS_DELETED, SS_IS_UPLOADED
           ) VALUES (
             :dtlNo, :trackerNo, :client,
             :eventStack, :fVer, :bVer, :status,
             :deployedBy, :fAt, :bAt,
             :runId, :eventTime, :isDeployable,
             :now, :now, 0, 0
           )`,
          {
            dtlNo,
            trackerNo,
            client,
            eventStack,
            fVer: ev.frontend_version || 'unknown',
            bVer: ev.backend_version || 'unknown',
            status: ev.status || 'success',
            deployedBy: ev.deployed_by || 'system',
            fAt: ev.frontend_deployed_at || null,
            bAt: ev.backend_deployed_at || null,
            runId,
            eventTime,
            isDeployable: isDepVal,
            now
          },
          { autoCommit: true }
        );
        await conn.commit();
        inserted++;
      } else {
        // Update existing row if status or version has changed
        let updateSql = `UPDATE ${DTL_TABLE_NAME} SET STATUS = :status, FRONTEND_VERSION = :fVer, BACKEND_VERSION = :bVer, DEPLOYED_BY = :deployedBy WHERE DEPLOYMENT_TRACKER_NO = :trackerNo AND EVENT_STACK = :eventStack AND STATUS != :status`;
        let updateBinds = {
          status: ev.status || 'success',
          fVer: ev.frontend_version || 'unknown',
          bVer: ev.backend_version || 'unknown',
          deployedBy: ev.deployed_by || 'system',
          trackerNo,
          eventStack
        };
        if (runId) {
          updateSql += ` AND (RUN_ID = :runId OR EVENT_TIME = :eventTime)`;
          updateBinds.runId = runId;
          updateBinds.eventTime = eventTime;
        } else {
          updateSql += ` AND EVENT_TIME = :eventTime`;
          updateBinds.eventTime = eventTime;
        }
        await conn.execute(updateSql, updateBinds, { autoCommit: true });
        await conn.commit();
      }
    }
  } catch (err) {
    if (err.message && err.message.includes('ORA-00942')) {
      // DTL table not created yet in Oracle
      return 0;
    }
    throw err;
  } finally {
    await conn.close();
  }
  return inserted;
}

/**
 * Update the IS_DEPLOYABLE_TO_CLIENT flag (0 = Deployable, 1 = Has Issue)
 */
async function updateDeployableFlag(idOrClient, flagValue) {
  const conn = await getConnection();
  const now = new Date().toISOString();
  const flagVal = parseInt(flagValue, 10) === 1 ? 1 : 0;

  try {
    const isNum = !isNaN(Number(idOrClient)) && String(idOrClient).trim() !== '';

    if (isNum) {
      const id = parseInt(idOrClient, 10);
      await conn.execute(
        `UPDATE ${TABLE_NAME} 
         SET IS_DEPLOYABLE_TO_CLIENT = :flagVal, UPDATED_AT = :now, SS_MODIFIED_ON = :now
         WHERE DEPLOYMENT_TRACKER_NO = :id`,
        { flagVal, now, id },
        { autoCommit: true }
      );
      await conn.commit();

      const res = await conn.execute(
        `SELECT 
           DEPLOYMENT_TRACKER_NO AS "id", 
           DEPLOYMENT_TRACKER_NO AS "deployment_tracker_no",
           CLIENT_NAME AS "client_name",
           FRONTEND_VERSION AS "frontend_version",
           BACKEND_VERSION AS "backend_version",
           STATUS AS "status",
           DEPLOYED_BY AS "deployed_by",
           FRONTEND_DEPLOYED_AT AS "frontend_deployed_at",
           BACKEND_DEPLOYED_AT AS "backend_deployed_at",
           FRONTEND_RUN_ID AS "frontend_run_id",
           BACKEND_RUN_ID AS "backend_run_id",
           IS_DEPLOYABLE_TO_CLIENT AS "is_deployable_to_client",
           SYNCED_AT AS "synced_at",
           UPDATED_AT AS "updated_at"
         FROM ${TABLE_NAME} 
         WHERE DEPLOYMENT_TRACKER_NO = :id`,
        { id }
      );
      return res.rows[0];
    } else {
      const client_name = String(idOrClient).toLowerCase().trim();
      await conn.execute(
        `UPDATE ${TABLE_NAME} 
         SET IS_DEPLOYABLE_TO_CLIENT = :flagVal, UPDATED_AT = :now, SS_MODIFIED_ON = :now
         WHERE LOWER(CLIENT_NAME) = LOWER(:client_name)`,
        { flagVal, now, client_name },
        { autoCommit: true }
      );
      await conn.commit();

      const res = await conn.execute(
        `SELECT 
           DEPLOYMENT_TRACKER_NO AS "id", 
           DEPLOYMENT_TRACKER_NO AS "deployment_tracker_no",
           CLIENT_NAME AS "client_name",
           FRONTEND_VERSION AS "frontend_version",
           BACKEND_VERSION AS "backend_version",
           STATUS AS "status",
           DEPLOYED_BY AS "deployed_by",
           FRONTEND_DEPLOYED_AT AS "frontend_deployed_at",
           BACKEND_DEPLOYED_AT AS "backend_deployed_at",
           FRONTEND_RUN_ID AS "frontend_run_id",
           BACKEND_RUN_ID AS "backend_run_id",
           IS_DEPLOYABLE_TO_CLIENT AS "is_deployable_to_client",
           SYNCED_AT AS "synced_at",
           UPDATED_AT AS "updated_at"
         FROM ${TABLE_NAME} 
         WHERE LOWER(CLIENT_NAME) = LOWER(:client_name)`,
        { client_name }
      );
      return res.rows[0];
    }
  } catch (err) {
    if (err.message && err.message.includes('ORA-00942')) {
      console.warn(`[Oracle Notice] Table ${TABLE_NAME} does not exist yet. Please run the table creation DDL script.`);
      return null;
    }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Update the IS_DEPLOYABLE_TO_CLIENT flag on a specific history record in SA_DEPLOYMENT_TRACKER_DTL
 */
async function updateHistoryDeployableFlag(dtlId, flagValue) {
  const conn = await getConnection();
  const now = new Date().toISOString();
  const flagVal = parseInt(flagValue, 10) === 1 ? 1 : 0;
  const id = parseInt(dtlId, 10);

  try {
    await conn.execute(
      `UPDATE ${DTL_TABLE_NAME} 
       SET IS_DEPLOYABLE_TO_CLIENT = :flagVal, SS_MODIFIED_ON = :now
       WHERE DEPLOYMENT_TRACKER_DTL_NO = :id`,
      { flagVal, now, id },
      { autoCommit: true }
    );
    await conn.commit();

    const res = await conn.execute(
      `SELECT 
         dtl.DEPLOYMENT_TRACKER_DTL_NO AS "id", 
         dtl.DEPLOYMENT_TRACKER_DTL_NO AS "deployment_tracker_dtl_no",
         dtl.DEPLOYMENT_TRACKER_NO AS "deployment_tracker_no",
         dtl.CLIENT_NAME AS "client_name",
         dtl.EVENT_STACK AS "event_stack",
         dtl.FRONTEND_VERSION AS "frontend_version",
         dtl.BACKEND_VERSION AS "backend_version",
         dtl.STATUS AS "status",
         dtl.DEPLOYED_BY AS "deployed_by",
         dtl.FRONTEND_DEPLOYED_AT AS "frontend_deployed_at",
         dtl.BACKEND_DEPLOYED_AT AS "backend_deployed_at",
         dtl.RUN_ID AS "run_id",
         dtl.EVENT_TIME AS "event_time",
         dtl.IS_DEPLOYABLE_TO_CLIENT AS "is_deployable_to_client"
       FROM ${DTL_TABLE_NAME} dtl
       WHERE dtl.DEPLOYMENT_TRACKER_DTL_NO = :id`,
      { id }
    );
    return res.rows ? res.rows[0] : null;
  } catch (err) {
    if (err.message && err.message.includes('ORA-00942')) {
      console.warn(`[Oracle Notice] Detail table ${DTL_TABLE_NAME} does not exist yet.`);
      return null;
    }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Get map of known run_id -> status from DTL table
 */
async function getKnownRunsMap() {
  const conn = await getConnection();
  try {
    const res = await conn.execute(
      `SELECT RUN_ID AS "run_id", STATUS AS "status" FROM ${DTL_TABLE_NAME} WHERE RUN_ID IS NOT NULL`
    );
    const map = new Map();
    for (const r of (res.rows || [])) {
      if (r.run_id) map.set(String(r.run_id), (r.status || '').toLowerCase());
    }
    return map;
  } catch (err) {
    if (err.message && err.message.includes('ORA-00942')) {
      return new Map();
    }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Update status of a history record by run_id
 */
async function updateHistoryStatus(runId, status) {
  if (!runId) return;
  const conn = await getConnection();
  try {
    await conn.execute(
      `UPDATE ${DTL_TABLE_NAME} SET STATUS = :status WHERE RUN_ID = :runId`,
      { status, runId: String(runId) },
      { autoCommit: true }
    );
    await conn.commit();
  } catch (err) {
    if (err.message && err.message.includes('ORA-00942')) return;
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Refresh master table client versions from latest DTL events
 */
async function refreshMasterClients(clientList) {
  if (!clientList || clientList.length === 0) return;
  const conn = await getConnection();
  const now = new Date().toISOString();
  try {
    for (const client of clientList) {
      const lower = client.toLowerCase().trim();
      const resF = await conn.execute(
        `SELECT FRONTEND_VERSION AS "fVer", DEPLOYED_BY AS "by", FRONTEND_DEPLOYED_AT AS "at", RUN_ID AS "runId", STATUS AS "status"
         FROM ${DTL_TABLE_NAME}
         WHERE LOWER(CLIENT_NAME) = :client AND EVENT_STACK = 'F'
         ORDER BY EVENT_TIME DESC FETCH FIRST 1 ROWS ONLY`,
        { client: lower }
      );
      const resB = await conn.execute(
        `SELECT BACKEND_VERSION AS "bVer", DEPLOYED_BY AS "by", BACKEND_DEPLOYED_AT AS "at", RUN_ID AS "runId", STATUS AS "status"
         FROM ${DTL_TABLE_NAME}
         WHERE LOWER(CLIENT_NAME) = :client AND EVENT_STACK = 'B'
         ORDER BY EVENT_TIME DESC FETCH FIRST 1 ROWS ONLY`,
        { client: lower }
      );

      const rowF = resF.rows && resF.rows[0];
      const rowB = resB.rows && resB.rows[0];

      if (rowF || rowB) {
        const fVer = (rowF && rowF.fVer) || 'unknown';
        const bVer = (rowB && rowB.bVer) || 'unknown';
        const fAt = (rowF && rowF.at) || null;
        const bAt = (rowB && rowB.at) || null;
        const fRun = (rowF && rowF.runId) ? String(rowF.runId) : null;
        const bRun = (rowB && rowB.runId) ? String(rowB.runId) : null;
        const by = (rowF && rowF.by) || (rowB && rowB.by) || 'system';
        const status = ((rowF && rowF.status === 'success') || (rowB && rowB.status === 'success')) ? 'success' : 'pending_first_deploy';

        await conn.execute(
          `UPDATE ${TABLE_NAME}
           SET FRONTEND_VERSION = :fVer,
               BACKEND_VERSION = :bVer,
               STATUS = :status,
               DEPLOYED_BY = :by,
               FRONTEND_DEPLOYED_AT = :fAt,
               BACKEND_DEPLOYED_AT = :bAt,
               FRONTEND_RUN_ID = :fRun,
               BACKEND_RUN_ID = :bRun,
               SYNCED_AT = :now,
               UPDATED_AT = :now,
               SS_MODIFIED_ON = :now
           WHERE LOWER(CLIENT_NAME) = :client`,
          { fVer, bVer, status, by, fAt, bAt, fRun, bRun, now, client: lower },
          { autoCommit: true }
        );
        await conn.commit();
      }
    }
  } catch (err) {
    if (err.message && err.message.includes('ORA-00942')) return;
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Close Oracle connection pool gracefully
 */
async function closePool() {
  if (pool) {
    try {
      await pool.close(10);
      pool = null;
    } catch (e) {}
  }
}

module.exports = {
  getPool,
  getConnection,
  getAllDeployments,
  getDeploymentHistory,
  getKnownRunsMap,
  updateHistoryStatus,
  refreshMasterClients,
  upsertDeployment,
  syncHistoryEvents,
  updateDeployableFlag,
  updateHistoryDeployableFlag,
  closePool,
  getConnectString,
  TABLE_NAME,
  DTL_TABLE_NAME
};
