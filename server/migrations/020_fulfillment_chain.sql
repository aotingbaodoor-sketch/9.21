-- Incremental AUT-DELIVERY-OC-20261004 V2.1. No historical numbers or identities rewritten.
ALTER TABLE crm_document_class ADD COLUMN name_cn text;
ALTER TABLE crm_document_class ADD COLUMN name_en text;
ALTER TABLE crm_document_class ADD COLUMN number_format text;
INSERT INTO crm_document_class(code,family) VALUES('TC','A');
UPDATE crm_document_class d SET name_cn=v.cn,name_en=v.en,number_format=CASE d.family WHEN 'A' THEN '<客户编号>-<类码><序号3>' ELSE '<类码><YYMMDD><流水4>' END
FROM (VALUES
 ('LD','客资 / 询盘线索','Lead'),('TC','技术需求确认单','Technical Requirement Confirmation'),
 ('QT','报价单','Quotation'),('PI','形式发票','Proforma Invoice'),('SC','销售合同','Sales Contract'),
 ('SO','销售订单 / 生产确认单','Sales Order'),('CI','商业发票','Commercial Invoice'),('PL','装箱单','Packing List'),
 ('RC','销售收据','Receipt'),('BP','尾款付款通知单','Balance Payment Notice'),('WO','订单交付工单','Work Order'),
 ('AS','售后工单','After-sales Ticket'),('QC','质量检验记录','Quality Record'),('SM','样板确认单','Sample Confirmation'),
 ('CK','出货点检表','Shipping Checklist'),('PO','采购订单','Purchase Order'),('SA','供货协议','Supply Agreement'),
 ('GR','收货 / 入库单','Goods Receipt'),('AR','收款单','Accounts Receivable'),('AP','付款申请','Accounts Payable'),
 ('EX','费用报销单','Expense Claim'),('FA','加盟协议','Franchise Agreement'),('DA','经销 / 代理协议','Distribution Agreement'),
 ('MO','生产指令单','Manufacturing Order')) v(code,cn,en) WHERE d.code=v.code;
ALTER TABLE crm_document_class ALTER COLUMN name_cn SET NOT NULL, ALTER COLUMN name_en SET NOT NULL, ALTER COLUMN number_format SET NOT NULL;

