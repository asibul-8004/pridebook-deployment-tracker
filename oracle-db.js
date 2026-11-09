/**
 * Pridebook Version Tracker - Oracle Database Adapter
 * Location: /home/asibul/Pridebook/deployment-tracker/oracle-db.js
 * 
 * Thin Mode driver (no Oracle Instant Client binaries needed).
 * Credentials loaded securely from process.env (.env):
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

let pool = null;

function getConnectString() {
  const host = process.env.ORACLE_HOST || '127.0.0.1';
  const port = process.env.ORACLE_PORT || '1521';
  const serviceName = process.env.ORACLE_SERVICE_NAME || 'XE';
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

    await initSchema();
  }
  return pool;
}

async function getConnection() {
  const p = await getPool();
  return await p.getConnection();
}

/**
 * Initialize Oracle CLIENT_DEPLOYMENTS table
 */
async function initSchema() {
  const conn = await pool.getConnection();
  try {
    // Check if table exists
    const checkTable = await conn.execute(
      `SELECT table_name FROM user_tables WHERE table_name = 'CLIENT_DEPLOYMENTS'`
    );

    if (checkTable.rows.length === 0) {
      console.log('[Oracle] Creating CLIENT_DEPLOYMENTS table...');
      await conn.execute(`
        CREATE TABLE CLIENT_DEPLOYMENTS (
          ID NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          CLIENT_NAME VARCHAR2(100) NOT NULL,
          STACK VARCHAR2(10) NOT NULL,
          VERSION VARCHAR2(100) DEFAULT 'unknown',
          STATUS VARCHAR2(50) DEFAULT 'pending_first_deploy',
          DEPLOYED_BY VARCHAR2(100) DEFAULT 'system',
          LAST_DEPLOYED_AT VARCHAR2(100),
          RUN_ID VARCHAR2(100),
          IS_DEPLOYABLE_TO_CLIENT NUMBER(1) DEFAULT 0 NOT NULL,
          ISSUE_NOTES VARCHAR2(500),
          SYNCED_AT VARCHAR2(100),
          UPDATED_AT VARCHAR2(100),
          CONSTRAINT UQ_CLIENT_DEPLOY_STACK UNIQUE (CLIENT_NAME, STACK),
          CONSTRAINT CK_DEPLOY_STACK CHECK (STACK IN ('F', 'B')),
          CONSTRAINT CK_DEPLOYABLE_FLAG CHECK (IS_DEPLOYABLE_TO_CLIENT IN (0, 1))
        )
      `);
      console.log('[Oracle] CLIENT_DEPLOYMENTS table created successfully.');
    }
  } catch (err) {
    console.error('[Oracle] Schema init error:', err.message);
  } finally {
    await conn.close();
  }
}

/**
 * Get all deployments from Oracle, sorted with stage first
 */
async function getAllDeployments(filters = {}) {
  const conn = await getConnection();
  try {
    let sql = `
      SELECT 
        ID AS "id",
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
        UPDATED_AT AS "updated_at"
      FROM CLIENT_DEPLOYMENTS
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
  } finally {
    await conn.close();
  }
}

/**
 * Upsert deployment record from GitHub sync into Oracle
 * Preserves IS_DEPLOYABLE_TO_CLIENT on existing rows
 */
async function upsertDeployment(record) {
  const conn = await getConnection();
  const client_name = String(record.client_name).toLowerCase().trim();
  const stack = String(record.stack).toUpperCase().trim();
  const now = new Date().toISOString();

  const mergeSql = `
    MERGE INTO CLIENT_DEPLOYMENTS cd
    USING (SELECT :client_name AS client_name, :stack AS stack FROM dual) src
    ON (LOWER(cd.CLIENT_NAME) = LOWER(src.client_name) AND cd.STACK = src.stack)
    WHEN MATCHED THEN
      UPDATE SET
        cd.VERSION = :version,
        cd.STATUS = :status,
        cd.DEPLOYED_BY = :deployed_by,
        cd.LAST_DEPLOYED_AT = :last_deployed_at,
        cd.RUN_ID = :run_id,
        cd.SYNCED_AT = :synced_at
    WHEN NOT MATCHED THEN
      INSERT (CLIENT_NAME, STACK, VERSION, STATUS, DEPLOYED_BY, LAST_DEPLOYED_AT, RUN_ID, IS_DEPLOYABLE_TO_CLIENT, SYNCED_AT, UPDATED_AT)
      VALUES (:client_name, :stack, :version, :status, :deployed_by, :last_deployed_at, :run_id, 0, :synced_at, :updated_at)
  `;

  try {
    await conn.execute(mergeSql, {
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
      // Called with: updateDeployableFlag(client_name, stack, flagValue)
      const client_name = String(idOrClient).toLowerCase().trim();
      const stack = String(stackOrValue).toUpperCase().trim();
      const flagVal = parseInt(maybeValue, 10) === 1 ? 1 : 0;

      await conn.execute(
        `UPDATE CLIENT_DEPLOYMENTS 
         SET IS_DEPLOYABLE_TO_CLIENT = :flagVal, UPDATED_AT = :now
         WHERE LOWER(CLIENT_NAME) = LOWER(:client_name) AND STACK = :stack`,
        { flagVal, now, client_name, stack }
      );

      const res = await conn.execute(
        `SELECT 
           ID AS "id", CLIENT_NAME AS "client_name", STACK AS "stack", 
           VERSION AS "version", STATUS AS "status", DEPLOYED_BY AS "deployed_by", 
           LAST_DEPLOYED_AT AS "last_deployed_at", RUN_ID AS "run_id", 
           IS_DEPLOYABLE_TO_CLIENT AS "is_deployable_to_client", 
           SYNCED_AT AS "synced_at", UPDATED_AT AS "updated_at"
         FROM CLIENT_DEPLOYMENTS 
         WHERE LOWER(CLIENT_NAME) = LOWER(:client_name) AND STACK = :stack`,
        { client_name, stack }
      );
      return res.rows[0];
    } else {
      // Called with: updateDeployableFlag(id, flagValue)
      const id = parseInt(idOrClient, 10);
      const flagVal = parseInt(stackOrValue, 10) === 1 ? 1 : 0;

      await conn.execute(
        `UPDATE CLIENT_DEPLOYMENTS 
         SET IS_DEPLOYABLE_TO_CLIENT = :flagVal, UPDATED_AT = :now
         WHERE ID = :id`,
        { flagVal, now, id }
      );

      const res = await conn.execute(
        `SELECT 
           ID AS "id", CLIENT_NAME AS "client_name", STACK AS "stack", 
           VERSION AS "version", STATUS AS "status", DEPLOYED_BY AS "deployed_by", 
           LAST_DEPLOYED_AT AS "last_deployed_at", RUN_ID AS "run_id", 
           IS_DEPLOYABLE_TO_CLIENT AS "is_deployable_to_client", 
           SYNCED_AT AS "synced_at", UPDATED_AT AS "updated_at"
         FROM CLIENT_DEPLOYMENTS 
         WHERE ID = :id`,
        { id }
      );
      return res.rows[0];
    }
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
  getConnectString
};
