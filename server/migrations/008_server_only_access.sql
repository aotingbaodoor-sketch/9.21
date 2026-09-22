-- CRM uses server-side PostgreSQL sessions, not direct browser Data API access.
-- Only known CRM tables are touched; unrelated Supabase tables remain unchanged.
-- The trusted backend connects as table owner. Per-user scope is enforced by the API.
DO $crm$
DECLARE
  table_name text;
  api_role text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'sessions',
    'settings',
    'customers',
    'follow_up_records',
    'notifications',
    'audit_logs',
    'idempotency_keys',
    'import_batches',
    'imported_rows',
    'login_attempts',
    'notification_reads',
    'whatsapp_settings',
    'whatsapp_accounts',
    'whatsapp_identities',
    'whatsapp_conversations',
    'whatsapp_messages',
    'whatsapp_reads',
    'whatsapp_webhook_events',
    'whatsapp_delivery_events',
    'whatsapp_assignments',
    'whatsapp_suggestions',
    'whatsapp_media',
    'whatsapp_alerts',
    'whatsapp_templates',
    'whatsapp_signup_sessions',
    'quotation_settings',
    'quotation_products',
    'quotation_projects',
    'quotation_freight',
    'quotation_versions',
    'quotation_files',
    'quotation_reviews',
    'quotation_orders',
    'quotation_documents',
    'quotation_bundles',
    'factories',
    'sales_orders',
    'sales_order_items',
    'purchase_orders',
    'purchase_order_items',
    'production_updates',
    'production_issues',
    'quality_inspections',
    'factory_users',
    'factory_products',
    'production_media',
    'rework_tasks',
    'shipment_packages',
    'shipment_package_items',
    'shipments',
    'shipment_package_allocations',
    'schema_migrations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH api_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, api_role);
      END IF;
    END LOOP;
  END LOOP;
END
$crm$;
