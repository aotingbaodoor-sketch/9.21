-- Additive registry. Existing business numbers and historical rows are not rewritten.
CREATE TABLE crm_document_class (
 code text PRIMARY KEY CHECK(code ~ '^[A-Z]{2}$'),
 family text NOT NULL CHECK(family IN ('A','B')),
 enabled boolean NOT NULL DEFAULT true,
 UNIQUE(code,family)
);
INSERT INTO crm_document_class(code,family) SELECT unnest(ARRAY['QT','PI','SC','SO','CI','PL','RC','BP']),'A';
INSERT INTO crm_document_class(code,family) SELECT unnest(ARRAY['LD','WO','AS','QC','SM','CK','PO','SA','GR','AR','AP','EX','FA','DA','MO']),'B';
CREATE TABLE crm_document_sequence (
 scope_key text PRIMARY KEY, last_value integer NOT NULL CHECK(last_value BETWEEN 1 AND 9999)
);
CREATE TABLE crm_document_registry (
 id uuid PRIMARY KEY, doc_no text NOT NULL UNIQUE,
 class_code text NOT NULL, family text NOT NULL,
 customer_id uuid REFERENCES customers(id), doc_date date NOT NULL,
 sequence_value integer NOT NULL CHECK(sequence_value > 0), scope_key text NOT NULL REFERENCES crm_document_sequence(scope_key),
 business_kind text NOT NULL CHECK(length(trim(business_kind))>0), business_id uuid NOT NULL,
 request_key uuid NOT NULL UNIQUE, request_hash text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(class_code,family) REFERENCES crm_document_class(code,family),
 UNIQUE(scope_key,sequence_value), UNIQUE(class_code,business_kind,business_id),
 CHECK((family='A' AND customer_id IS NOT NULL AND sequence_value<=999 AND doc_no ~ '^[A-HJ-NP-Z][0-9]{12}-[A-Z]{2}[0-9]{3}$') OR
       (family='B' AND sequence_value<=9999 AND doc_no ~ '^[A-Z]{2}[0-9]{10}$')),
 CHECK(class_code<>'AR' OR customer_id IS NOT NULL)
);
CREATE INDEX crm_document_customer_idx ON crm_document_registry(customer_id,created_at);
-- Multi-customer B documents use explicit links, never LEFT(doc_no,...).
CREATE TABLE crm_document_customer_link (
 document_id uuid NOT NULL REFERENCES crm_document_registry(id), customer_id uuid NOT NULL REFERENCES customers(id),
 PRIMARY KEY(document_id,customer_id)
);
CREATE INDEX crm_document_link_customer_idx ON crm_document_customer_link(customer_id,document_id);
CREATE FUNCTION crm_validate_document_registry() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE customer_code text; expected_no text; expected_scope text;
BEGIN
 IF NEW.family='A' THEN
  SELECT crm_customer_code INTO customer_code FROM customers WHERE id=NEW.customer_id;
  IF customer_code IS NULL THEN RAISE EXCEPTION '客户尚无已登记的新编号'; END IF;
  expected_no=customer_code||'-'||NEW.class_code||lpad(NEW.sequence_value::text,3,'0');
  expected_scope='customer:'||NEW.customer_id::text||':'||NEW.class_code;
 ELSE
  expected_no=NEW.class_code||to_char(NEW.doc_date,'YYMMDD')||lpad(NEW.sequence_value::text,4,'0');
  expected_scope='company:'||to_char(NEW.doc_date,'YYYY-MM-DD')||':'||NEW.class_code;
 END IF;
 IF NEW.doc_no IS DISTINCT FROM expected_no OR NEW.scope_key IS DISTINCT FROM expected_scope THEN
  RAISE EXCEPTION '单据编号与独立登记字段不一致';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_document_validate BEFORE INSERT ON crm_document_registry FOR EACH ROW EXECUTE FUNCTION crm_validate_document_registry();
CREATE FUNCTION crm_keep_document_registry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '已发编号及关联不可修改、删除或复用'; END $$;
CREATE TRIGGER crm_document_immutable BEFORE UPDATE OR DELETE ON crm_document_registry FOR EACH ROW EXECUTE FUNCTION crm_keep_document_registry();
CREATE TRIGGER crm_document_link_immutable BEFORE UPDATE OR DELETE ON crm_document_customer_link FOR EACH ROW EXECUTE FUNCTION crm_keep_document_registry();
CREATE TRIGGER crm_document_sequence_monotonic BEFORE UPDATE OR DELETE ON crm_document_sequence FOR EACH ROW EXECUTE FUNCTION crm_keep_identity();
CREATE TABLE crm_runtime_config (
 key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES users(id),
 CHECK ((key IN ('sla_assign_minutes','sla_first_reply_minutes','sla_quote_followup_hours','sla_deposit_reminder_days','sla_aftersale_first_hours','sla_production_inquiry_days')
   AND jsonb_typeof(value)='number' AND value::text ~ '^[1-9][0-9]*$') OR
   (key='escalation_after_breach' AND value IN ('"notify_manager"'::jsonb,'"none"'::jsonb)))
);
INSERT INTO crm_runtime_config(key,value) VALUES
 ('sla_assign_minutes','30'),('sla_first_reply_minutes','30'),('sla_quote_followup_hours','24'),
 ('sla_deposit_reminder_days','7'),('sla_aftersale_first_hours','4'),('sla_production_inquiry_days','3'),
 ('escalation_after_breach','"notify_manager"');
DO $crm$
DECLARE t text; r text;
BEGIN
 FOREACH t IN ARRAY ARRAY['crm_document_class','crm_document_sequence','crm_document_registry','crm_document_customer_link','crm_runtime_config'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',t,r); END IF;
  END LOOP;
 END LOOP;
END $crm$;
