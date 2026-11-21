SET LOCAL lock_timeout = '5s';

-- Batch 7: contact duplicate finder and merge. Additive.
-- contact_duplicate_dismissals: a pair an admin marked "Not duplicates". The pair is stored once, lower id first,
--   and is never offered again. It goes away with either contact (FK cascade).
-- crm_merge_contacts(keep, merged, apply): merges one contact into another in the caller's transaction (withTenant).
--   The workspace comes from the tenant setting (app.account_id), never from an argument, and only an admin or owner
--   may call it (app.account_role, set from the live membership). Many contact tables are append-only or worker-only
--   for the app role, so the move runs SECURITY DEFINER with every statement filtered by the workspace.
--   apply=false checks and counts only (the confirm sheet); apply=true, after the same checks:
--     * takes the Instagram sender locks of both contacts' identities (same lock as ingest and staff link/unlink),
--       then locks both contacts FOR UPDATE in id order, then their conversations in id order;
--     * refuses: not_found, invalid_request (same contact), phone_conflict (two different WhatsApp numbers or user
--       ids; a contact holds one), identity_conflict (both on the same Instagram account), contact_busy (an active
--       flow run, a queued inbound action, a sequence step being sent, or a scheduled reply sending or unknown);
--     * resolves unique clashes (tags, lists, customer groups, wishlist, price nudges, campaign recipients, email
--       preferences, referral code, referral as buyer, open stock alerts, sequence subscriptions, custom values);
--     * folds the merged contact's WhatsApp conversation into the kept one on the same number (messages, reactions
--       and every row pointing at the conversation move; finished scheduled replies and deleted notes, which their
--       guards keep fixed, go with the old conversation);
--     * moves every other row that points at the merged contact: every FK to contacts found in the catalog, plus the
--       log tables without an FK (domain events included); Instagram identities get a contact_identity_links 'link' row so they can be unlinked;
--     * fills the kept contact's blank fields from the merged one; consent keeps the stricter (an opt-out or block on
--       either wins); deletes the merged contact; writes one audit_logs row (ids and counts only).
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261207020000_contact_merge.

CREATE TABLE contact_duplicate_dismissals (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_low_id uuid NOT NULL,
  contact_high_id uuid NOT NULL,
  dismissed_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, contact_low_id, contact_high_id),
  CHECK (contact_low_id < contact_high_id),
  FOREIGN KEY (account_id, contact_low_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, contact_high_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);
CREATE INDEX contact_duplicate_dismissals_high_idx ON contact_duplicate_dismissals (account_id, contact_high_id);

ALTER TABLE contact_duplicate_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_duplicate_dismissals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON contact_duplicate_dismissals FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
-- Permanent: admins record a dismissal; nobody updates or deletes one (contact deletes cascade).
CREATE POLICY admin_insert ON contact_duplicate_dismissals FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT ON contact_duplicate_dismissals TO bodhinox_app;

