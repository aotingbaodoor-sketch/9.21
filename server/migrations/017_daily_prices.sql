-- Additive migration: no existing customer, quotation, price or credential is changed.
CREATE TABLE pricing_sync_config (
 id integer PRIMARY KEY CHECK(id=1), version integer NOT NULL DEFAULT 1,
 data jsonb NOT NULL DEFAULT '{"enabled":true,"times":["07:30","23:30"],"referenceDays":4,"mode":"manual","currencies":["USD","EUR","GBP","JPY","HKD","AUD","CAD","SGD"],"bufferPct":0}',
 next_run timestamptz NOT NULL DEFAULT now(), last_checked timestamptz,
 last_success timestamptz, last_error text, lease_token uuid, lease_until timestamptz,
 requested_by uuid REFERENCES users(id), last_heartbeat timestamptz
);
INSERT INTO pricing_sync_config(id) VALUES(1);
CREATE TABLE pricing_fx_batches (
 id uuid PRIMARY KEY, source text NOT NULL, source_url text NOT NULL,
 source_date date NOT NULL, sha256 text NOT NULL UNIQUE,
 raw_xml text NOT NULL, rates jsonb NOT NULL, cny_rates jsonb NOT NULL,
 first_synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pricing_fx_latest ON pricing_fx_batches(source_date DESC,first_synced_at DESC);
CREATE TABLE pricing_sync_runs (
 id uuid PRIMARY KEY, trigger text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz, status text NOT NULL CHECK(status IN ('running','updated','unchanged','failed','interrupted')),
 attempts integer NOT NULL DEFAULT 0, batch_id uuid REFERENCES pricing_fx_batches(id), error text,
 requested_by uuid REFERENCES users(id)
);
CREATE INDEX pricing_runs_latest ON pricing_sync_runs(started_at DESC);
CREATE TABLE pricing_alerts (
 id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), message text NOT NULL,
 resolved_at timestamptz, run_id uuid REFERENCES pricing_sync_runs(id)
);
CREATE TABLE pricing_imports (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('product','freight')),
 name text NOT NULL, provider text NOT NULL, source_date date NOT NULL,
 valid_from date NOT NULL, valid_until date NOT NULL CHECK(valid_until>=valid_from),
 file_sha256 text NOT NULL, file_bytes bytea NOT NULL,
 rows jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES users(id),
 reviewed_at timestamptz, reviewed_by uuid REFERENCES users(id), review_note text,
 UNIQUE(kind,file_sha256,provider,source_date,valid_from,valid_until)
);
-- Public Supabase Data API must not expose operational data or supplier originals.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pricing_sync_config','pricing_fx_batches','pricing_sync_runs','pricing_alerts','pricing_imports'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',t); END IF;
 END LOOP;
END $$;
