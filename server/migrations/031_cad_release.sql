-- Append-only workflow and evidence. Existing drawings/TC/MO remain unchanged.
CREATE TABLE cad_lifecycle(id uuid PRIMARY KEY,version_id uuid NOT NULL REFERENCES cad_versions(id),state text NOT NULL CHECK(state IN ('draft','submitted','reviewed','production_approved','void')),note text NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX cad_lifecycle_version_idx ON cad_lifecycle(version_id,created_at DESC);
CREATE TABLE cad_production_packets(id uuid PRIMARY KEY,version_id uuid NOT NULL REFERENCES cad_versions(id),drawing_source_id uuid NOT NULL REFERENCES cad_sources(id),profile_source_id uuid NOT NULL REFERENCES cad_sources(id),node_source_id uuid NOT NULL REFERENCES cad_sources(id),tolerance_source_id uuid NOT NULL REFERENCES cad_sources(id),inspection_source_id uuid NOT NULL REFERENCES cad_sources(id),technical_report jsonb NOT NULL,output jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX cad_packet_version_idx ON cad_production_packets(version_id,created_at DESC);
CREATE TABLE cad_analysis_progress(source_id uuid PRIMARY KEY REFERENCES cad_sources(id),phase text NOT NULL,attempt integer NOT NULL DEFAULT 1,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,error text);
ALTER TABLE cad_analysis_progress ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['cad_lifecycle','cad_production_packets'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION crm_keep_document_registry()',t||'_immutable',t);
END LOOP; END $$;
-- Rollback: deploy previous application; retain these append-only tables as evidence.
