-- Additive settlement controls. No existing amounts, credentials or identities are changed.
CREATE TABLE crm_fulfillment_approvers (
 id integer PRIMARY KEY CHECK(id=1), finance_user_id uuid REFERENCES users(id), release_user_id uuid REFERENCES users(id),
 updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO crm_fulfillment_approvers(id) VALUES(1); -- Missing approvers must block, never auto-approve.
CREATE TABLE crm_order_payment_terms (
 work_order_id uuid PRIMARY KEY REFERENCES crm_work_orders(id), method text NOT NULL CHECK(method IN ('A','B','C')),
 customer_forwarder boolean NOT NULL, bill_type text NOT NULL CHECK(bill_type IN ('to_order','telex','named','seaway')),
 deposit_percent numeric(5,2) NOT NULL CHECK(deposit_percent BETWEEN 30 AND 100),
 contract_file_id uuid NOT NULL REFERENCES quotation_files(id), repeat_file_id uuid REFERENCES quotation_files(id),
 named_consent_file_id uuid REFERENCES quotation_files(id), guarantee_file_id uuid REFERENCES quotation_files(id),
 bl_draft_file_id uuid REFERENCES quotation_files(id), bl_checks jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(customer_forwarder=(method='C')), CHECK(method<>'B' OR repeat_file_id IS NOT NULL),
 CHECK(method<>'C' OR bill_type IN ('to_order','named')),
 CHECK(bill_type<>'named' OR named_consent_file_id IS NOT NULL)
);
CREATE TABLE crm_order_receipts (
 id uuid PRIMARY KEY, document_id uuid NOT NULL UNIQUE REFERENCES crm_document_registry(id),
 work_order_id uuid NOT NULL REFERENCES crm_work_orders(id), amount numeric(18,2) NOT NULL CHECK(amount>0),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), bank_reference text NOT NULL UNIQUE,
 file_id uuid NOT NULL REFERENCES quotation_files(id), received_at timestamptz NOT NULL,
 confirmed_by uuid NOT NULL REFERENCES users(id), confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_order_receipts_wo_idx ON crm_order_receipts(work_order_id);
CREATE TABLE crm_order_forwarders (
 work_order_id uuid PRIMARY KEY REFERENCES crm_work_orders(id), source text NOT NULL CHECK(source IN ('customer_nominated','we_arranged')),
 company text NOT NULL, contact text NOT NULL, channel text NOT NULL, pickup_at timestamptz NOT NULL,
 port text NOT NULL, vehicle text NOT NULL, driver text NOT NULL, file_id uuid NOT NULL REFERENCES quotation_files(id),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crm_document_releases (
 work_order_id uuid PRIMARY KEY REFERENCES crm_work_orders(id), release_type text NOT NULL CHECK(release_type IN ('original_bl','telex','delivery_permit')),
 file_id uuid NOT NULL REFERENCES quotation_files(id), released_by uuid NOT NULL REFERENCES users(id),
 released_at timestamptz NOT NULL DEFAULT now(), settlement_snapshot jsonb NOT NULL
);
CREATE FUNCTION crm_release_settlement_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE due numeric; curr text; paid numeric; deposit jsonb; stage_n integer;
BEGIN
 SELECT (v.snapshot->>'total')::numeric,v.input->>'currency',d.data,s.ordinal INTO due,curr,deposit,stage_n
 FROM crm_work_orders w JOIN sales_orders so ON so.id=w.sales_order_id JOIN quotation_orders qo ON qo.id=so.quotation_order_id
 JOIN quotation_versions v ON v.id=qo.quote_id JOIN quotation_deposits d ON d.quotation_order_id=qo.id
 JOIN crm_fulfillment_stage s ON s.code=w.current_stage WHERE w.id=NEW.work_order_id;
 SELECT coalesce(sum(amount),0) INTO paid FROM crm_order_receipts WHERE work_order_id=NEW.work_order_id AND currency=curr;
 IF deposit->>'currency'=curr THEN paid:=paid+(deposit->>'amount')::numeric; END IF;
 IF due IS NULL OR due<=0 OR paid<due OR stage_n<14 OR NOT EXISTS(SELECT 1 FROM crm_order_payment_terms WHERE work_order_id=NEW.work_order_id)
 THEN RAISE EXCEPTION 'G-12: 未结清或未核实装船，禁止释放提货凭证'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_release_gate BEFORE INSERT ON crm_document_releases FOR EACH ROW EXECUTE FUNCTION crm_release_settlement_gate();
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['crm_order_payment_terms','crm_order_receipts','crm_order_forwarders','crm_document_releases'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION crm_keep_document_registry()',t||'_immutable',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['crm_fulfillment_approvers','crm_order_payment_terms','crm_order_receipts','crm_order_forwarders','crm_document_releases'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
  END LOOP;
 END LOOP;
END $$;
