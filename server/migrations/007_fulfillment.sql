ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('admin','sales','logistics','technical','factory','coordinator'));
ALTER TABLE purchase_orders ADD COLUMN coordinator_id uuid REFERENCES users(id);
CREATE INDEX purchase_orders_coordinator_idx ON purchase_orders(coordinator_id);

ALTER TABLE production_updates ADD COLUMN review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected'));
ALTER TABLE production_updates ADD COLUMN review_note text NOT NULL DEFAULT '';
ALTER TABLE production_updates ADD COLUMN reviewed_by uuid REFERENCES users(id);
ALTER TABLE production_updates ADD COLUMN reviewed_at timestamptz;
ALTER TABLE production_updates ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE INDEX production_updates_review_idx ON production_updates(purchase_order_id,review_status,stage);

CREATE TABLE rework_tasks(
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  inspection_id uuid NOT NULL REFERENCES quality_inspections(id),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','submitted','closed')),
  factory_note text NOT NULL DEFAULT '',
  review_note text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  submitted_by uuid REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX rework_tasks_order_idx ON rework_tasks(purchase_order_id,status);

CREATE TABLE shipment_packages(
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  label text NOT NULL,
  length_mm numeric(12,2) NOT NULL CHECK(length_mm>0),
  width_mm numeric(12,2) NOT NULL CHECK(width_mm>0),
  height_mm numeric(12,2) NOT NULL CHECK(height_mm>0),
  net_kg numeric(12,3) NOT NULL CHECK(net_kg>=0),
  gross_kg numeric(12,3) NOT NULL CHECK(gross_kg>=net_kg),
  note text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(purchase_order_id,label)
);
CREATE INDEX shipment_packages_order_idx ON shipment_packages(purchase_order_id);
CREATE TABLE shipment_package_items(
  package_id uuid NOT NULL REFERENCES shipment_packages(id),
  purchase_order_item_id uuid NOT NULL REFERENCES purchase_order_items(id),
  quantity integer NOT NULL CHECK(quantity>0),
  PRIMARY KEY(package_id,purchase_order_item_id)
);
CREATE INDEX shipment_package_items_line_idx ON shipment_package_items(purchase_order_item_id);
CREATE TABLE shipments(
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  shipment_number text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','dispatched','received')),
  carrier text NOT NULL,
  tracking_number text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  dispatched_by uuid REFERENCES users(id),
  dispatched_at timestamptz,
  received_by uuid REFERENCES users(id),
  received_at timestamptz,
  receipt_evidence text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX shipments_order_idx ON shipments(purchase_order_id,status);
CREATE TABLE shipment_package_allocations(
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  package_id uuid NOT NULL UNIQUE REFERENCES shipment_packages(id),
  PRIMARY KEY(shipment_id,package_id)
);
