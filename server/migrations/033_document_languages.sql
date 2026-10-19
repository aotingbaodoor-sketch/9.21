CREATE TABLE doc_lang_policy(
 id uuid PRIMARY KEY,audience text NOT NULL CHECK(audience IN ('F','C','I','L')),country_code text NOT NULL,
 doc_class text NOT NULL,lang_set jsonb NOT NULL,primary_lang text NOT NULL DEFAULT 'zh' CHECK(primary_lang='zh'),
 effective_from date NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(audience,country_code,doc_class,effective_from));
CREATE TABLE term_glossary(
 id uuid PRIMARY KEY,term_zh text NOT NULL,term_en text,term_ru text,term_ar text,scope text NOT NULL,
 locked boolean NOT NULL DEFAULT true,approved_by uuid NOT NULL REFERENCES users(id),approved_on timestamptz NOT NULL DEFAULT now());
CREATE TABLE translation_registry(
 id uuid PRIMARY KEY,quote_id uuid NOT NULL REFERENCES quotation_versions(id),doc_class text NOT NULL,doc_no text,
 lang text NOT NULL CHECK(lang IN ('en','ru','ar')),source_hash text NOT NULL,translated_by text NOT NULL,
 reviewed_by uuid REFERENCES users(id),issued_on timestamptz,status text NOT NULL CHECK(status IN ('pending','issued','expired','revoked')),
 body text NOT NULL,evidence text NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX translation_lookup ON translation_registry(quote_id,doc_class,lang,source_hash,status);
CREATE TABLE logistics_declarations(
 id uuid PRIMARY KEY,zh text NOT NULL,en text NOT NULL,ru text NOT NULL,ar text NOT NULL,
 evidence text NOT NULL,approved_by uuid NOT NULL REFERENCES users(id),approved_on timestamptz NOT NULL DEFAULT now());
ALTER TABLE quotation_documents ADD COLUMN language_snapshot jsonb;
ALTER TABLE doc_lang_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE term_glossary ENABLE ROW LEVEL SECURITY;
ALTER TABLE translation_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_declarations ENABLE ROW LEVEL SECURITY;
-- Immutable issued human translations: revoke or register a fresh version, never rewrite text.
CREATE FUNCTION protect_translation_text() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.body<>OLD.body OR NEW.source_hash<>OLD.source_hash OR NEW.quote_id<>OLD.quote_id OR NEW.lang<>OLD.lang OR NEW.doc_class<>OLD.doc_class THEN RAISE EXCEPTION 'Translation content is immutable; register a new version';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER translation_text_immutable BEFORE UPDATE ON translation_registry FOR EACH ROW EXECUTE FUNCTION protect_translation_text();
CREATE FUNCTION expire_translation_on_tc_binding() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 UPDATE translation_registry SET status='expired' WHERE quote_id=NEW.quote_id AND status IN ('pending','issued');
 RETURN NEW;END$$;
CREATE TRIGGER translation_tc_source_changed AFTER INSERT OR UPDATE ON technical_quote_bindings FOR EACH ROW EXECUTE FUNCTION expire_translation_on_tc_binding();
