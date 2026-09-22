ALTER TABLE factory_products ADD COLUMN image_ids jsonb NOT NULL DEFAULT '[]';
CREATE TABLE factory_product_images (
  id uuid PRIMARY KEY,
  factory_product_id uuid NOT NULL REFERENCES factory_products(id),
  name text NOT NULL,
  mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
  bytes_base64 text NOT NULL,
  sha256 text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX factory_product_images_product_idx ON factory_product_images(factory_product_id);
CREATE INDEX factory_product_images_user_idx ON factory_product_images(uploaded_by);
ALTER TABLE factory_product_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON factory_product_images FROM PUBLIC;
DO $crm$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON factory_product_images FROM anon; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON factory_product_images FROM authenticated; END IF;
END
$crm$;
