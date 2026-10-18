-- Additive TC versions and binding. Existing documents/identities remain byte-for-byte intact.
CREATE TABLE technical_confirmation (
 id uuid PRIMARY KEY, series_id uuid NOT NULL, document_id uuid NOT NULL REFERENCES crm_document_registry(id),
 project_id uuid NOT NULL REFERENCES quotation_projects(id), customer_id uuid NOT NULL REFERENCES customers(id),
 tc_no text NOT NULL, version integer NOT NULL CHECK(version>0), technical jsonb NOT NULL, business jsonb NOT NULL,
 reason text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(series_id,version), UNIQUE(tc_no,version)
);
CREATE INDEX tc_project_idx ON technical_confirmation(project_id,created_at);
CREATE TABLE technical_confirmation_signatures (
 tc_id uuid PRIMARY KEY REFERENCES technical_confirmation(id), file_id uuid NOT NULL REFERENCES quotation_files(id),
 signer_name text NOT NULL, signed_on date NOT NULL, verified_by uuid NOT NULL REFERENCES users(id), verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE technical_quote_bindings (
 quote_id uuid PRIMARY KEY REFERENCES quotation_versions(id), tc_id uuid NOT NULL REFERENCES technical_confirmation(id),
 bound_by uuid NOT NULL REFERENCES users(id), bound_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE technical_commercial_documents (
 document_id uuid PRIMARY KEY REFERENCES quotation_documents(id), registry_id uuid NOT NULL REFERENCES crm_document_registry(id),
 tc_id uuid NOT NULL REFERENCES technical_confirmation(id), attachment_no text NOT NULL
);
CREATE TABLE crm_manufacturing_drafts (
 id uuid PRIMARY KEY, work_order_id uuid NOT NULL REFERENCES crm_work_orders(id), purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
 source_tc_id uuid NOT NULL REFERENCES technical_confirmation(id), technical jsonb NOT NULL, production jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE crm_manufacturing_orders DROP CONSTRAINT crm_manufacturing_orders_purchase_order_id_key;
ALTER TABLE crm_manufacturing_orders ADD COLUMN source_tc_id uuid REFERENCES technical_confirmation(id);
ALTER TABLE crm_manufacturing_orders ADD COLUMN source_tc_no text;
ALTER TABLE crm_manufacturing_orders ADD COLUMN source_tc_version integer;
ALTER TABLE crm_manufacturing_orders ADD COLUMN consistency_checked_on timestamptz;
ALTER TABLE crm_manufacturing_orders ADD COLUMN consistency_result jsonb;
ALTER TABLE crm_manufacturing_orders ADD COLUMN draft_id uuid UNIQUE REFERENCES crm_manufacturing_drafts(id);
CREATE INDEX mo_tc_idx ON crm_manufacturing_orders(source_tc_id);
CREATE INDEX mo_po_idx ON crm_manufacturing_orders(purchase_order_id);
CREATE FUNCTION crm_tc_mo_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tc technical_confirmation; line jsonb; original jsonb; used numeric;
BEGIN
 SELECT * INTO tc FROM technical_confirmation WHERE id=NEW.source_tc_id;
 IF tc.id IS NULL OR tc.customer_id<>NEW.customer_id OR tc.tc_no IS DISTINCT FROM NEW.source_tc_no
 OR tc.version IS DISTINCT FROM NEW.source_tc_version OR NOT EXISTS(SELECT 1 FROM technical_confirmation_signatures WHERE tc_id=tc.id)
 OR NEW.consistency_checked_on IS NULL OR NEW.consistency_result->>'result' IS DISTINCT FROM 'matched'
 THEN RAISE EXCEPTION 'G-44: MO缺少真实已确认源TC及一致性检查'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('tc:'||tc.series_id::text,0));
 IF EXISTS(SELECT 1 FROM technical_confirmation WHERE series_id=tc.series_id AND version>tc.version)
 THEN RAISE EXCEPTION 'G-44: 源TC已升版'; END IF;
 IF jsonb_typeof(NEW.technical_snapshot->'tcTechnical'->'items') IS DISTINCT FROM 'array'
 OR jsonb_array_length(NEW.technical_snapshot->'tcTechnical'->'items')=0 THEN RAISE EXCEPTION 'G-44: 缺少技术明细'; END IF;
 FOR line IN SELECT value FROM jsonb_array_elements(NEW.technical_snapshot->'tcTechnical'->'items') LOOP
  SELECT value INTO original FROM jsonb_array_elements(tc.technical->'items') WHERE value->>'lineKey'=line->>'lineKey';
  IF original IS NULL OR original-'quantity' IS DISTINCT FROM line-'quantity' OR (line->>'quantity')::numeric<=0
  THEN RAISE EXCEPTION 'G-44: 技术明细与源TC不一致'; END IF;
  SELECT COALESCE(sum((i->>'quantity')::numeric),0) INTO used FROM crm_manufacturing_orders m JOIN technical_confirmation v ON v.id=m.source_tc_id CROSS JOIN LATERAL jsonb_array_elements(m.technical_snapshot->'tcTechnical'->'items') i WHERE v.series_id=tc.series_id AND i->>'lineKey'=line->>'lineKey';
  IF used+(line->>'quantity')::numeric>(original->>'quantity')::numeric THEN RAISE EXCEPTION 'G-44: TC累计生产数量超限'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_mo_tc_gate BEFORE INSERT ON crm_manufacturing_orders FOR EACH ROW EXECUTE FUNCTION crm_tc_mo_insert_gate();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['technical_confirmation','technical_confirmation_signatures','technical_quote_bindings','technical_commercial_documents'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION crm_keep_document_registry()',t||'_immutable',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['technical_confirmation','technical_confirmation_signatures','technical_quote_bindings','technical_commercial_documents','crm_manufacturing_drafts'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
