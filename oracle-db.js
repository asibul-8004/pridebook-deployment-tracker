/**
 * Pridebook Version Tracker - Oracle Database Adapter
 * Location: /home/asibul/Pridebook/deployment-tracker/oracle-db.js
 * 
 * Uses Oracle table: SA_DEPLOYMENT_TRACKER
 * Primary Key: DEPLOYMENT_TRACKER_NO
 * NOTE: The application does NOT execute any DDL / CREATE TABLE statements.
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

// Configure Oracle driver defaults
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;

const TABLE_NAME = process.env.ORACLE_TABLE_NAME || 'SA_DEPLOYMENT_TRACKER';

let pool = null;

function getConnectString() {
  const host = process.env.ORACLE_HOST || '127.0.0.1';
  const port = process.env.ORACLE_PORT || '1521';
  const serviceName = process.env.ORACLE_SERVICE_NAME || 'pridedev19c';
  return `${host}:${port}/${serviceName}`;
}

async function getPool() {
  if (!pool) {
    const user = process.env.ORACLE_USER || 'bms';
    const password = process.env.ORACLE_PASSWORD || 'bms';
    const connectString = getConnectString();

    pool = await oracledb.createPool({
      user,
      password,
      connectString,
      poolMin: 1,
      poolMax: 10,
      poolIncrement: 1,
      poolTimeout: 60
    });
  }
  return pool;
}

async function getConnection() {
  const p = await getPool();
  return await p.getConnection();
}

/**
 * Fetch next sequence value or calculate MAX(DEPLOYMENT_TRACKER_NO) + 1
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
 * Get all deployments from Oracle table SA_DEPLOYMENT_TRACKER
 */
