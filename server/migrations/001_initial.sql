CREATE TABLE users (
 id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','sales')), active boolean NOT NULL DEFAULT true,
 avatar text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), csrf text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE settings (id integer PRIMARY KEY CHECK(id=1), data jsonb NOT NULL, version integer NOT NULL DEFAULT 1);
INSERT INTO settings VALUES(1, '{"name":"奥汀堡CRM","company":"佛山奥汀堡建材公司","timezone":"Asia/Shanghai","cycles":{"A":1,"B":3,"C":7,"D":30}}', 1);
CREATE TABLE customers (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), company text NOT NULL,
 grade text NOT NULL CHECK(grade IN ('A','B','C','D')), stage text NOT NULL, data jsonb NOT NULL DEFAULT '{}',
 next_follow_up date NOT NULL, last_follow_up timestamptz, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 won_at timestamptz, version integer NOT NULL DEFAULT 1
);
CREATE INDEX customers_owner_due_idx ON customers(owner_id, next_follow_up) WHERE deleted_at IS NULL;
CREATE INDEX customers_due_idx ON customers(next_follow_up, grade) WHERE deleted_at IS NULL;
CREATE INDEX customers_company_idx ON customers(lower(company));
CREATE INDEX customers_email_idx ON customers(lower(data->>'email'));
CREATE TABLE follow_up_records (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), user_id uuid NOT NULL REFERENCES users(id),
 method text NOT NULL, content text NOT NULL, response text NOT NULL DEFAULT '', plan text NOT NULL DEFAULT '',
 follow_up_at timestamptz NOT NULL DEFAULT now(), next_follow_up date NOT NULL
);
CREATE INDEX followups_customer_time_idx ON follow_up_records(customer_id, follow_up_at DESC);
CREATE INDEX followups_user_time_idx ON follow_up_records(user_id, follow_up_at DESC);
CREATE TABLE notifications (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), customer_id uuid NOT NULL REFERENCES customers(id),
 kind text NOT NULL, title text NOT NULL, event_key text NOT NULL UNIQUE, due_date date,
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_customer_idx ON notifications(customer_id);
CREATE TABLE audit_logs (
 id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), action text NOT NULL, entity_id text,
 details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_time_idx ON audit_logs(created_at DESC);
CREATE TABLE idempotency_keys (
 user_id uuid NOT NULL REFERENCES users(id), key uuid NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,key)
);
CREATE TABLE import_batches (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), rows jsonb NOT NULL, committed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE imported_rows (fingerprint text PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), batch_id uuid NOT NULL REFERENCES import_batches(id));
CREATE TABLE login_attempts (key text PRIMARY KEY, count integer NOT NULL, until_at timestamptz NOT NULL);
