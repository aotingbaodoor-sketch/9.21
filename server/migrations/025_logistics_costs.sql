-- Additive migration: existing prices, orders and issued snapshots are not rewritten.
CREATE TABLE logistics_cost_rates (
 id uuid PRIMARY KEY,series_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),data jsonb NOT NULL,
 is_current boolean NOT NULL DEFAULT true,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),reason text NOT NULL,
 UNIQUE(series_id,version)
);
CREATE UNIQUE INDEX logistics_cost_current_idx ON logistics_cost_rates(series_id) WHERE is_current;
CREATE INDEX logistics_cost_creator_idx ON logistics_cost_rates(created_by);
CREATE TABLE logistics_price_history (
 entity text NOT NULL,entity_id text NOT NULL,version integer NOT NULL,data jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(entity,entity_id,version)
);
CREATE FUNCTION logistics_remember_price() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO logistics_price_history(entity,entity_id,version,data) VALUES(TG_TABLE_NAME,NEW.id::text,NEW.version,NEW.data) ON CONFLICT DO NOTHING; RETURN NEW;
END $$;
CREATE TRIGGER logistics_product_history AFTER INSERT OR UPDATE ON quotation_products FOR EACH ROW EXECUTE FUNCTION logistics_remember_price();
CREATE TRIGGER logistics_freight_history AFTER INSERT OR UPDATE ON quotation_freight FOR EACH ROW EXECUTE FUNCTION logistics_remember_price();
CREATE TRIGGER logistics_policy_history AFTER INSERT OR UPDATE ON quotation_settings FOR EACH ROW EXECUTE FUNCTION logistics_remember_price();
INSERT INTO logistics_price_history SELECT 'quotation_products',id::text,version,data,now() FROM quotation_products;
INSERT INTO logistics_price_history SELECT 'quotation_freight',id::text,version,data,now() FROM quotation_freight;
INSERT INTO logistics_price_history SELECT 'quotation_settings',id::text,version,data,now() FROM quotation_settings;
CREATE TABLE logistics_quote_sheets (
 quote_id uuid PRIMARY KEY REFERENCES quotation_versions(id),snapshot jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX logistics_sheet_creator_idx ON logistics_quote_sheets(created_by);
CREATE TABLE logistics_evidence(id uuid PRIMARY KEY,name text NOT NULL,mime text NOT NULL,bytes bytea NOT NULL,sha256 text NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX logistics_evidence_creator_idx ON logistics_evidence(created_by);
CREATE TABLE logistics_imports(id uuid PRIMARY KEY,name text NOT NULL,bytes bytea NOT NULL,rows jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),committed_at timestamptz);
CREATE INDEX logistics_import_creator_idx ON logistics_imports(created_by);
CREATE FUNCTION logistics_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Frozen logistics versions cannot be altered'; END $$;
CREATE TRIGGER logistics_history_immutable BEFORE UPDATE OR DELETE ON logistics_price_history FOR EACH ROW EXECUTE FUNCTION logistics_immutable();
CREATE TRIGGER logistics_sheet_immutable BEFORE UPDATE OR DELETE ON logistics_quote_sheets FOR EACH ROW EXECUTE FUNCTION logistics_immutable();
CREATE FUNCTION logistics_rate_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rate versions cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'is_current') IS DISTINCT FROM (to_jsonb(OLD)-'is_current') OR (NOT OLD.is_current AND NEW.is_current) THEN RAISE EXCEPTION 'Create a new rate version'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER logistics_rate_version BEFORE UPDATE OR DELETE ON logistics_cost_rates FOR EACH ROW EXECUTE FUNCTION logistics_rate_immutable();
ALTER TABLE crm_work_orders DROP CONSTRAINT crm_work_orders_trade_term_check;
ALTER TABLE crm_work_orders ADD CONSTRAINT crm_work_orders_trade_term_check CHECK(trade_term IN ('EXW','FOB','CIF','DAP','DDP'));
-- Do not change historical order terms or progress; applicability is recorded for new WOs only.
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['logistics_cost_rates','logistics_price_history','logistics_quote_sheets','logistics_evidence','logistics_imports'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
  END LOOP;
 END LOOP;
END $$;
