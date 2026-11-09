-- =============================================================================
-- ORACLE DATABASE DDL SCRIPT
-- Table Name  : SA_DEPLOYMENT_TRACKER
-- Schema Owner: bms (or application schema)
-- Tablespace  : SIT
-- Database    : Oracle Database 19c
-- =============================================================================

-- Option 1: Standard Table Creation with IDENTITY Column (Oracle 12c / 19c)
CREATE TABLE SA_DEPLOYMENT_TRACKER (
    -- Application & Deployment Tracking Columns
    ID                      NUMBER(30) GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    CLIENT_NAME             VARCHAR2(100 BYTE) NOT NULL,
    STACK                   VARCHAR2(10 BYTE)  NOT NULL,
    VERSION                 VARCHAR2(100 BYTE) DEFAULT 'unknown',
    STATUS                  VARCHAR2(50 BYTE)  DEFAULT 'pending_first_deploy',
    DEPLOYED_BY             VARCHAR2(100 BYTE) DEFAULT 'system',
    LAST_DEPLOYED_AT        VARCHAR2(100 BYTE),
    RUN_ID                  VARCHAR2(100 BYTE),
    IS_DEPLOYABLE_TO_CLIENT NUMBER(1)          DEFAULT 0 NOT NULL,
    ISSUE_NOTES             VARCHAR2(500 BYTE),
    SYNCED_AT               VARCHAR2(100 BYTE),
    UPDATED_AT              VARCHAR2(100 BYTE),

    -- Standard PrideSys ERP Audit & Control Columns
    SS_CREATOR              NUMBER(30),
    SS_CREATED_ON           VARCHAR2(50 BYTE),
    SS_MODIFIER             NUMBER(30),
    SS_MODIFIED_ON          VARCHAR2(50 BYTE),
    COMPANY_NO              NUMBER(30),
    SS_OG_NO                NUMBER(10),
    SS_UPLOADED_ON          VARCHAR2(50 BYTE),
    SS_IS_DELETED           NUMBER(1)          DEFAULT 0,
    SS_IS_UPLOADED          NUMBER(1)          DEFAULT 0,

    -- Business Constraints
    CONSTRAINT UQ_SA_DEPLOY_CLIENT_STACK UNIQUE (CLIENT_NAME, STACK),
    CONSTRAINT CK_SA_DEPLOY_STACK CHECK (STACK IN ('F', 'B')),
    CONSTRAINT CK_SA_DEPLOY_FLAG CHECK (IS_DEPLOYABLE_TO_CLIENT IN (0, 1))
)
TABLESPACE SIT
LOGGING
NOCOMPRESS
NOCACHE
ENABLE ROW MOVEMENT;

-- Performance Indexes on Tablespace SIT
CREATE INDEX IDX_SA_DEPLOY_CLIENT ON SA_DEPLOYMENT_TRACKER (CLIENT_NAME) TABLESPACE SIT;
CREATE INDEX IDX_SA_DEPLOY_STACK  ON SA_DEPLOYMENT_TRACKER (STACK) TABLESPACE SIT;
CREATE INDEX IDX_SA_DEPLOY_FLAG   ON SA_DEPLOYMENT_TRACKER (IS_DEPLOYABLE_TO_CLIENT) TABLESPACE SIT;

-- Column Documentation Comments
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
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.SS_CREATOR              IS 'User ID who created the record';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.SS_CREATED_ON           IS 'Creation timestamp';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.SS_MODIFIER             IS 'User ID who last modified the record';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.SS_MODIFIED_ON          IS 'Modification timestamp';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.COMPANY_NO              IS 'PrideSys Company ID';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.SS_OG_NO                IS 'PrideSys Operating Group ID';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.SS_UPLOADED_ON          IS 'Timestamp when record was uploaded to remote node';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.SS_IS_DELETED           IS 'Soft-delete flag: 0 = Active, 1 = Deleted';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.SS_IS_UPLOADED          IS 'Upload status flag: 0 = Pending, 1 = Uploaded';


-- =============================================================================
-- Option 2: Sequence-Based Table Creation (If your DBA prefers Sequences)
-- =============================================================================
/*
CREATE SEQUENCE S_SA_DEPLOYMENT_TRACKER START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE SA_DEPLOYMENT_TRACKER (
    ID                      NUMBER(30) DEFAULT S_SA_DEPLOYMENT_TRACKER.NEXTVAL PRIMARY KEY,
    CLIENT_NAME             VARCHAR2(100 BYTE) NOT NULL,
    STACK                   VARCHAR2(10 BYTE)  NOT NULL,
    VERSION                 VARCHAR2(100 BYTE) DEFAULT 'unknown',
    STATUS                  VARCHAR2(50 BYTE)  DEFAULT 'pending_first_deploy',
    DEPLOYED_BY             VARCHAR2(100 BYTE) DEFAULT 'system',
    LAST_DEPLOYED_AT        VARCHAR2(100 BYTE),
    RUN_ID                  VARCHAR2(100 BYTE),
    IS_DEPLOYABLE_TO_CLIENT NUMBER(1)          DEFAULT 0 NOT NULL,
    ISSUE_NOTES             VARCHAR2(500 BYTE),
    SYNCED_AT               VARCHAR2(100 BYTE),
    UPDATED_AT              VARCHAR2(100 BYTE),
    SS_CREATOR              NUMBER(30),
    SS_CREATED_ON           VARCHAR2(50 BYTE),
    SS_MODIFIER             NUMBER(30),
    SS_MODIFIED_ON          VARCHAR2(50 BYTE),
    COMPANY_NO              NUMBER(30),
    SS_OG_NO                NUMBER(10),
    SS_UPLOADED_ON          VARCHAR2(50 BYTE),
    SS_IS_DELETED           NUMBER(1)          DEFAULT 0,
    SS_IS_UPLOADED          NUMBER(1)          DEFAULT 0,
    CONSTRAINT UQ_SA_DEPLOY_CLIENT_STACK UNIQUE (CLIENT_NAME, STACK),
    CONSTRAINT CK_SA_DEPLOY_STACK CHECK (STACK IN ('F', 'B')),
    CONSTRAINT CK_SA_DEPLOY_FLAG CHECK (IS_DEPLOYABLE_TO_CLIENT IN (0, 1))
)
TABLESPACE SIT
LOGGING
NOCOMPRESS
NOCACHE
ENABLE ROW MOVEMENT;

CREATE INDEX IDX_SA_DEPLOY_CLIENT ON SA_DEPLOYMENT_TRACKER (CLIENT_NAME) TABLESPACE SIT;
CREATE INDEX IDX_SA_DEPLOY_STACK  ON SA_DEPLOYMENT_TRACKER (STACK) TABLESPACE SIT;
CREATE INDEX IDX_SA_DEPLOY_FLAG   ON SA_DEPLOYMENT_TRACKER (IS_DEPLOYABLE_TO_CLIENT) TABLESPACE SIT;
*/