CREATE TABLE crm_fulfillment_stage (
 code text PRIMARY KEY, ordinal integer NOT NULL UNIQUE CHECK(ordinal BETWEEN 1 AND 22),
 name_cn text NOT NULL, visibility text NOT NULL CHECK(visibility IN ('required','notify','none')),
 owner_role text NOT NULL, applicable_when jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO crm_fulfillment_stage(code,ordinal,name_cn,visibility,owner_role) VALUES
 ('deposit_confirmed',1,'定金到账确认','none','FIN'),('wo_issued',2,'工单下达','none','SCM'),
 ('po_issued',3,'采购订单下达','none','SCM'),('material_ready',4,'原材料备齐 / IQC','required','SCM'),
 ('in_production',5,'投产','required','SCM'),('sample_approved',6,'样板确认','required','SAL'),
 ('production_done',7,'完工质检 / FQC','none','SCM'),('packed',8,'包装完成','required','SCM'),
 ('shipment_checked',9,'出货点检','none','SCM'),('forwarder_assigned',10,'货代指定与提货安排','none','SCM'),
 ('picked_up',11,'厂内交货 / 提货离厂','notify','SCM'),('loaded',12,'装柜 / 内陆运输至装运港','none','SCM'),
 ('export_cleared',13,'出口报关放行','none','SCM'),('shipped',14,'装船 / 提单签发','none','SCM'),
 ('departed',15,'已发运 / 离港','required','SCM'),('arrived',16,'到港','notify','SCM'),
 ('dest_cleared',17,'目的港清关放行','none','SCM'),('balance_settled',18,'尾款结清','none','FIN'),
 ('delivered',19,'客户签收 / POD','notify','SAL'),('accepted',20,'客户验收确认','none','SAL'),
 ('warranty_started',21,'供应商质保起算','none','SCM'),('closed',22,'工单关闭','none','SCM');
UPDATE crm_fulfillment_stage SET applicable_when='{"trade_term_not":"EXW"}' WHERE code='loaded';

CREATE TABLE crm_work_orders (
 id uuid PRIMARY KEY, document_id uuid NOT NULL UNIQUE REFERENCES crm_document_registry(id),
 sales_order_id uuid NOT NULL UNIQUE REFERENCES sales_orders(id), customer_id uuid NOT NULL REFERENCES customers(id),
 customer_code text NOT NULL CHECK(customer_code ~ '^[A-HJ-NP-Z][0-9]{12}$'),
 order_type text NOT NULL CHECK(order_type IN ('sample','bulk','replacement')),
 expected_delivery date NOT NULL, trade_term text NOT NULL CHECK(trade_term IN ('FOB','EXW')),
 confirmation_file_id uuid NOT NULL REFERENCES quotation_files(id),
 receipt_document_id uuid NOT NULL REFERENCES crm_document_registry(id),
 sales_owner uuid NOT NULL REFERENCES users(id), scm_owner uuid REFERENCES users(id),
 current_stage text NOT NULL REFERENCES crm_fulfillment_stage(code),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1
);
CREATE INDEX crm_work_orders_customer_idx ON crm_work_orders(customer_id,created_at);
CREATE TABLE crm_order_progress (
 work_order_id uuid NOT NULL REFERENCES crm_work_orders(id), stage_code text NOT NULL REFERENCES crm_fulfillment_stage(code),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','n/a')),
 is_applicable boolean NOT NULL DEFAULT true, skip_reason text, skipped_by uuid REFERENCES users(id), skipped_on timestamptz,
 completed_at timestamptz, completed_by uuid REFERENCES users(id), evidence_id uuid,
 PRIMARY KEY(work_order_id,stage_code),
 CHECK((status='n/a' AND NOT is_applicable AND length(trim(skip_reason))>0 AND skipped_by IS NOT NULL AND skipped_on IS NOT NULL)
 OR (status<>'n/a' AND is_applicable)),
 CHECK(status<>'completed' OR (completed_at IS NOT NULL AND completed_by IS NOT NULL))
);
ALTER TABLE purchase_orders ADD COLUMN work_order_id uuid REFERENCES crm_work_orders(id);
ALTER TABLE purchase_orders ADD COLUMN work_order_required boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_orders ALTER COLUMN work_order_required SET DEFAULT true;
CREATE FUNCTION crm_po_work_order_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.work_order_required AND NOT EXISTS(
  SELECT 1 FROM crm_work_orders w WHERE w.id=NEW.work_order_id AND w.sales_order_id=NEW.sales_order_id
 ) THEN RAISE EXCEPTION 'G-10: 无对应的已签发工单不得开立PO'; END IF;
 IF TG_OP='UPDATE' AND (NEW.work_order_id,NEW.work_order_required) IS DISTINCT FROM (OLD.work_order_id,OLD.work_order_required)
 THEN RAISE EXCEPTION 'PO工单关联与历史标记不可修改'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_po_wo_gate BEFORE INSERT OR UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION crm_po_work_order_gate();
CREATE INDEX purchase_orders_wo_idx ON purchase_orders(work_order_id);
CREATE TABLE crm_manufacturing_orders (
 id uuid PRIMARY KEY, document_id uuid NOT NULL UNIQUE REFERENCES crm_document_registry(id),
 work_order_id uuid NOT NULL REFERENCES crm_work_orders(id), purchase_order_id uuid NOT NULL UNIQUE REFERENCES purchase_orders(id),
 customer_id uuid NOT NULL REFERENCES customers(id), customer_code text NOT NULL,
 technical_snapshot jsonb NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crm_fulfillment_events (
 id uuid PRIMARY KEY, work_order_id uuid NOT NULL REFERENCES crm_work_orders(id),
 from_stage text REFERENCES crm_fulfillment_stage(code), to_stage text NOT NULL REFERENCES crm_fulfillment_stage(code),
 actor_id uuid NOT NULL REFERENCES users(id), basis jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_fulfillment_events_wo_idx ON crm_fulfillment_events(work_order_id,at);
CREATE TABLE crm_logistics_doc_type (
 code text PRIMARY KEY, name_cn text NOT NULL, stage_code text NOT NULL REFERENCES crm_fulfillment_stage(code), required boolean NOT NULL
);
INSERT INTO crm_logistics_doc_type VALUES
 ('pickup_receipt','提货签收单','picked_up',true),('packing_evidence','装箱照片 / 装箱单','picked_up',true),
 ('export_release','出口报关放行单','export_cleared',true),('bl_copy','提单副本','shipped',true),
 ('departure_notice','离港通知','departed',true),('arrival_notice','到港通知','arrived',true),
 ('destination_release','目的港清关放行单','dest_cleared',false),('pod','客户签收单 POD','delivered',true);
CREATE TABLE crm_logistics_documents (
 id uuid PRIMARY KEY, work_order_id uuid NOT NULL REFERENCES crm_work_orders(id), customer_id uuid NOT NULL REFERENCES customers(id),
 doc_type text NOT NULL REFERENCES crm_logistics_doc_type(code), file_id uuid NOT NULL REFERENCES quotation_files(id),
 source_name text NOT NULL CHECK(length(trim(source_name))>0), received_on timestamptz NOT NULL,
 check_result text NOT NULL DEFAULT 'pending' CHECK(check_result IN ('pending','matched','mismatch')),
 checked_by uuid REFERENCES users(id), checked_at timestamptz,
 external_no text NOT NULL DEFAULT '', created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(work_order_id,doc_type,file_id), CHECK(check_result='pending' OR (checked_by IS NOT NULL AND checked_at IS NOT NULL))
);
CREATE INDEX crm_logistics_documents_wo_idx ON crm_logistics_documents(work_order_id,doc_type,check_result);
CREATE TABLE crm_fulfillment_notice_drafts (
 id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES crm_fulfillment_events(id), work_order_id uuid NOT NULL REFERENCES crm_work_orders(id),
 customer_id uuid NOT NULL REFERENCES customers(id), content text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','cancelled','sent')), created_at timestamptz NOT NULL DEFAULT now()
);
-- New MO meaning is stored with new records. No update to old registry or old documents.
CREATE FUNCTION crm_chain_identity_check() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r crm_document_registry; c text; w crm_work_orders; p purchase_orders;
BEGIN
 SELECT * INTO r FROM crm_document_registry WHERE id=NEW.document_id;
 SELECT crm_customer_code INTO c FROM customers WHERE id=NEW.customer_id;
 IF c IS NULL OR c IS DISTINCT FROM NEW.customer_code OR r.customer_id IS DISTINCT FROM NEW.customer_id THEN
  RAISE EXCEPTION 'G-18: 单据客户关联不一致';
 END IF;
 IF TG_TABLE_NAME='crm_work_orders' THEN
  IF r.class_code<>'WO' OR NOT EXISTS(SELECT 1 FROM sales_orders so JOIN quotation_orders qo ON qo.id=so.quotation_order_id
   JOIN quotation_projects qp ON qp.id=qo.project_id WHERE so.id=NEW.sales_order_id AND qp.customer_id=NEW.customer_id) THEN
   RAISE EXCEPTION 'G-18: 工单订单关联不一致';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM sales_orders so JOIN quotation_deposits qd ON qd.quotation_order_id=so.quotation_order_id
   WHERE so.id=NEW.sales_order_id AND qd.document_id=NEW.receipt_document_id) THEN
   RAISE EXCEPTION 'G-11: 工单收款凭证不属于关联订单';
  END IF;
 ELSE
  SELECT * INTO w FROM crm_work_orders WHERE id=NEW.work_order_id;
  SELECT * INTO p FROM purchase_orders WHERE id=NEW.purchase_order_id;
  IF r.class_code<>'MO' OR w.customer_id IS DISTINCT FROM NEW.customer_id OR p.work_order_id IS DISTINCT FROM w.id
   OR p.sales_order_id IS DISTINCT FROM w.sales_order_id THEN RAISE EXCEPTION 'G-14/G-18: 生产指令三键不一致'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_wo_identity BEFORE INSERT ON crm_work_orders FOR EACH ROW EXECUTE FUNCTION crm_chain_identity_check();
CREATE TRIGGER crm_mo_identity BEFORE INSERT ON crm_manufacturing_orders FOR EACH ROW EXECUTE FUNCTION crm_chain_identity_check();
CREATE TRIGGER crm_mo_immutable BEFORE UPDATE OR DELETE ON crm_manufacturing_orders FOR EACH ROW EXECUTE FUNCTION crm_keep_document_registry();
CREATE TRIGGER crm_events_immutable BEFORE UPDATE OR DELETE ON crm_fulfillment_events FOR EACH ROW EXECUTE FUNCTION crm_keep_document_registry();
CREATE FUNCTION crm_wo_keep_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['current_stage','version','scm_owner']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['current_stage','version','scm_owner']) THEN
  RAISE EXCEPTION '已签发工单的编号、客户、订单与原定交期不可覆盖；须走变更审批';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_wo_immutable_identity BEFORE UPDATE OR DELETE ON crm_work_orders FOR EACH ROW EXECUTE FUNCTION crm_wo_keep_identity();
CREATE INDEX crm_mo_work_order_idx ON crm_manufacturing_orders(work_order_id);
CREATE INDEX crm_mo_customer_idx ON crm_manufacturing_orders(customer_id);
CREATE INDEX crm_wo_scm_owner_idx ON crm_work_orders(scm_owner);
CREATE INDEX crm_notice_work_order_idx ON crm_fulfillment_notice_drafts(work_order_id);
-- All new tables remain server-only, exactly like existing CRM tables.
DO $secure$
DECLARE t text; r text;
BEGIN
 FOREACH t IN ARRAY ARRAY['crm_fulfillment_stage','crm_work_orders','crm_order_progress','crm_manufacturing_orders','crm_fulfillment_events','crm_logistics_doc_type','crm_logistics_documents','crm_fulfillment_notice_drafts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',t,r); END IF;
  END LOOP;
 END LOOP;
END $secure$;
