-- Append-only migration. Imported public numbers do not receive permission.
CREATE TABLE whatsapp_contact_policy (
 wa_id text PRIMARY KEY,
 consent_status text NOT NULL DEFAULT 'not_documented' CHECK(consent_status IN ('not_documented','inbound_service','opted_in','revoked')),
 allowed_types jsonb NOT NULL DEFAULT '[]',
 evidence_source text, evidence_text text, consent_at timestamptz,
 verified_by uuid REFERENCES users(id),
 do_not_contact boolean NOT NULL DEFAULT false,
 suppression_reviewed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE whatsapp_permission_events (
 id uuid PRIMARY KEY, wa_id text NOT NULL, customer_id uuid REFERENCES customers(id),
 actor_id uuid REFERENCES users(id), action text NOT NULL, evidence jsonb NOT NULL, event_key text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_permission_events_number_idx ON whatsapp_permission_events(wa_id,created_at);
CREATE TABLE whatsapp_prospect_reviews (
 customer_id uuid PRIMARY KEY REFERENCES customers(id), wa_id text NOT NULL,
 target_confirmed boolean NOT NULL DEFAULT false,
 reviewed_by uuid NOT NULL REFERENCES users(id), reviewed_at timestamptz NOT NULL DEFAULT now(),
 review_note text NOT NULL, profile_hash text NOT NULL
);
CREATE TABLE whatsapp_sales_tasks (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id),
 owner_id uuid NOT NULL REFERENCES users(id), message_id uuid REFERENCES whatsapp_messages(id),
 kind text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','cancelled')),
 title text NOT NULL, evidence text NOT NULL, event_key text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE whatsapp_reception_state (
 conversation_id uuid PRIMARY KEY REFERENCES whatsapp_conversations(id),
 qualification_at timestamptz, human_handoff boolean NOT NULL DEFAULT false
);
-- First-contact attempts are one-shot, across accounts and duplicate requests.
CREATE UNIQUE INDEX whatsapp_first_company_idx ON whatsapp_messages(customer_id) WHERE content->>'purpose'='id_first_contact';
CREATE UNIQUE INDEX whatsapp_first_number_idx ON whatsapp_messages(wa_id) WHERE content->>'purpose'='id_first_contact';
CREATE UNIQUE INDEX whatsapp_auto_reply_event_idx ON whatsapp_messages((content->>'inboundId')) WHERE content->>'purpose'='id_auto_reply';
