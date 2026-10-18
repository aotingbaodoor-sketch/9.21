-- Additive, immutable originals, rasterized redactions, approvals and MO attachment versions.
CREATE TABLE technical_drawings (
 id uuid PRIMARY KEY, tc_id uuid NOT NULL REFERENCES technical_confirmation(id), line_keys jsonb NOT NULL,
 name text NOT NULL, mime text NOT NULL, original_base64 text NOT NULL, sha256 text NOT NULL,
 pages jsonb NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX technical_drawings_tc_idx ON technical_drawings(tc_id);
CREATE TABLE technical_drawing_redactions (
 id uuid PRIMARY KEY, drawing_id uuid NOT NULL REFERENCES technical_drawings(id), version int NOT NULL CHECK(version>0),
 rectangles jsonb NOT NULL, pages jsonb NOT NULL, sha256 text NOT NULL, reason text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(drawing_id,version)
);
CREATE TABLE technical_drawing_reviews (
 redaction_id uuid PRIMARY KEY REFERENCES technical_drawing_redactions(id), approved boolean NOT NULL,
 reviewed_by uuid NOT NULL REFERENCES users(id), reviewed_at timestamptz NOT NULL DEFAULT now(), note text NOT NULL, checks jsonb NOT NULL
);
CREATE TABLE technical_mo_drawings (
 id uuid PRIMARY KEY, mo_id uuid NOT NULL REFERENCES crm_manufacturing_orders(id), redaction_id uuid NOT NULL REFERENCES technical_drawing_redactions(id),
 linked_by uuid NOT NULL REFERENCES users(id),linked_at timestamptz NOT NULL DEFAULT now(), UNIQUE(mo_id,redaction_id)
);
CREATE INDEX technical_mo_drawings_mo_idx ON technical_mo_drawings(mo_id,linked_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['technical_drawings','technical_drawing_redactions','technical_drawing_reviews','technical_mo_drawings'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION crm_keep_document_registry()',t||'_immutable',t);
 END LOOP;
END $$;