async function getAllDeployments(filters = {}) {
  const conn = await getConnection();
  try {
    let sql = `
      SELECT 
        DEPLOYMENT_TRACKER_NO AS "id",
        DEPLOYMENT_TRACKER_NO AS "deployment_tracker_no",
        CLIENT_NAME AS "client_name",
        STACK AS "stack",
        VERSION AS "version",
        STATUS AS "status",
        DEPLOYED_BY AS "deployed_by",
        LAST_DEPLOYED_AT AS "last_deployed_at",
        RUN_ID AS "run_id",
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

    if (filters.stack && (filters.stack === 'F' || filters.stack === 'B')) {
      sql += ` AND STACK = :stack`;
      binds.stack = filters.stack;
    }

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
      CLIENT_NAME ASC,
      STACK ASC`;

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
 * Upsert deployment record into Oracle table SA_DEPLOYMENT_TRACKER
 * Preserves IS_DEPLOYABLE_TO_CLIENT on existing rows
 */
async function upsertDeployment(record) {
  const conn = await getConnection();
  const client_name = String(record.client_name).toLowerCase().trim();
  const stack = String(record.stack).toUpperCase().trim();
  const now = new Date().toISOString();

  try {
    const nextNo = await getNextTrackerNo(conn);

    const mergeSql = `
      MERGE INTO ${TABLE_NAME} cd
      USING (SELECT :client_name AS client_name, :stack AS stack FROM dual) src
      ON (LOWER(cd.CLIENT_NAME) = LOWER(src.client_name) AND cd.STACK = src.stack)
      WHEN MATCHED THEN
        UPDATE SET
          cd.VERSION = :version,
          cd.STATUS = :status,
          cd.DEPLOYED_BY = :deployed_by,
          cd.LAST_DEPLOYED_AT = :last_deployed_at,
          cd.RUN_ID = :run_id,
          cd.SYNCED_AT = :synced_at,
          cd.UPDATED_AT = :updated_at,
          cd.SS_MODIFIED_ON = :synced_at
      WHEN NOT MATCHED THEN
        INSERT (
          DEPLOYMENT_TRACKER_NO, CLIENT_NAME, STACK, VERSION, STATUS, DEPLOYED_BY,
          LAST_DEPLOYED_AT, RUN_ID, IS_DEPLOYABLE_TO_CLIENT, SYNCED_AT, UPDATED_AT,
          SS_CREATED_ON, SS_MODIFIED_ON, SS_IS_DELETED, SS_IS_UPLOADED
        )
        VALUES (
          :deployment_tracker_no, :client_name, :stack, :version, :status, :deployed_by,
          :last_deployed_at, :run_id, 0, :synced_at, :updated_at,
          :synced_at, :synced_at, 0, 0
        )
    `;

    await conn.execute(mergeSql, {
      deployment_tracker_no: nextNo,
      client_name,
      stack,
      version: record.version || 'unknown',
      status: record.status || 'pending_first_deploy',
      deployed_by: record.deployed_by || 'system',
      last_deployed_at: record.last_deployed_at || null,
      run_id: record.run_id ? String(record.run_id) : null,
      synced_at: now,
      updated_at: now
    });
  } catch (err) {
    if (err.message && err.message.includes('ORA-00942')) {
      console.warn(`[Oracle Notice] Table ${TABLE_NAME} does not exist yet. Please run the table creation DDL script.`);
      return;
    }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Update the IS_DEPLOYABLE_TO_CLIENT flag (0 = Deployable, 1 = Has Issue)
 */
async function updateDeployableFlag(idOrClient, stackOrValue, maybeValue) {
  const conn = await getConnection();
  const now = new Date().toISOString();

  try {
    if (maybeValue !== undefined) {
      const client_name = String(idOrClient).toLowerCase().trim();
      const stack = String(stackOrValue).toUpperCase().trim();
      const flagVal = parseInt(maybeValue, 10) === 1 ? 1 : 0;

      await conn.execute(
        `UPDATE ${TABLE_NAME} 
         SET IS_DEPLOYABLE_TO_CLIENT = :flagVal, UPDATED_AT = :now, SS_MODIFIED_ON = :now
         WHERE LOWER(CLIENT_NAME) = LOWER(:client_name) AND STACK = :stack`,
        { flagVal, now, client_name, stack }
      );

      const res = await conn.execute(
        `SELECT 
           DEPLOYMENT_TRACKER_NO AS "id", 
           DEPLOYMENT_TRACKER_NO AS "deployment_tracker_no",
           CLIENT_NAME AS "client_name", STACK AS "stack", 
           VERSION AS "version", STATUS AS "status", DEPLOYED_BY AS "deployed_by", 
           LAST_DEPLOYED_AT AS "last_deployed_at", RUN_ID AS "run_id", 
           IS_DEPLOYABLE_TO_CLIENT AS "is_deployable_to_client", 
           SYNCED_AT AS "synced_at", UPDATED_AT AS "updated_at"
         FROM ${TABLE_NAME} 
         WHERE LOWER(CLIENT_NAME) = LOWER(:client_name) AND STACK = :stack`,
        { client_name, stack }
      );
      return res.rows[0];
    } else {
      const id = parseInt(idOrClient, 10);
      const flagVal = parseInt(stackOrValue, 10) === 1 ? 1 : 0;

      await conn.execute(
        `UPDATE ${TABLE_NAME} 
         SET IS_DEPLOYABLE_TO_CLIENT = :flagVal, UPDATED_AT = :now, SS_MODIFIED_ON = :now
         WHERE DEPLOYMENT_TRACKER_NO = :id`,
        { flagVal, now, id }
      );

      const res = await conn.execute(
        `SELECT 
           DEPLOYMENT_TRACKER_NO AS "id", 
           DEPLOYMENT_TRACKER_NO AS "deployment_tracker_no",
           CLIENT_NAME AS "client_name", STACK AS "stack", 
           VERSION AS "version", STATUS AS "status", DEPLOYED_BY AS "deployed_by", 
           LAST_DEPLOYED_AT AS "last_deployed_at", RUN_ID AS "run_id", 
           IS_DEPLOYABLE_TO_CLIENT AS "is_deployable_to_client", 
           SYNCED_AT AS "synced_at", UPDATED_AT AS "updated_at"
         FROM ${TABLE_NAME} 
         WHERE DEPLOYMENT_TRACKER_NO = :id`,
        { id }
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
  upsertDeployment,
  updateDeployableFlag,
  closePool,
  getConnectString,
  TABLE_NAME
};
