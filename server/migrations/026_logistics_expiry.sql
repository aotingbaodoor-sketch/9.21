-- Additive daily expiry checks; no price or historical order is changed.
INSERT INTO automation_rule(code,config) VALUES('logistics_expiry','{"time":"07:30","timezone":"Asia/Shanghai","warningDays":7}');
CREATE TABLE logistics_expiry_alerts (
 id uuid PRIMARY KEY, entity text NOT NULL, entity_id uuid NOT NULL, version integer NOT NULL,
 state text NOT NULL CHECK(state IN ('due','expired','missing')), name text NOT NULL,
 valid_until date, created_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz NOT NULL,
 resolved_at timestamptz, UNIQUE(entity,entity_id,version,state)
);
CREATE INDEX logistics_expiry_open_idx ON logistics_expiry_alerts(checked_at) WHERE resolved_at IS NULL;
CREATE TABLE logistics_expiry_runs (
 id uuid PRIMARY KEY, started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('success','failed')), alert_count integer, error text
);
CREATE INDEX logistics_expiry_runs_idx ON logistics_expiry_runs(started_at DESC);
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['logistics_expiry_alerts','logistics_expiry_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
  END LOOP;
 END LOOP;
END $$;
