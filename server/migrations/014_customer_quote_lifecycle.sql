-- Existing customers remain unclassified: do not guess lifecycle from old marketing stages.
ALTER TABLE customers ADD COLUMN biz_status text CHECK(biz_status IN ('资料','已报价','已收定金','已量尺','生产中','已发货','已安装'));
ALTER TABLE customers ALTER COLUMN biz_status SET DEFAULT '资料';
ALTER TABLE quotation_versions ADD COLUMN registered_document_id uuid UNIQUE REFERENCES crm_document_registry(id);
CREATE TABLE crm_customer_status_events (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id),
 from_status text NOT NULL, to_status text NOT NULL,
 trigger_document_id uuid NOT NULL REFERENCES crm_document_registry(id),
 actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,trigger_document_id)
);
CREATE INDEX crm_customer_status_event_idx ON crm_customer_status_events(customer_id,created_at);
CREATE TRIGGER crm_customer_status_event_immutable BEFORE UPDATE OR DELETE ON crm_customer_status_events FOR EACH ROW EXECUTE FUNCTION crm_keep_document_registry();
CREATE FUNCTION crm_keep_quote_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.registered_document_id IS NOT NULL AND NEW.registered_document_id IS DISTINCT FROM OLD.registered_document_id THEN
  RAISE EXCEPTION '已签发QT编号不可更换或清除';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quote_number_immutable BEFORE UPDATE ON quotation_versions FOR EACH ROW EXECUTE FUNCTION crm_keep_quote_number();
ALTER TABLE crm_customer_status_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crm_customer_status_events FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON crm_customer_status_events FROM %I',r); END IF;
 END LOOP;
END $$;
