ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('admin','sales','logistics','technical'));
CREATE TABLE quotation_settings(id integer PRIMARY KEY CHECK(id=1),data jsonb NOT NULL,version integer NOT NULL DEFAULT 1);
INSERT INTO quotation_settings(id,data) VALUES(1,'{}');
CREATE TABLE quotation_products(id uuid PRIMARY KEY,sku text NOT NULL UNIQUE,data jsonb NOT NULL,version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE quotation_projects(id uuid PRIMARY KEY,customer_id uuid NOT NULL REFERENCES customers(id),name text NOT NULL,created_by uuid NOT NULL REFERENCES users(id),version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX quotation_projects_customer_idx ON quotation_projects(customer_id,created_at DESC);
CREATE TABLE quotation_freight(id uuid PRIMARY KEY,data jsonb NOT NULL,version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE quotation_versions(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES quotation_projects(id),number integer NOT NULL,input jsonb NOT NULL,snapshot jsonb NOT NULL,customer_snapshot jsonb NOT NULL,reason text NOT NULL,previous_total numeric(18,2),status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','issued','confirmed','rejected')),version integer NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),issued_at timestamptz,confirmed_at timestamptz,confirmation jsonb,UNIQUE(project_id,number));
CREATE INDEX quotation_versions_project_idx ON quotation_versions(project_id,number DESC);
CREATE TABLE quotation_files(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES quotation_projects(id),user_id uuid NOT NULL REFERENCES users(id),name text NOT NULL,mime text NOT NULL,bytes_base64 text NOT NULL,sha256 text NOT NULL,kind text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX quotation_files_project_idx ON quotation_files(project_id);
CREATE TABLE quotation_reviews(id uuid PRIMARY KEY,quote_id uuid NOT NULL REFERENCES quotation_versions(id),discipline text NOT NULL CHECK(discipline IN ('admin','technical','logistics','production')),assigned_to uuid REFERENCES users(id),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),comment text NOT NULL DEFAULT '',file_id uuid REFERENCES quotation_files(id),version integer NOT NULL DEFAULT 1,reviewed_by uuid REFERENCES users(id),reviewed_at timestamptz,UNIQUE(quote_id,discipline));
CREATE INDEX quotation_reviews_assigned_idx ON quotation_reviews(assigned_to,status);
CREATE TABLE quotation_orders(id uuid PRIMARY KEY,project_id uuid NOT NULL UNIQUE REFERENCES quotation_projects(id),quote_id uuid NOT NULL UNIQUE REFERENCES quotation_versions(id),snapshot jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE quotation_documents(id uuid PRIMARY KEY,quote_id uuid NOT NULL REFERENCES quotation_versions(id),kind text NOT NULL,language text NOT NULL,bytes_base64 text NOT NULL,sha256 text NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(quote_id,kind,language));
CREATE TABLE quotation_bundles(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),name text NOT NULL,lines jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX quotation_bundles_user_idx ON quotation_bundles(user_id);
-- Content never changes in-place. Status, reviews and customer confirmation are separate workflow fields.
CREATE FUNCTION quotation_immutable_content() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.input IS DISTINCT FROM OLD.input OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.customer_snapshot IS DISTINCT FROM OLD.customer_snapshot OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.number IS DISTINCT FROM OLD.number OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.reason IS DISTINCT FROM OLD.reason THEN RAISE EXCEPTION 'Quotation content is immutable; create a new version'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER quotation_content_guard BEFORE UPDATE ON quotation_versions FOR EACH ROW EXECUTE FUNCTION quotation_immutable_content();
