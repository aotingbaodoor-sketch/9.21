-- Additive: existing Cloud API bindings and all business records are retained.
ALTER TABLE whatsapp_accounts ADD COLUMN provider text NOT NULL DEFAULT 'cloud' CHECK(provider IN ('cloud','linked'));
CREATE TABLE whatsapp_linked_sessions (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 account_id uuid REFERENCES whatsapp_accounts(id),
 desired boolean NOT NULL DEFAULT false,
 generation integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'disconnected',
 qr_encrypted text, qr_expires_at timestamptz,
 phone text, error text, heartbeat_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE whatsapp_linked_auth (
 user_id uuid NOT NULL REFERENCES whatsapp_linked_sessions(user_id),
 category text NOT NULL, key_id text NOT NULL, encrypted_value text NOT NULL,
 PRIMARY KEY(user_id,category,key_id)
);
CREATE TABLE whatsapp_linked_events (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES whatsapp_linked_sessions(user_id),
 account_id uuid NOT NULL REFERENCES whatsapp_accounts(id),
 event_key text NOT NULL, encrypted_payload text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, error text,
 created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
 UNIQUE(user_id,event_key)
);
CREATE INDEX whatsapp_linked_pending ON whatsapp_linked_events(created_at) WHERE processed_at IS NULL;
DO $crm$
DECLARE t text; r text;
BEGIN
 FOREACH t IN ARRAY ARRAY['whatsapp_linked_sessions','whatsapp_linked_auth','whatsapp_linked_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
    EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t,r);
   END IF;
  END LOOP;
 END LOOP;
END $crm$;
