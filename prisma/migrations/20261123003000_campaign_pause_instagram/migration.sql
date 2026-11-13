-- Campaigns: pause a sending broadcast, and Instagram broadcasts.
--
-- broadcasts.status gains 'paused': a member pauses a sending campaign, the
-- dispatcher stops between recipients and leaves the rest pending; Resume
-- puts it back to 'sending' and queues the next pass. The check is widened
-- only; existing rows are unaffected.
--
-- broadcasts.channel: 'whatsapp' (template campaigns, every existing row) or
-- 'instagram' (a free-text message to contacts whose 24-hour Instagram window
-- is open; the window is checked again before every send). message_text holds
-- the Instagram message. broadcast_recipients.conversation_id is the Instagram
-- conversation a recipient is sent through (NULL for WhatsApp rows).
--
-- Additive: new nullable/defaulted columns covered by the existing grants and
-- row-level security of both tables.
SET LOCAL lock_timeout = '5s';

ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_status_check; -- additive-exception: re-added below with 'paused'; widens the allowed set only
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled', 'paused')) NOT VALID;
ALTER TABLE broadcasts VALIDATE CONSTRAINT broadcasts_status_check;

ALTER TABLE broadcasts
  ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'instagram')),
  ADD COLUMN message_text text CHECK (message_text IS NULL OR char_length(message_text) <= 1000),
  ADD COLUMN paused_at timestamptz;

ALTER TABLE broadcast_recipients ADD COLUMN conversation_id uuid;
ALTER TABLE broadcast_recipients ADD CONSTRAINT broadcast_recipients_conversation_id_fkey
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE SET NULL (conversation_id) NOT VALID;
