-- =============================================================================
-- ORACLE DATABASE MIGRATION SCRIPT: ADD BACKEND DEPLOYABLE COLUMN
-- Schema Owner: bms (or application schema)
-- Tablespace  : SIT
-- Target DB   : Oracle Database 19c
--
-- Description : Adds IS_BACKEND_DEPLOYABLE column to SA_DEPLOYMENT_TRACKER_DTL
--               and SA_DEPLOYMENT_TRACKER tables. The existing column
--               IS_DEPLOYABLE_TO_CLIENT is preserved for Frontend Deployable.
-- =============================================================================

-- 1. Add IS_BACKEND_DEPLOYABLE to Child Detail / History Table (SA_DEPLOYMENT_TRACKER_DTL)
ALTER TABLE SA_DEPLOYMENT_TRACKER_DTL ADD (
    IS_BACKEND_DEPLOYABLE NUMBER(1) DEFAULT 0 NOT NULL
);

ALTER TABLE SA_DEPLOYMENT_TRACKER_DTL ADD CONSTRAINT SA_DEPLOYMENT_DTL_C03 
    CHECK (IS_BACKEND_DEPLOYABLE IN (0, 1));

CREATE INDEX IDX_SA_DEPLOY_DTL_B_FLAG ON SA_DEPLOYMENT_TRACKER_DTL (IS_BACKEND_DEPLOYABLE) 
    TABLESPACE SIT;

COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER_DTL.IS_DEPLOYABLE_TO_CLIENT IS 'Frontend deployable qualification flag (0 = Deployable, 1 = Has Issue / Blocked)';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER_DTL.IS_BACKEND_DEPLOYABLE IS 'Backend deployable qualification flag (0 = Deployable, 1 = Has Issue / Blocked)';

-- 2. Add IS_BACKEND_DEPLOYABLE to Master / Latest Snapshot Table (SA_DEPLOYMENT_TRACKER)
ALTER TABLE SA_DEPLOYMENT_TRACKER ADD (
    IS_BACKEND_DEPLOYABLE NUMBER(1) DEFAULT 0 NOT NULL
);

ALTER TABLE SA_DEPLOYMENT_TRACKER ADD CONSTRAINT SA_DEPLOYMENT_C03 
    CHECK (IS_BACKEND_DEPLOYABLE IN (0, 1));

CREATE INDEX IDX_SA_DEPLOY_B_FLAG ON SA_DEPLOYMENT_TRACKER (IS_BACKEND_DEPLOYABLE) 
    TABLESPACE SIT;

COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.IS_DEPLOYABLE_TO_CLIENT IS 'Frontend deployable qualification flag (0 = Deployable, 1 = Has Issue / Blocked)';
COMMENT ON COLUMN SA_DEPLOYMENT_TRACKER.IS_BACKEND_DEPLOYABLE IS 'Backend deployable qualification flag (0 = Deployable, 1 = Has Issue / Blocked)';

COMMIT;