CREATE FUNCTION crm_merge_contacts(p_keep uuid, p_merged uuid, p_apply boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acc uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  actor uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  k contacts%ROWTYPE;
  m contacts%ROWTYPE;
  r record;
  r2 record;
  counts jsonb;
  moved_identities uuid[];
BEGIN
  IF acc IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'crm_merge_contacts: tenant required' USING ERRCODE = '42501'; END IF;
  IF COALESCE(NULLIF(current_setting('app.account_role', true), ''), '') NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'crm_merge_contacts: admin required' USING ERRCODE = '42501';
  END IF;
  -- FORCE RLS binds the owner too: an owner without superuser or BYPASSRLS would see none of the merged contact's
  -- rows, move nothing and then cascade-delete them with the contact. Refuse instead of losing data.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'crm_merge_contacts: function owner needs BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  IF p_keep IS NULL OR p_merged IS NULL OR p_keep = p_merged THEN RETURN jsonb_build_object('error', 'invalid_request'); END IF;

  IF p_apply THEN
    -- Same order as ingest and staff link/unlink: Instagram sender locks, then contact rows, then conversations.
    FOR r IN SELECT DISTINCT lower(instagram_account_id::text) AS ia, external_id FROM contact_channel_identities
      WHERE account_id = acc AND contact_id IN (p_keep, p_merged) ORDER BY 1, 2 LOOP
      PERFORM pg_advisory_xact_lock(hashtext('igsid:' || r.ia || ':' || r.external_id));
    END LOOP;
    PERFORM 1 FROM contacts WHERE account_id = acc AND id IN (p_keep, p_merged) ORDER BY id FOR UPDATE;
    PERFORM 1 FROM conversations WHERE account_id = acc AND contact_id IN (p_keep, p_merged) ORDER BY id FOR UPDATE;
  END IF;

  SELECT * INTO k FROM contacts WHERE account_id = acc AND id = p_keep;
  SELECT * INTO m FROM contacts WHERE account_id = acc AND id = p_merged;
  IF k.id IS NULL OR m.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  -- One WhatsApp number per contact: the same number written with or without a trunk 0 is the same number.
  IF k.phone_normalized <> '' AND m.phone_normalized <> '' AND NOT (k.phone_normalized = m.phone_normalized OR EXISTS (
      SELECT 1 FROM generate_series(1, 3) cc
      WHERE (substr(k.phone_normalized, cc + 1, 1) = '0' AND left(k.phone_normalized, cc) || substr(k.phone_normalized, cc + 2) = m.phone_normalized)
         OR (substr(m.phone_normalized, cc + 1, 1) = '0' AND left(m.phone_normalized, cc) || substr(m.phone_normalized, cc + 2) = k.phone_normalized)))
    OR (k.wa_user_id IS NOT NULL AND m.wa_user_id IS NOT NULL AND k.wa_user_id <> m.wa_user_id) THEN
    RETURN jsonb_build_object('error', 'phone_conflict');
  END IF;

  -- Like a staff link: a contact holds at most one identity (and conversation) per Instagram account.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT instagram_account_id FROM contact_channel_identities WHERE account_id = acc AND contact_id = p_merged
      UNION SELECT instagram_account_id FROM conversations WHERE account_id = acc AND contact_id = p_merged AND channel = 'instagram'
    ) mi JOIN (
      SELECT instagram_account_id FROM contact_channel_identities WHERE account_id = acc AND contact_id = p_keep
      UNION SELECT instagram_account_id FROM conversations WHERE account_id = acc AND contact_id = p_keep AND channel = 'instagram'
    ) ki ON ki.instagram_account_id = mi.instagram_account_id) THEN
    RETURN jsonb_build_object('error', 'identity_conflict');
  END IF;

  -- Work in flight on the merged contact would be orphaned or sent twice: wait for it to finish.
  IF EXISTS (SELECT 1 FROM flow_runs WHERE account_id = acc AND status = 'active' AND (contact_id = p_merged
        OR conversation_id IN (SELECT id FROM conversations WHERE account_id = acc AND contact_id = p_merged)))
    OR EXISTS (SELECT 1 FROM jobs WHERE tenant_id = acc AND type = 'inbound.actions' AND status IN ('pending', 'running')
        AND payload->>'conversationId' IN (SELECT id::text FROM conversations WHERE account_id = acc AND contact_id = p_merged))
    OR EXISTS (SELECT 1 FROM sequence_subscriptions WHERE account_id = acc AND contact_id = p_merged AND status = 'sending')
    OR EXISTS (SELECT 1 FROM scheduled_replies WHERE account_id = acc AND status IN ('sending', 'unknown')
        AND conversation_id IN (SELECT id FROM conversations WHERE account_id = acc AND contact_id = p_merged)) THEN
    RETURN jsonb_build_object('error', 'contact_busy');
  END IF;

  counts := jsonb_build_object(
    'conversations', (SELECT count(*) FROM conversations WHERE account_id = acc AND contact_id = p_merged),
    'messages', (SELECT count(*) FROM messages WHERE account_id = acc
      AND conversation_id IN (SELECT id FROM conversations WHERE account_id = acc AND contact_id = p_merged)),
    'tags', (SELECT count(*) FROM contact_tags t WHERE t.account_id = acc AND t.contact_id = p_merged
      AND NOT EXISTS (SELECT 1 FROM contact_tags x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.tag_id = t.tag_id)),
    'notes', (SELECT count(*) FROM contact_notes WHERE account_id = acc AND contact_id = p_merged),
    'orders', (SELECT count(*) FROM orders WHERE account_id = acc AND contact_id = p_merged),
    'deals', (SELECT count(*) FROM deals WHERE account_id = acc AND contact_id = p_merged),
    'appointments', (SELECT count(*) FROM appointments WHERE account_id = acc AND contact_id = p_merged),
    'payments', (SELECT count(*) FROM payment_links WHERE account_id = acc AND contact_id = p_merged),
    'formAnswers', (SELECT count(*) FROM whatsapp_form_responses WHERE account_id = acc AND contact_id = p_merged),
    'sequences', (SELECT count(*) FROM sequence_subscriptions WHERE account_id = acc AND contact_id = p_merged),
    'customValues', (SELECT count(*) FROM contact_custom_values v WHERE v.account_id = acc AND v.contact_id = p_merged
      AND COALESCE(btrim(v.value), '') <> '' AND NOT EXISTS (SELECT 1 FROM contact_custom_values x WHERE x.account_id = acc
        AND x.contact_id = p_keep AND x.custom_field_id = v.custom_field_id AND COALESCE(btrim(x.value), '') <> '')),
    'identities', (SELECT count(*) FROM contact_channel_identities WHERE account_id = acc AND contact_id = p_merged),
    'lists', (SELECT count(*) FROM contact_list_members l WHERE l.account_id = acc AND l.contact_id = p_merged
      AND NOT EXISTS (SELECT 1 FROM contact_list_members x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.list_id = l.list_id)),
    'tasks', (SELECT count(*) FROM tasks WHERE account_id = acc AND contact_id = p_merged),
    'combinedConversations', (SELECT count(*) FROM conversations mc JOIN conversations kc ON kc.account_id = acc
      AND kc.contact_id = p_keep AND kc.channel = 'whatsapp' AND kc.whatsapp_config_id IS NOT DISTINCT FROM mc.whatsapp_config_id
      WHERE mc.account_id = acc AND mc.contact_id = p_merged AND mc.channel = 'whatsapp'));
  IF NOT p_apply THEN RETURN jsonb_build_object('counts', counts); END IF;

  -- ---------------------------------------------------------------- unique clashes on the contact
  DELETE FROM contact_duplicate_dismissals WHERE account_id = acc AND (contact_low_id = p_merged OR contact_high_id = p_merged);
  DELETE FROM contact_tags t WHERE t.account_id = acc AND t.contact_id = p_merged
    AND EXISTS (SELECT 1 FROM contact_tags x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.tag_id = t.tag_id);
  -- Custom values: the kept contact's value stays; a blank one is filled from the merged contact.
  UPDATE contact_custom_values kv SET value = mv.value FROM contact_custom_values mv
    WHERE kv.account_id = acc AND kv.contact_id = p_keep AND mv.account_id = acc AND mv.contact_id = p_merged
      AND mv.custom_field_id = kv.custom_field_id AND COALESCE(btrim(kv.value), '') = '' AND COALESCE(btrim(mv.value), '') <> '';
  DELETE FROM contact_custom_values v WHERE v.account_id = acc AND v.contact_id = p_merged
    AND EXISTS (SELECT 1 FROM contact_custom_values x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.custom_field_id = v.custom_field_id);
  DELETE FROM contact_list_members l WHERE l.account_id = acc AND l.contact_id = p_merged
    AND EXISTS (SELECT 1 FROM contact_list_members x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.list_id = l.list_id);
  DELETE FROM shop_customer_group_members g WHERE g.account_id = acc AND g.contact_id = p_merged
    AND EXISTS (SELECT 1 FROM shop_customer_group_members x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.group_id = g.group_id);
  DELETE FROM shop_wishlist_items w WHERE w.account_id = acc AND w.contact_id = p_merged
    AND EXISTS (SELECT 1 FROM shop_wishlist_items x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.variant_id = w.variant_id);
  DELETE FROM shop_price_nudges n WHERE n.account_id = acc AND n.contact_id = p_merged
    AND EXISTS (SELECT 1 FROM shop_price_nudges x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.drop_id = n.drop_id);
  DELETE FROM shop_email_recipients e WHERE e.account_id = acc AND e.contact_id = p_merged
    AND EXISTS (SELECT 1 FROM shop_email_recipients x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.campaign_id = e.campaign_id);
  -- Email preferences: an unsubscribe on either wins (the earliest is kept); a missing opt-in is filled.
  UPDATE shop_email_prefs kp SET unsubscribed_at = LEAST(kp.unsubscribed_at, mp.unsubscribed_at),
      opted_in_at = COALESCE(kp.opted_in_at, mp.opted_in_at),
      opt_in_source = CASE WHEN kp.opted_in_at IS NULL THEN mp.opt_in_source ELSE kp.opt_in_source END,
      opted_in_by = CASE WHEN kp.opted_in_at IS NULL THEN mp.opted_in_by ELSE kp.opted_in_by END, updated_at = now()
    FROM shop_email_prefs mp WHERE kp.account_id = acc AND kp.contact_id = p_keep AND mp.account_id = acc AND mp.contact_id = p_merged;
  DELETE FROM shop_email_prefs p WHERE p.account_id = acc AND p.contact_id = p_merged
    AND EXISTS (SELECT 1 FROM shop_email_prefs x WHERE x.account_id = acc AND x.contact_id = p_keep);
  DELETE FROM shop_referral_codes c WHERE c.account_id = acc AND c.contact_id = p_merged AND c.kind = 'contact'
    AND EXISTS (SELECT 1 FROM shop_referral_codes x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.kind = 'contact');
  DELETE FROM shop_referrals s WHERE s.account_id = acc AND s.buyer_contact_id = p_merged
    AND EXISTS (SELECT 1 FROM shop_referrals x WHERE x.account_id = acc AND x.buyer_contact_id = p_keep);
  UPDATE shop_stock_alerts a SET closed_at = now(), skip_reason = 'merged'
    WHERE a.account_id = acc AND a.contact_id = p_merged AND a.closed_at IS NULL
      AND EXISTS (SELECT 1 FROM shop_stock_alerts x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.closed_at IS NULL
        AND x.variant_id = a.variant_id);
  -- Sequences: the kept subscription stays; an unsubscribe on the merged contact ends the kept one too.
  UPDATE sequence_subscriptions ks SET status = 'unsubscribed', ended_at = now(), next_due_at = NULL, updated_at = now()
    FROM sequence_subscriptions ms
    WHERE ks.account_id = acc AND ks.contact_id = p_keep AND ks.status = 'active'
      AND ms.account_id = acc AND ms.contact_id = p_merged AND ms.sequence_id = ks.sequence_id AND ms.status = 'unsubscribed';
  DELETE FROM sequence_subscriptions s WHERE s.account_id = acc AND s.contact_id = p_merged
    AND EXISTS (SELECT 1 FROM sequence_subscriptions x WHERE x.account_id = acc AND x.contact_id = p_keep AND x.sequence_id = s.sequence_id);
  -- A buyer signed in as the merged contact signs in again (a wrong merge must not open the kept contact's orders).
  DELETE FROM shop_customer_sessions WHERE account_id = acc AND contact_id = p_merged;

  -- ---------------------------------------------------------------- WhatsApp conversations on the same number
  FOR r IN SELECT mc.id AS mid, kc.id AS kid, mc.unread_count AS m_unread, mc.last_message_at AS m_last_at,
      mc.last_message_text AS m_last_text
    FROM conversations mc JOIN conversations kc ON kc.account_id = acc AND kc.contact_id = p_keep AND kc.channel = 'whatsapp'
      AND kc.whatsapp_config_id IS NOT DISTINCT FROM mc.whatsapp_config_id
    WHERE mc.account_id = acc AND mc.contact_id = p_merged AND mc.channel = 'whatsapp' LOOP
    DELETE FROM messages x WHERE x.account_id = acc AND x.conversation_id = r.mid AND x.message_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM messages y WHERE y.account_id = acc AND y.conversation_id = r.kid AND y.message_id = x.message_id);
    -- Reactions point at (conversation, message): both move in one statement so the key holds at its end.
    WITH rx AS (UPDATE message_reactions SET conversation_id = r.kid WHERE account_id = acc AND conversation_id = r.mid RETURNING 1)
    UPDATE messages SET conversation_id = r.kid WHERE account_id = acc AND conversation_id = r.mid;
    UPDATE ai_assessments SET superseded_at = now() WHERE account_id = acc AND conversation_id = r.mid AND superseded_at IS NULL
      AND EXISTS (SELECT 1 FROM ai_assessments x WHERE x.account_id = acc AND x.conversation_id = r.kid AND x.superseded_at IS NULL);
    UPDATE conversation_reminders c SET status = 'cancelled' WHERE c.account_id = acc AND c.conversation_id = r.mid
      AND c.kind = 'snooze' AND c.status = 'pending' AND EXISTS (SELECT 1 FROM conversation_reminders x WHERE x.account_id = acc
        AND x.conversation_id = r.kid AND x.user_id = c.user_id AND x.kind = 'snooze' AND x.status = 'pending');
    DELETE FROM away_message_sends a WHERE a.account_id = acc AND a.conversation_id = r.mid
      AND EXISTS (SELECT 1 FROM away_message_sends x WHERE x.account_id = acc AND x.conversation_id = r.kid AND x.window_key = a.window_key);
    DELETE FROM conversation_label_links l WHERE l.account_id = acc AND l.conversation_id = r.mid
      AND EXISTS (SELECT 1 FROM conversation_label_links x WHERE x.account_id = acc AND x.conversation_id = r.kid AND x.label_id = l.label_id);
    DELETE FROM conversation_favourites f WHERE f.account_id = acc AND f.conversation_id = r.mid
      AND EXISTS (SELECT 1 FROM conversation_favourites x WHERE x.account_id = acc AND x.conversation_id = r.kid AND x.user_id = f.user_id);
    -- Guards keep a finished scheduled reply and a deleted note fixed; those stay with the old conversation and go with it.
    UPDATE scheduled_replies SET conversation_id = r.kid WHERE account_id = acc AND conversation_id = r.mid AND status = 'pending';
    UPDATE conversation_notes SET conversation_id = r.kid WHERE account_id = acc AND conversation_id = r.mid AND deleted_at IS NULL;
    UPDATE flow_tracked_links SET conversation_id = r.kid WHERE account_id = acc AND conversation_id = r.mid;
    FOR r2 IN SELECT DISTINCT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'public.conversations'::regclass AND a.attname <> 'account_id'
          AND c.conrelid NOT IN ('public.messages'::regclass, 'public.message_reactions'::regclass,
            'public.scheduled_replies'::regclass, 'public.conversation_notes'::regclass) LOOP
      EXECUTE format('UPDATE %s SET %I = $1 WHERE account_id = $2 AND %I = $3', r2.tbl, r2.col, r2.col) USING r.kid, acc, r.mid;
    END LOOP;
    UPDATE conversations SET unread_count = COALESCE(unread_count, 0) + COALESCE(r.m_unread, 0),
        last_message_at = CASE WHEN r.m_last_at > last_message_at OR last_message_at IS NULL THEN r.m_last_at ELSE last_message_at END,
        last_message_text = CASE WHEN r.m_last_at > last_message_at OR last_message_at IS NULL THEN r.m_last_text ELSE last_message_text END
      WHERE account_id = acc AND id = r.kid;
    DELETE FROM conversations WHERE account_id = acc AND id = r.mid;
  END LOOP;

  -- ---------------------------------------------------------------- every other row of the merged contact
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO moved_identities FROM contact_channel_identities
    WHERE account_id = acc AND contact_id = p_merged;
  FOR r IN SELECT DISTINCT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'public.contacts'::regclass AND a.attname <> 'account_id' LOOP
    EXECUTE format('UPDATE %s SET %I = $1 WHERE account_id = $2 AND %I = $3', r.tbl, r.col, r.col) USING p_keep, acc, p_merged;
  END LOOP;
  -- Logs that name a contact without an FK. contact_identity_links is history and keeps its ids.
  UPDATE ai_reply_events SET contact_id = p_keep WHERE account_id = acc AND contact_id = p_merged;
  UPDATE conversion_event_log SET contact_id = p_keep WHERE account_id = acc AND contact_id = p_merged;
  UPDATE flow_tracked_links SET contact_id = p_keep WHERE account_id = acc AND contact_id = p_merged;
  UPDATE sequence_message_sends SET contact_id = p_keep WHERE account_id = acc AND contact_id = p_merged;
  UPDATE domain_events SET contact_id = p_keep WHERE account_id = acc AND contact_id = p_merged;
  UPDATE domain_events SET subject_id = p_keep WHERE account_id = acc AND subject_kind = 'contact' AND subject_id = p_merged;
  -- Each moved Instagram identity is recorded like a staff link, so it can be unlinked again.
  INSERT INTO contact_identity_links (account_id, identity_id, from_contact_id, to_contact_id, kind, basis, note, decided_by_user_id)
    SELECT acc, i, p_merged, p_keep, 'link', 'staff_decision', NULL, actor FROM unnest(moved_identities) i;

  -- ---------------------------------------------------------------- the kept contact
  -- The merged contact's unique number and ids are released first, so the kept contact can take them.
  UPDATE contacts SET phone = '', wa_user_id = NULL WHERE account_id = acc AND id = p_merged;
  UPDATE contacts SET
      name = COALESCE(NULLIF(btrim(k.name), ''), m.name),
      email = COALESCE(NULLIF(btrim(k.email), ''), m.email),
      company = COALESCE(NULLIF(btrim(k.company), ''), m.company),
      city = COALESCE(NULLIF(btrim(k.city), ''), m.city),
      avatar_url = COALESCE(NULLIF(btrim(k.avatar_url), ''), m.avatar_url),
      owner_id = COALESCE(k.owner_id, m.owner_id),
      phone = CASE WHEN k.phone_normalized = '' THEN m.phone ELSE k.phone END,
      wa_user_id = COALESCE(k.wa_user_id, m.wa_user_id),
      wa_parent_user_id = COALESCE(k.wa_parent_user_id, m.wa_parent_user_id),
      wa_username = COALESCE(k.wa_username, m.wa_username),
      opted_out_at = COALESCE(k.opted_out_at, m.opted_out_at),
      opt_out_source = CASE WHEN k.opted_out_at IS NOT NULL THEN k.opt_out_source ELSE m.opt_out_source END,
      opted_in_at = COALESCE(k.opted_in_at, m.opted_in_at),
      opt_in_source = CASE WHEN k.opted_in_at IS NOT NULL THEN k.opt_in_source ELSE m.opt_in_source END,
      blocked_at = COALESCE(k.blocked_at, m.blocked_at),
      instagram_opted_out_at = COALESCE(k.instagram_opted_out_at, m.instagram_opted_out_at),
      instagram_opted_in_at = COALESCE(k.instagram_opted_in_at, m.instagram_opted_in_at),
      created_at = LEAST(k.created_at, m.created_at)
    WHERE account_id = acc AND id = p_keep;
  DELETE FROM contacts WHERE account_id = acc AND id = p_merged;

  -- Ids and counts only: no names, numbers or emails in the audit log.
  INSERT INTO audit_logs (account_id, user_id, action, resource_id, metadata)
    VALUES (acc, actor, 'contact.merged', p_keep::text, jsonb_build_object('merged_contact_id', p_merged, 'counts', counts));
  RETURN jsonb_build_object('counts', counts);
END $$;
REVOKE ALL ON FUNCTION crm_merge_contacts(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_merge_contacts(uuid, uuid, boolean) TO bodhinox_app;
