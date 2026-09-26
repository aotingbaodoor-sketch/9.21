-- Additive only. No guessed dates, partner identities or historical codes.
CREATE TABLE crm_partner_counters (
 join_year integer PRIMARY KEY CHECK(join_year BETWEEN 2026 AND 2049),
 last_value integer NOT NULL CHECK(last_value BETWEEN 1 AND 999)
);
CREATE TABLE crm_partners (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL UNIQUE REFERENCES users(id),
 partner_code text NOT NULL UNIQUE CHECK(partner_code ~ '^[A-HJ-NP-Z][0-9]{3}$' AND right(partner_code,3)<>'000'),
 join_year integer NOT NULL CHECK(join_year BETWEEN 2026 AND 2049),
 assigned_sequence integer NOT NULL CHECK(assigned_sequence BETWEEN 1 AND 999),
 name text NOT NULL CHECK(length(trim(name))>0), market text NOT NULL DEFAULT '',
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(partner_code=substr('ABCDEFGHJKLMNPQRSTUVWXYZ',join_year-2025,1)||lpad(assigned_sequence::text,3,'0')),
 UNIQUE(join_year,assigned_sequence)
);
CREATE TABLE crm_customer_code_counters (
 partner_id uuid NOT NULL REFERENCES crm_partners(id), contact_date date NOT NULL,
 last_value integer NOT NULL CHECK(last_value BETWEEN 1 AND 999),
 PRIMARY KEY(partner_id,contact_date)
);
CREATE TABLE crm_customer_code_ledger (
 customer_id uuid PRIMARY KEY REFERENCES customers(id),
 code text NOT NULL UNIQUE CHECK(code ~ '^[A-HJ-NP-Z][0-9]{12}$'),
 partner_id uuid NOT NULL REFERENCES crm_partners(id), contact_date date NOT NULL,
 assigned_sequence integer NOT NULL CHECK(assigned_sequence BETWEEN 1 AND 999),
 source text NOT NULL CHECK(source IN ('new','legacy_verified','whatsapp_verified')),
 allocated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(partner_id,contact_date,assigned_sequence), UNIQUE(customer_id,code)
);
ALTER TABLE customers ADD COLUMN crm_customer_code text UNIQUE;
ALTER TABLE customers ADD CONSTRAINT customer_code_identity_fk FOREIGN KEY(id,crm_customer_code)
 REFERENCES crm_customer_code_ledger(customer_id,code) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE crm_customer_code_reviews (
 customer_id uuid PRIMARY KEY REFERENCES customers(id),
 reason text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
INSERT INTO crm_customer_code_reviews(customer_id,reason)
 SELECT id,'历史记录：需要核实合伙人身份和首次接触日期，尚未补号' FROM customers;

CREATE FUNCTION crm_keep_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '编号或占号记录不可删除、回收'; END IF;
 IF TG_TABLE_NAME='crm_partners' THEN
  IF (NEW.id,NEW.user_id,NEW.partner_code,NEW.join_year,NEW.assigned_sequence)
    IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.partner_code,OLD.join_year,OLD.assigned_sequence)
    THEN RAISE EXCEPTION '合伙人身份及编号不可修改或复用'; END IF;
 ELSIF TG_TABLE_NAME='customers' THEN
  IF OLD.crm_customer_code IS NOT NULL AND NEW.crm_customer_code IS DISTINCT FROM OLD.crm_customer_code
    THEN RAISE EXCEPTION '客户编号终身固定，不可修改或清除'; END IF;
 ELSIF TG_TABLE_NAME='crm_customer_code_ledger' THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION '客户占号记录不可修改'; END IF;
 ELSE
  IF NEW.last_value < OLD.last_value OR (to_jsonb(NEW)-'last_value') IS DISTINCT FROM (to_jsonb(OLD)-'last_value')
    THEN RAISE EXCEPTION '序号不可回退或更换计数范围'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_partner BEFORE UPDATE OR DELETE ON crm_partners FOR EACH ROW EXECUTE FUNCTION crm_keep_identity();
CREATE TRIGGER immutable_customer_code BEFORE UPDATE OF crm_customer_code ON customers FOR EACH ROW EXECUTE FUNCTION crm_keep_identity();
CREATE TRIGGER immutable_customer_ledger BEFORE UPDATE OR DELETE ON crm_customer_code_ledger FOR EACH ROW EXECUTE FUNCTION crm_keep_identity();
CREATE TRIGGER monotonic_partner_counter BEFORE UPDATE OR DELETE ON crm_partner_counters FOR EACH ROW EXECUTE FUNCTION crm_keep_identity();
CREATE TRIGGER monotonic_customer_counter BEFORE UPDATE OR DELETE ON crm_customer_code_counters FOR EACH ROW EXECUTE FUNCTION crm_keep_identity();

