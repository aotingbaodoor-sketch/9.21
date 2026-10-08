-- Additive completion records. Existing documents, numbers and accounts are untouched.
ALTER TABLE crm_fulfillment_approvers ADD COLUMN cs_user_id uuid REFERENCES users(id), ADD COLUMN scm_user_id uuid REFERENCES users(id);
CREATE TABLE crm_fulfillment_policy (
 id integer PRIMARY KEY CHECK(id=1), tax_rebate_enabled boolean NOT NULL DEFAULT false,
 updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO crm_fulfillment_policy(id) VALUES(1);
CREATE TABLE crm_delivery_acceptance (
 work_order_id uuid PRIMARY KEY REFERENCES crm_work_orders(id), pod_document_id uuid NOT NULL REFERENCES crm_logistics_documents(id),
 delivered_on date NOT NULL, signed_by text NOT NULL CHECK(length(trim(signed_by))>0),
 package_condition text NOT NULL CHECK(package_condition IN ('intact','damaged')), damage_file_id uuid REFERENCES quotation_files(id),
 arrival_on date NOT NULL, container_no text NOT NULL, bl_no text NOT NULL,
 objection_deadline date NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(arrival_on<=delivered_on), CHECK(objection_deadline=delivered_on+7), CHECK(package_condition<>'damaged' OR damage_file_id IS NOT NULL)
);
CREATE TABLE crm_acceptance_records (
 id uuid PRIMARY KEY, work_order_id uuid NOT NULL REFERENCES crm_delivery_acceptance(work_order_id),
 result text NOT NULL CHECK(result IN ('accepted','objection')), occurred_on date NOT NULL, note text NOT NULL,
 file_id uuid NOT NULL REFERENCES quotation_files(id), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_acceptance_wo_idx ON crm_acceptance_records(work_order_id,created_at);
CREATE UNIQUE INDEX crm_acceptance_pass_once ON crm_acceptance_records(work_order_id) WHERE result='accepted';
CREATE TABLE crm_after_sales_cases (
 id uuid PRIMARY KEY, document_id uuid NOT NULL UNIQUE REFERENCES crm_document_registry(id),
 work_order_id uuid NOT NULL REFERENCES crm_work_orders(id), category text NOT NULL, description text NOT NULL,
 file_id uuid NOT NULL REFERENCES quotation_files(id), responsible_party text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_after_sales_wo_idx ON crm_after_sales_cases(work_order_id,created_at);
CREATE TABLE crm_after_sales_resolutions (
 case_id uuid PRIMARY KEY REFERENCES crm_after_sales_cases(id), action text NOT NULL, followup text NOT NULL,
 file_id uuid NOT NULL REFERENCES quotation_files(id), confirmed_by uuid NOT NULL REFERENCES users(id), confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crm_warranty_anchors (
 work_order_id uuid PRIMARY KEY REFERENCES crm_delivery_acceptance(work_order_id), warranty_from date NOT NULL,
 supplier_snapshot jsonb NOT NULL CHECK(jsonb_typeof(supplier_snapshot)='array'),
 confirmed_by uuid NOT NULL REFERENCES users(id), confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crm_delivery_visits (
 id uuid PRIMARY KEY, work_order_id uuid NOT NULL REFERENCES crm_delivery_acceptance(work_order_id), visited_on date NOT NULL,
 installation_support text NOT NULL CHECK(installation_support IN ('remote','onsite','not_needed')),
 result text NOT NULL, file_id uuid NOT NULL REFERENCES quotation_files(id), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_delivery_visits_wo_idx ON crm_delivery_visits(work_order_id);
CREATE TABLE crm_order_close_confirmations (
 id uuid PRIMARY KEY, work_order_id uuid NOT NULL REFERENCES crm_work_orders(id), kind text NOT NULL CHECK(kind IN ('finance','cs','scm')),
 file_id uuid NOT NULL REFERENCES quotation_files(id), note text NOT NULL,
 confirmed_by uuid NOT NULL REFERENCES users(id), confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_close_confirmation_wo_idx ON crm_order_close_confirmations(work_order_id,kind,confirmed_at);
CREATE TABLE crm_work_order_close (
 work_order_id uuid PRIMARY KEY REFERENCES crm_warranty_anchors(work_order_id),
 conditions_snapshot jsonb NOT NULL, tax_docs_file_id uuid REFERENCES quotation_files(id), tax_na_reason text,
 closed_by uuid NOT NULL REFERENCES users(id), closed_at timestamptz NOT NULL DEFAULT now(),
 CHECK((tax_docs_file_id IS NOT NULL)<>(tax_na_reason IS NOT NULL))
);
CREATE FUNCTION crm_delivery_anchor_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='crm_delivery_acceptance' THEN
  IF NOT EXISTS(SELECT 1 FROM crm_logistics_documents l JOIN crm_work_orders w ON w.id=l.work_order_id JOIN crm_fulfillment_stage s ON s.code=w.current_stage
   WHERE l.id=NEW.pod_document_id AND l.work_order_id=NEW.work_order_id AND l.doc_type='pod' AND l.check_result='matched' AND s.ordinal>=18)
   THEN RAISE EXCEPTION 'G-16: 签收需要本工单已核对POD及前置节点'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM crm_delivery_acceptance d WHERE d.work_order_id=NEW.work_order_id AND d.delivered_on=NEW.warranty_from) THEN
  RAISE EXCEPTION '质保起算必须等于客户实际签收日';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_delivery_gate BEFORE INSERT ON crm_delivery_acceptance FOR EACH ROW EXECUTE FUNCTION crm_delivery_anchor_gate();
CREATE TRIGGER crm_warranty_gate BEFORE INSERT ON crm_warranty_anchors FOR EACH ROW EXECUTE FUNCTION crm_delivery_anchor_gate();
CREATE FUNCTION crm_keep_used_pod() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM crm_delivery_acceptance WHERE pod_document_id=OLD.id) THEN
  RAISE EXCEPTION '已用于签收的POD及核验结果不可覆盖';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_used_pod_immutable BEFORE UPDATE OR DELETE ON crm_logistics_documents FOR EACH ROW EXECUTE FUNCTION crm_keep_used_pod();
-- These times represent the saved facts after the WO lock is acquired, not transaction start.
ALTER TABLE crm_after_sales_cases ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE crm_after_sales_resolutions ALTER COLUMN confirmed_at SET DEFAULT clock_timestamp();
ALTER TABLE crm_order_close_confirmations ALTER COLUMN confirmed_at SET DEFAULT clock_timestamp();
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['crm_delivery_acceptance','crm_acceptance_records','crm_after_sales_cases','crm_after_sales_resolutions','crm_warranty_anchors','crm_delivery_visits','crm_order_close_confirmations','crm_work_order_close'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION crm_keep_document_registry()',t||'_immutable',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['crm_fulfillment_policy','crm_delivery_acceptance','crm_acceptance_records','crm_after_sales_cases','crm_after_sales_resolutions','crm_warranty_anchors','crm_delivery_visits','crm_order_close_confirmations','crm_work_order_close'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
  END LOOP;
 END LOOP;
END $$;
