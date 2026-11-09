-- =============================================================================
-- ORACLE DATABASE DDL SCRIPT
-- Target Table: SA_DEPLOYMENT_TRACKER
-- Schema Owner: bms (or application schema)
-- Database    : Oracle Database 19c
-- =============================================================================

-- 1. Create Table
CREATE TABLE SA_DEPLOYMENT_TRACKER (
    ID                      NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    CLIENT_NAME             VARCHAR2(100) NOT NULL,
    STACK                   VARCHAR2(10)  NOT NULL,
    VERSION                 VARCHAR2(100) DEFAULT 'unknown',
    STATUS                  VARCHAR2(50)  DEFAULT 'pending_first_deploy',
    DEPLOYED_BY             VARCHAR2(100) DEFAULT 'system',
    LAST_DEPLOYED_AT        VARCHAR2(100),
    RUN_ID                  VARCHAR2(100),
    IS_DEPLOYABLE_TO_CLIENT NUMBER(1)     DEFAULT 0 NOT NULL,
    ISSUE_NOTES             VARCHAR2(500),
    SYNCED_AT               VARCHAR2(100),
    UPDATED_AT              VARCHAR2(100),
    
    -- Table Constraints
    CONSTRAINT UQ_SA_DEPLOY_CLIENT_STACK UNIQUE (CLIENT_NAME, STACK),
    CONSTRAINT CK_SA_DEPLOY_STACK CHECK (STACK IN ('F', 'B')),
    CONSTRAINT CK_SA_DEPLOY_FLAG CHECK (IS_DEPLOYABLE_TO_CLIENT IN (0, 1))
);

-- 2. Performance Indexes
CREATE INDEX IDX_SA_DEPLOY_CLIENT ON SA_DEPLOYMENT_TRACKER (CLIENT_NAME);
CREATE INDEX IDX_SA_DEPLOY_STACK  ON SA_DEPLOYMENT_TRACKER (STACK);
CREATE INDEX IDX_SA_DEPLOY_FLAG   ON SA_DEPLOYMENT_TRACKER (IS_DEPLOYABLE_TO_CLIENT);

-- 3. Column Documentation Comments
COMMENT ON TABLE  SA_DEPLOYMENT_TRACKER                         IS 'Tracks frontend and backend deployments across all ERP client boxes';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.ID                      IS 'Primary key unique auto-increment identifier';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.CLIENT_NAME             IS 'Client box / tenant name (e.g., stage, shinshin, karupannya, ananta-uat, ananta-live)';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.STACK                   IS 'Deployment component stack: F for Frontend, B for Backend';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.VERSION                 IS 'Currently deployed release version tag (e.g., v1.41.0, v2.10.0)';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.STATUS                  IS 'Deployment health status (e.g., success, pending_first_deploy, failure)';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.DEPLOYED_BY             IS 'Username or actor who triggered the release deployment';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.LAST_DEPLOYED_AT        IS 'UTC ISO-8601 timestamp when deployment completed';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.RUN_ID                  IS 'GitHub Actions workflow run identifier';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.IS_DEPLOYABLE_TO_CLIENT IS '0 = Deployable (ready / all good), 1 = Has an issue (blocked / not deployable)';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.ISSUE_NOTES             IS 'Optional description or notes if an issue is reported';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.SYNCED_AT               IS 'Timestamp when data was synchronized from GitHub';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.UPDATED_AT              IS 'Timestamp when row or deployable flag was last modified';

-- =============================================================================
-- ALTERNATIVE: If your DBA prefers Sequences instead of IDENTITY columns:
-- =============================================================================
/*
CREATE SEQUENCE S_SA_DEPLOYMENT_TRACKER START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE SA_DEPLOYMENT_TRACKER (
    ID                      NUMBER DEFAULT S_SA_DEPLOYMENT_TRACKER.NEXTVAL PRIMARY KEY,
    CLIENT_NAME             VARCHAR2(100) NOT NULL,
    STACK                   VARCHAR2(10)  NOT NULL,
    VERSION                 VARCHAR2(100) DEFAULT 'unknown',
    STATUS                  VARCHAR2(50)  DEFAULT 'pending_first_deploy',
    DEPLOYED_BY             VARCHAR2(100) DEFAULT 'system',
    LAST_DEPLOYED_AT        VARCHAR2(100),
    RUN_ID                  VARCHAR2(100),
    IS_DEPLOYABLE_TO_CLIENT NUMBER(1)     DEFAULT 0 NOT NULL,
    ISSUE_NOTES             VARCHAR2(500),
    SYNCED_AT               VARCHAR2(100),
    UPDATED_AT              VARCHAR2(100),
    CONSTRAINT UQ_SA_DEPLOY_CLIENT_STACK UNIQUE (CLIENT_NAME, STACK),
    CONSTRAINT CK_SA_DEPLOY_STACK CHECK (STACK IN ('F', 'B')),
    CONSTRAINT CK_SA_DEPLOY_FLAG CHECK (IS_DEPLOYABLE_TO_CLIENT IN (0, 1))
);
*/
