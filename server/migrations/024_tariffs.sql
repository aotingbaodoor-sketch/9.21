-- Additive T45 and immutable rate versions. Rollback application to d8eac9c; retain these tables.
CREATE TABLE tariff_source_registry (
 code text PRIMARY KEY, region text NOT NULL,countries text NOT NULL,name text NOT NULL,url text NOT NULL,
 access_type text NOT NULL CHECK(access_type IN ('api','official_portal','registration')),
 hs_level text NOT NULL,authority text NOT NULL CHECK(authority IN ('official','intergovernmental','third_party')),
 notes text NOT NULL DEFAULT '',requirements text NOT NULL DEFAULT '',enabled boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'unconfirmed',checked_at timestamptz,last_success_at timestamptz,last_error text,check_evidence jsonb NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1,updated_by uuid REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tariff_records (
 id uuid PRIMARY KEY,source_code text NOT NULL REFERENCES tariff_source_registry(code),series_key text NOT NULL,version integer NOT NULL,
 country text NOT NULL,origin text NOT NULL,hs_code text NOT NULL CHECK(hs_code ~ '^\d{6,12}$'),hs_level integer NOT NULL CHECK(hs_level BETWEEN 6 AND 12),
 description text NOT NULL,tax_kind text NOT NULL CHECK(tax_kind IN ('duty','vat','extra','export_rebate')),rate_text text NOT NULL,conditions text NOT NULL,
 effective_from date,effective_until date,data_year integer,source_url text NOT NULL,source_published_at timestamptz,
 fingerprint text NOT NULL,raw_data jsonb NOT NULL DEFAULT '{}',fetched_at timestamptz NOT NULL DEFAULT now(),last_success_at timestamptz NOT NULL DEFAULT now(),
 reference_only boolean NOT NULL DEFAULT true,is_current boolean NOT NULL DEFAULT true,
 verification text NOT NULL DEFAULT 'pending' CHECK(verification IN ('pending','verified','rejected')),
 verified_by uuid REFERENCES users(id),verified_on timestamptz,review_note text,evidence_url text,created_by uuid REFERENCES users(id),
 UNIQUE(source_code,series_key,version),CHECK(hs_level=length(hs_code)),CHECK(effective_until IS NULL OR effective_until>=effective_from),
 CHECK(verification<>'verified' OR (verified_by IS NOT NULL AND verified_on IS NOT NULL AND evidence_url IS NOT NULL))
);
CREATE UNIQUE INDEX tariff_current_idx ON tariff_records(source_code,series_key) WHERE is_current;
CREATE INDEX tariff_lookup_idx ON tariff_records(country,hs_code,origin) WHERE is_current;
CREATE INDEX tariff_record_creator_idx ON tariff_records(created_by);
CREATE INDEX tariff_record_reviewer_idx ON tariff_records(verified_by);
CREATE INDEX tariff_source_editor_idx ON tariff_source_registry(updated_by);
CREATE TABLE tariff_sync_runs (
 id uuid PRIMARY KEY,source_code text NOT NULL REFERENCES tariff_source_registry(code),status text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,attempts integer NOT NULL DEFAULT 0,
 changed integer NOT NULL DEFAULT 0,records integer NOT NULL DEFAULT 0,error text,request_url text
);
CREATE INDEX tariff_runs_time_idx ON tariff_sync_runs(started_at DESC);
INSERT INTO automation_rule(code,config) VALUES('tariff_sync','{"time":"07:30","timezone":"Asia/Shanghai","usHeadings":["7610"]}');
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['tariff_source_registry','tariff_records','tariff_sync_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
  END LOOP;
 END LOOP;
END $$;
