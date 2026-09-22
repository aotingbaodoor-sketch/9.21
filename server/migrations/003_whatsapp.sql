-- 增量升级：不删除或重置任何现有客户、账号、跟进。
ALTER TABLE customers ADD COLUMN wa_id text;
ALTER TABLE customers ADD COLUMN first_contact_at timestamptz;
ALTER TABLE customers ADD COLUMN last_contact_at timestamptz;
ALTER TABLE customers ADD COLUMN wa_first_receiver_id uuid REFERENCES users(id);
ALTER TABLE customers ADD COLUMN wa_received_phone_id text;
ALTER TABLE customers ADD COLUMN wa_needs_assignment boolean NOT NULL DEFAULT false;
CREATE INDEX customers_wa_id_idx ON customers(wa_id) WHERE wa_id IS NOT NULL;
CREATE INDEX customers_wa_phone_idx ON customers((regexp_replace(data->>'whatsapp','[^0-9]','','g')));
CREATE INDEX customers_phone_normalized_idx ON customers((regexp_replace(data->>'phone','[^0-9]','','g')));

CREATE TABLE whatsapp_settings (
 id integer PRIMARY KEY CHECK(id=1), data jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
 last_verified_at timestamptz, last_received_at timestamptz, signature_failures integer NOT NULL DEFAULT 0
);
INSERT INTO whatsapp_settings(id,data) VALUES(1,'{"reassignmentPolicy":"keep","reminderMinutes":[30,120,1440]}');
CREATE TABLE whatsapp_accounts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), waba_id text NOT NULL,
 phone_number_id text NOT NULL UNIQUE, display_phone_number text NOT NULL,
 country_calling_code text NOT NULL DEFAULT '', verified_name text NOT NULL DEFAULT '',
 connection_status text NOT NULL DEFAULT 'connected' CHECK(connection_status IN ('connected','error','disconnected')),
 token_reference text, token_encrypted text, credential_version integer NOT NULL DEFAULT 1,
 connected_at timestamptz NOT NULL DEFAULT now(), last_webhook_at timestamptz, last_checked_at timestamptz,
 subscription_status text NOT NULL DEFAULT 'unknown', last_error_code text, last_error text,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(token_reference IS NOT NULL OR token_encrypted IS NOT NULL OR connection_status='disconnected')
);
CREATE UNIQUE INDEX whatsapp_accounts_number_idx ON whatsapp_accounts((regexp_replace(display_phone_number,'[^0-9]','','g')));
CREATE INDEX whatsapp_accounts_user_idx ON whatsapp_accounts(user_id);
CREATE TABLE whatsapp_identities (
 wa_id text PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_identities_customer_idx ON whatsapp_identities(customer_id);
CREATE TABLE whatsapp_conversations (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES whatsapp_accounts(id), customer_id uuid NOT NULL REFERENCES customers(id),
 wa_id text NOT NULL, first_receiver_id uuid NOT NULL REFERENCES users(id),
 conflict boolean NOT NULL DEFAULT false, conflict_reason text,
 last_inbound_at timestamptz, last_outbound_at timestamptz, first_message_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,wa_id)
);
CREATE INDEX whatsapp_conversations_customer_idx ON whatsapp_conversations(customer_id);
CREATE INDEX whatsapp_conversations_conflict_idx ON whatsapp_conversations(conflict) WHERE conflict;
CREATE TABLE whatsapp_messages (
 id uuid PRIMARY KEY, whatsapp_message_id text UNIQUE,
 conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id), customer_id uuid NOT NULL REFERENCES customers(id),
 owner_id uuid NOT NULL REFERENCES users(id), requested_by_id uuid REFERENCES users(id),
 account_id uuid NOT NULL REFERENCES whatsapp_accounts(id), phone_number_id text NOT NULL, wa_id text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')), message_type text NOT NULL,
 text_content text NOT NULL DEFAULT '', media_id text, media_mime_type text, media_filename text,
 reply_to_message_id text, content jsonb NOT NULL DEFAULT '{}', message_timestamp timestamptz NOT NULL,
 delivery_status text NOT NULL, error_code text, error_message text,
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz,
 sent_at timestamptz, delivered_at timestamptz, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_messages_conversation_time_idx ON whatsapp_messages(conversation_id,message_timestamp,id);
CREATE INDEX whatsapp_messages_customer_idx ON whatsapp_messages(customer_id,message_timestamp DESC);
CREATE INDEX whatsapp_messages_worker_idx ON whatsapp_messages(available_at) WHERE delivery_status='queued';
CREATE INDEX whatsapp_messages_account_idx ON whatsapp_messages(account_id);
CREATE TABLE whatsapp_reads (
 conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id), user_id uuid NOT NULL REFERENCES users(id),
 read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE whatsapp_webhook_events (
 id uuid PRIMARY KEY, event_key text NOT NULL UNIQUE, payload_encrypted text NOT NULL,
 status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, error_code text, error_message text,
 received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX whatsapp_webhook_queue_idx ON whatsapp_webhook_events(available_at) WHERE status IN ('pending','retry','processing');
CREATE TABLE whatsapp_delivery_events (
 event_key text PRIMARY KEY, phone_number_id text NOT NULL, whatsapp_message_id text NOT NULL,
 local_message_id text, wa_id text, status text NOT NULL, event_at timestamptz NOT NULL, error_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_delivery_message_idx ON whatsapp_delivery_events(whatsapp_message_id);
CREATE TABLE whatsapp_assignments (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), from_user_id uuid REFERENCES users(id),
 to_user_id uuid NOT NULL REFERENCES users(id), actor_id uuid REFERENCES users(id),
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_assignments_customer_idx ON whatsapp_assignments(customer_id,created_at);
CREATE TABLE whatsapp_suggestions (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), message_id uuid NOT NULL REFERENCES whatsapp_messages(id),
 field text NOT NULL, value text NOT NULL, evidence text NOT NULL, method text NOT NULL DEFAULT 'rule',
 status text NOT NULL DEFAULT 'pending', reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz,
 UNIQUE(message_id,field,value)
);
CREATE INDEX whatsapp_suggestions_customer_idx ON whatsapp_suggestions(customer_id,status);
CREATE TABLE whatsapp_media (
 message_id uuid PRIMARY KEY REFERENCES whatsapp_messages(id), content_base64 text, mime_type text,
 sha256 text, size_bytes integer, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), error_message text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE whatsapp_alerts (
 id uuid PRIMARY KEY, account_id uuid REFERENCES whatsapp_accounts(id), event_key text NOT NULL UNIQUE,
 title text NOT NULL, code text NOT NULL, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE whatsapp_templates (
 account_id uuid NOT NULL REFERENCES whatsapp_accounts(id), template_id text NOT NULL, name text NOT NULL,
 language text NOT NULL, status text NOT NULL, category text NOT NULL, components jsonb NOT NULL DEFAULT '[]',
 synced_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,template_id)
);
CREATE TABLE whatsapp_signup_sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
