-- Additive only. Rollback: run the previous application; retain these records.
CREATE TABLE automation_rule (
 code text PRIMARY KEY,
 enabled boolean NOT NULL DEFAULT true,
 config jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1,
 next_run timestamptz NOT NULL DEFAULT now(),
 last_heartbeat timestamptz,
 last_success timestamptz,
 last_error text,
 requested_by uuid REFERENCES users(id),
 updated_by uuid REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO automation_rule(code,config) VALUES ('cloud_backup','{"time":"03:30","timezone":"Asia/Shanghai","retentionDays":14}');
CREATE TABLE crm_backup_runs (
 id uuid PRIMARY KEY,
 rule_code text NOT NULL REFERENCES automation_rule(code),
 trigger text NOT NULL CHECK(trigger IN ('scheduled','manual')),
 requested_by uuid REFERENCES users(id),
 status text NOT NULL CHECK(status IN ('running','verified','failed','interrupted')),
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 error text,
 bucket text,
 object_key text,
 key_id text,
 sha256 text,
 snapshot_sha256 text,
 bytes integer,
 table_counts jsonb,
 app_version text,
 snapshot_at timestamptz,
 verified_at timestamptz,
 deleted_at timestamptz,
 retention_error text,
 UNIQUE(bucket,object_key)
);
CREATE INDEX crm_backup_runs_started_idx ON crm_backup_runs(started_at DESC);
CREATE INDEX crm_backup_runs_requested_idx ON crm_backup_runs(requested_by);
CREATE INDEX automation_rule_requested_idx ON automation_rule(requested_by);
CREATE INDEX automation_rule_updated_idx ON automation_rule(updated_by);
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['automation_rule','crm_backup_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
  END LOOP;
 END LOOP;
END $$;
