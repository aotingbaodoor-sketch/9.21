-- Supplier material prices use technical UUIDs, not the reserved MAT number issuer.
CREATE TABLE logistics_materials(
 id uuid PRIMARY KEY, series_id uuid NOT NULL, factory_id uuid NOT NULL REFERENCES factories(id),
 supplier_code text NOT NULL,version integer NOT NULL CHECK(version>0),data jsonb NOT NULL,
 is_current boolean NOT NULL DEFAULT true,created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),reason text NOT NULL,
 UNIQUE(series_id,version)
);
CREATE UNIQUE INDEX logistics_material_current ON logistics_materials(factory_id,supplier_code) WHERE is_current;
CREATE UNIQUE INDEX logistics_material_series ON logistics_materials(series_id) WHERE is_current;
CREATE TRIGGER logistics_material_immutable BEFORE UPDATE OR DELETE ON logistics_materials FOR EACH ROW EXECUTE FUNCTION logistics_rate_immutable();
ALTER TABLE logistics_materials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_materials FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON logistics_materials FROM %I',r); END IF;
 END LOOP;
END $$;
ALTER TABLE logistics_imports ADD COLUMN kind text NOT NULL DEFAULT 'rates' CHECK(kind IN ('rates','materials','options'));
