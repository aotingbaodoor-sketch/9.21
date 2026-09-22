ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('admin','sales','logistics','technical','factory'));

CREATE TABLE factory_users(
  factory_id uuid NOT NULL REFERENCES factories(id),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  status text NOT NULL DEFAULT 'approved' CHECK(status IN ('invited','approved','suspended')),
  is_primary boolean NOT NULL DEFAULT false,
  invited_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(factory_id,user_id)
);
CREATE INDEX factory_users_factory_status_idx ON factory_users(factory_id,status);

CREATE TABLE factory_products(
  id uuid PRIMARY KEY,
  factory_id uuid NOT NULL REFERENCES factories(id),
  sku text NOT NULL,
  name_zh text NOT NULL,
  name_en text NOT NULL DEFAULT '',
  category text NOT NULL,
  series text NOT NULL DEFAULT '',
  specification text NOT NULL DEFAULT '',
  image_urls jsonb NOT NULL DEFAULT '[]',
  supply_price numeric(16,2) NOT NULL CHECK(supply_price >= 0),
  currency text NOT NULL DEFAULT 'CNY' CHECK(currency ~ '^[A-Z]{3}$'),
  pricing_method text NOT NULL,
  pricing_rule jsonb NOT NULL DEFAULT '{}',
  lead_days integer NOT NULL DEFAULT 0 CHECK(lead_days BETWEEN 0 AND 1000),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','disabled')),
  review_note text NOT NULL DEFAULT '',
  approved_product_id uuid REFERENCES quotation_products(id),
  created_by uuid NOT NULL REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(factory_id,sku)
);
CREATE INDEX factory_products_factory_status_idx ON factory_products(factory_id,status,updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX factory_products_review_queue_idx ON factory_products(status,submitted_at) WHERE status='submitted' AND deleted_at IS NULL;

ALTER TABLE purchase_orders ADD COLUMN factory_confirmed_at timestamptz;
ALTER TABLE purchase_orders ADD COLUMN factory_confirmed_by uuid REFERENCES users(id);
ALTER TABLE purchase_orders ADD COLUMN factory_confirmed_price numeric(16,2) CHECK(factory_confirmed_price >= 0);
ALTER TABLE purchase_orders ADD COLUMN factory_confirmation_note text NOT NULL DEFAULT '';

CREATE TABLE production_media(
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  production_update_id uuid REFERENCES production_updates(id),
  kind text NOT NULL CHECK(kind IN ('photo','video','document')),
  name text NOT NULL,
  mime text NOT NULL,
  bytes_base64 text NOT NULL,
  sha256 text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_media_order_idx ON production_media(purchase_order_id,created_at DESC);
