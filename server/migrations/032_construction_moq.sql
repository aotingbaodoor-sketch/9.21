-- T19 remains quotation_products; JSON is the existing versioned source of truth.
-- Do not silently reclassify legacy SKUs or reinterpret their price units.
ALTER TABLE quotation_products
 ADD COLUMN moq_area numeric GENERATED ALWAYS AS ((data->>'moq_area')::numeric) STORED,
 ADD COLUMN moq_uom text GENERATED ALWAYS AS (data->>'moq_uom') STORED,
 ADD COLUMN door_type text GENERATED ALWAYS AS (data->>'door_type') STORED,
 ADD COLUMN max_h_m numeric GENERATED ALWAYS AS ((data->>'max_h_m')::numeric) STORED,
 ADD COLUMN max_w_m numeric GENERATED ALWAYS AS ((data->>'max_w_m')::numeric) STORED,
 ADD CONSTRAINT product_moq_unit CHECK(moq_uom IS NULL OR moq_uom IN ('㎡','樘','套')),
 ADD CONSTRAINT product_door_type CHECK(door_type IS NULL OR door_type IN ('ENT','INT','SUB','DBL'));
-- T10 maps to existing line snapshots. Unknown historical billing remains NULL.
ALTER TABLE sales_order_items
 ADD COLUMN actual_area numeric GENERATED ALWAYS AS ((configuration_snapshot->>'actual_area')::numeric) STORED,
 ADD COLUMN billing_area numeric GENERATED ALWAYS AS ((configuration_snapshot->>'billing_area')::numeric) STORED,
 ADD COLUMN pieces integer GENERATED ALWAYS AS (quantity) STORED;
ALTER TABLE purchase_order_items
 ADD COLUMN actual_area numeric GENERATED ALWAYS AS ((configuration_snapshot->>'actual_area')::numeric) STORED,
 ADD COLUMN billing_area numeric GENERATED ALWAYS AS ((configuration_snapshot->>'billing_area')::numeric) STORED,
 ADD COLUMN pieces integer GENERATED ALWAYS AS (quantity) STORED;
CREATE VIEW crm_quote_document_lines WITH (security_invoker=true) AS
 SELECT v.id quote_id,l->>'key' line_key,(l->>'actual_area')::numeric actual_area,
 (l->>'billing_area')::numeric billing_area,(l->>'pieces')::integer pieces
 FROM quotation_versions v CROSS JOIN LATERAL jsonb_array_elements(v.snapshot->'lines') l;
