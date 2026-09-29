-- Additive: no historical receipt, measurement or instruction is invented.
CREATE TABLE order_evidence (
  id uuid PRIMARY KEY,
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id),
  kind text NOT NULL CHECK(kind IN ('deposit','measurement','dimensions','instruction','installation')),
  data jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX order_evidence_order_idx ON order_evidence(sales_order_id,kind,created_at DESC,id DESC);
CREATE UNIQUE INDEX order_one_instruction_idx ON order_evidence(sales_order_id) WHERE kind='instruction';
CREATE TABLE order_milestone_events (
  id uuid PRIMARY KEY,
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  automatic boolean NOT NULL DEFAULT false,
  basis jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(sales_order_id,to_state),
  CHECK((from_state,to_state) IN (('资料','已报价'),('已报价','已收定金'),('已收定金','已量尺'),('已量尺','生产中'),('生产中','已发货'),('已发货','已安装/完结')))
);
CREATE INDEX order_milestone_order_idx ON order_milestone_events(sales_order_id,created_at DESC,id DESC);
CREATE FUNCTION order_keep_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '订单证据和状态日志不可修改或删除'; END $$;
CREATE TRIGGER order_evidence_immutable BEFORE UPDATE OR DELETE ON order_evidence FOR EACH ROW EXECUTE FUNCTION order_keep_evidence();
CREATE TRIGGER order_milestone_immutable BEFORE UPDATE OR DELETE ON order_milestone_events FOR EACH ROW EXECUTE FUNCTION order_keep_evidence();
ALTER TABLE order_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_milestone_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON order_evidence,order_milestone_events FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON order_evidence,order_milestone_events FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
