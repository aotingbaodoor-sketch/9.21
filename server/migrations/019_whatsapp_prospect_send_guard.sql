-- Defense in depth while older app instances are still running during a rollout.
-- Research leads must never be sent through the linked-device transport.
CREATE FUNCTION guard_research_whatsapp_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE research boolean; provider_name text; permission whatsapp_contact_policy%ROWTYPE;
BEGIN
 IF NEW.direction <> 'outbound' OR NEW.delivery_status NOT IN ('queued','sending') THEN RETURN NEW; END IF;
 SELECT * INTO permission FROM whatsapp_contact_policy WHERE wa_id=NEW.wa_id;
 IF permission.do_not_contact OR permission.consent_status='revoked' THEN
   RAISE EXCEPTION 'WHATSAPP_RECIPIENT_SUPPRESSED' USING ERRCODE='23514';
 END IF;
 SELECT data ? 'prospecting' INTO research FROM customers WHERE id=NEW.customer_id;
 IF NOT coalesce(research,false) THEN RETURN NEW; END IF;
 SELECT provider INTO provider_name FROM whatsapp_accounts WHERE id=NEW.account_id;
 IF provider_name IS DISTINCT FROM 'cloud' THEN
   RAISE EXCEPTION 'RESEARCH_CONTACT_REQUIRES_OFFICIAL_CLOUD_API' USING ERRCODE='23514';
 END IF;
 IF NEW.message_type='template' THEN
   IF permission.consent_status IS DISTINCT FROM 'opted_in' OR permission.verified_by IS NULL
      OR permission.evidence_source IS NULL OR permission.consent_at IS NULL
      OR NOT permission.allowed_types ? 'marketing' OR NEW.content->>'purpose' IS DISTINCT FROM 'id_first_contact' THEN
     RAISE EXCEPTION 'RESEARCH_MARKETING_CONSENT_AND_CONTROLLED_FIRST_CONTACT_REQUIRED' USING ERRCODE='23514';
   END IF;
 ELSIF NOT EXISTS (SELECT 1 FROM whatsapp_conversations WHERE id=NEW.conversation_id AND last_inbound_at>now()-interval '24 hours') THEN
   RAISE EXCEPTION 'RESEARCH_SERVICE_WINDOW_CLOSED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_whatsapp_queue_guard BEFORE INSERT OR UPDATE ON whatsapp_messages
 FOR EACH ROW EXECUTE FUNCTION guard_research_whatsapp_queue();
