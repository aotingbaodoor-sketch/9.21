-- Confirmation is not payment. Historical sales orders are preserved, not renumbered.
CREATE TABLE quotation_deposits (
 id uuid PRIMARY KEY, quotation_order_id uuid NOT NULL UNIQUE REFERENCES quotation_orders(id),
 document_id uuid NOT NULL UNIQUE REFERENCES crm_document_registry(id),
 data jsonb NOT NULL CHECK((data->>'amount')::numeric>0),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER quotation_deposit_immutable BEFORE UPDATE OR DELETE ON quotation_deposits FOR EACH ROW EXECUTE FUNCTION order_keep_evidence();
ALTER TABLE sales_orders ADD COLUMN registered_document_id uuid UNIQUE REFERENCES crm_document_registry(id);
ALTER TABLE sales_orders ADD COLUMN deposit_gate_required boolean NOT NULL DEFAULT false;
ALTER TABLE sales_orders ALTER COLUMN deposit_gate_required SET DEFAULT true;
ALTER TABLE quotation_deposits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON quotation_deposits FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON quotation_deposits FROM %I',r); END IF;
 END LOOP;
END $$;
CREATE FUNCTION crm_sales_order_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.deposit_gate_required AND NOT EXISTS(SELECT 1 FROM quotation_deposits WHERE quotation_order_id=NEW.quotation_order_id) THEN
  RAISE EXCEPTION '未登记定金到账，禁止开立SO';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.order_number,NEW.quotation_order_id,NEW.registered_document_id,NEW.deposit_gate_required) IS DISTINCT FROM (OLD.order_number,OLD.quotation_order_id,OLD.registered_document_id,OLD.deposit_gate_required) THEN
  RAISE EXCEPTION '销售订单编号及关联不可修改';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_order_deposit_gate BEFORE INSERT OR UPDATE ON sales_orders FOR EACH ROW EXECUTE FUNCTION crm_sales_order_gate();
ALTER TABLE purchase_orders ADD COLUMN deposit_gate_required boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_orders ALTER COLUMN deposit_gate_required SET DEFAULT true;
CREATE FUNCTION crm_purchase_deposit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.deposit_gate_required AND NOT EXISTS(SELECT 1 FROM order_evidence WHERE sales_order_id=NEW.sales_order_id AND kind='deposit' AND (data->>'amount')::numeric>0) THEN
  RAISE EXCEPTION '未登记定金到账，禁止开立PO';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.order_number,NEW.sales_order_id,NEW.deposit_gate_required) IS DISTINCT FROM (OLD.order_number,OLD.sales_order_id,OLD.deposit_gate_required) THEN
  RAISE EXCEPTION '采购订单编号及关联不可修改';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_order_deposit_gate BEFORE INSERT OR UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION crm_purchase_deposit_gate();