CREATE FUNCTION crm_validate_code_ledger() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE prefix text;
BEGIN
 SELECT partner_code INTO prefix FROM crm_partners WHERE id=NEW.partner_id;
 IF prefix IS NULL OR extract(year FROM NEW.contact_date) NOT BETWEEN 1000 AND 9999 OR
   NEW.code IS DISTINCT FROM prefix||to_char(NEW.contact_date,'YYMMDD')||lpad(NEW.assigned_sequence::text,3,'0') THEN
  RAISE EXCEPTION '客户编号与合伙人、首次接触日期或序号不一致';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_customer_ledger BEFORE INSERT ON crm_customer_code_ledger FOR EACH ROW EXECUTE FUNCTION crm_validate_code_ledger();

CREATE FUNCTION crm_allocate_partner(p_id uuid,p_user uuid,p_year integer,p_name text,p_market text)
 RETURNS crm_partners LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE result crm_partners; n integer;
BEGIN
 PERFORM 1 FROM users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION '员工账号不存在'; END IF;
 SELECT * INTO result FROM crm_partners WHERE user_id=p_user;
 IF FOUND THEN RETURN result; END IF;
 IF p_year IS NULL OR p_year NOT BETWEEN 2026 AND 2049 THEN RAISE EXCEPTION '入职年份超出编码批次范围，请核对'; END IF;
 INSERT INTO crm_partner_counters(join_year,last_value) VALUES(p_year,1)
 ON CONFLICT(join_year) DO UPDATE SET last_value=crm_partner_counters.last_value+1
 WHERE crm_partner_counters.last_value<999 RETURNING last_value INTO n;
 IF n IS NULL THEN RAISE EXCEPTION '本批次合伙人已达999人上限，不可复用或改变格式'; END IF;
 INSERT INTO crm_partners(id,user_id,partner_code,join_year,assigned_sequence,name,market)
 VALUES(p_id,p_user,substr('ABCDEFGHJKLMNPQRSTUVWXYZ',p_year-2025,1)||lpad(n::text,3,'0'),p_year,n,p_name,p_market)
 RETURNING * INTO result;
 RETURN result;
END $$;

CREATE FUNCTION crm_allocate_customer_code(p_customer uuid,p_partner uuid,p_date date,p_source text)
 RETURNS text LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE existing text; prefix text; result text; n integer;
BEGIN
 SELECT crm_customer_code INTO existing FROM customers WHERE id=p_customer FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION '客户不存在'; END IF;
 IF existing IS NOT NULL THEN RETURN existing; END IF;
 IF p_date IS NULL OR extract(year FROM p_date) NOT BETWEEN 1000 AND 9999 THEN
  RAISE EXCEPTION '首次接触日期缺失或无效，需要人工核对'; END IF;
 SELECT partner_code INTO prefix FROM crm_partners WHERE id=p_partner AND active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION '尚未核实有效合伙人身份，不能借用其他人的编码'; END IF;
 INSERT INTO crm_customer_code_counters(partner_id,contact_date,last_value) VALUES(p_partner,p_date,1)
 ON CONFLICT(partner_id,contact_date) DO UPDATE SET last_value=crm_customer_code_counters.last_value+1
 WHERE crm_customer_code_counters.last_value<999 RETURNING last_value INTO n;
 IF n IS NULL THEN RAISE EXCEPTION '同一合伙人当日新客户序号已达999上限，不能改变13位格式'; END IF;
 result=prefix||to_char(p_date,'YYMMDD')||lpad(n::text,3,'0');
 INSERT INTO crm_customer_code_ledger(customer_id,code,partner_id,contact_date,assigned_sequence,source)
 VALUES(p_customer,result,p_partner,p_date,n,p_source);
 UPDATE customers SET crm_customer_code=result WHERE id=p_customer;
 UPDATE crm_customer_code_reviews SET status='resolved',resolved_at=now() WHERE customer_id=p_customer;
 RETURN result;
END $$;

DO $crm$
DECLARE t text; r text;
BEGIN
 FOREACH t IN ARRAY ARRAY['crm_partners','crm_partner_counters','crm_customer_code_counters','crm_customer_code_ledger','crm_customer_code_reviews'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',t,r); END IF;
  END LOOP;
 END LOOP;
END $crm$;
REVOKE ALL ON FUNCTION crm_allocate_partner(uuid,uuid,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_allocate_customer_code(uuid,uuid,date,text) FROM PUBLIC;
