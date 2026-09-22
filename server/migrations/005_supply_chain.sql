CREATE TABLE factories(
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  contact jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE sales_orders(
  id uuid PRIMARY KEY,
  quotation_order_id uuid NOT NULL UNIQUE REFERENCES quotation_orders(id),
  order_number text NOT NULL UNIQUE,
  status text NOT NULL CHECK(status IN ('confirmed','drawing','purchasing','production','quality','ready_to_ship','shipped','closed','cancelled')) DEFAULT 'confirmed',
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sales_order_items(
  id uuid PRIMARY KEY,
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id),
  line_key text NOT NULL,
  configuration_snapshot jsonb NOT NULL,
  quantity integer NOT NULL CHECK(quantity > 0),
  version integer NOT NULL DEFAULT 1,
  UNIQUE(sales_order_id,line_key)
);
CREATE INDEX sales_order_items_order_idx ON sales_order_items(sales_order_id);
CREATE TABLE purchase_orders(
  id uuid PRIMARY KEY,
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id),
  factory_id uuid NOT NULL REFERENCES factories(id),
  order_number text NOT NULL UNIQUE,
  status text NOT NULL CHECK(status IN ('draft','sent','accepted','in_production','quality_hold','ready','shipped','cancelled')) DEFAULT 'draft',
  promised_date date,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sales_order_id,factory_id,order_number)
);
CREATE INDEX purchase_orders_factory_status_idx ON purchase_orders(factory_id,status,updated_at DESC) WHERE status NOT IN ('shipped','cancelled');
CREATE TABLE purchase_order_items(
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  sales_order_item_id uuid NOT NULL REFERENCES sales_order_items(id),
  quantity integer NOT NULL CHECK(quantity > 0),
  drawing_file_id uuid REFERENCES quotation_files(id),
  configuration_snapshot jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  UNIQUE(purchase_order_id,sales_order_item_id)
);
CREATE TABLE production_updates(
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  stage text NOT NULL CHECK(stage IN ('order_confirmed','drawing_confirmed','materials','cutting','machining','surface_treatment','assembly','glass','hardware','testing','quality','packing','ready_to_ship','shipped')),
  planned_at timestamptz,
  actual_at timestamptz,
  quantity integer NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  note text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_updates_order_stage_idx ON production_updates(purchase_order_id,created_at DESC);
CREATE TABLE production_issues(
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  severity text NOT NULL CHECK(severity IN ('low','medium','high','critical')),
  status text NOT NULL CHECK(status IN ('open','mitigating','resolved','rejected')) DEFAULT 'open',
  description text NOT NULL,
  resolution text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  raised_by uuid NOT NULL REFERENCES users(id),
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX production_issues_open_idx ON production_issues(purchase_order_id,created_at DESC) WHERE status IN ('open','mitigating');
CREATE TABLE quality_inspections(
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  status text NOT NULL CHECK(status IN ('pending','passed','failed','conditional')) DEFAULT 'pending',
  checklist jsonb NOT NULL DEFAULT '[]',
  evidence jsonb NOT NULL DEFAULT '[]',
  note text NOT NULL DEFAULT '',
  inspected_by uuid NOT NULL REFERENCES users(id),
  inspected_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX quality_inspections_order_idx ON quality_inspections(purchase_order_id,inspected_at DESC);
