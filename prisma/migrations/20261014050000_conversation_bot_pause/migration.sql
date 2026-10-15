-- Human takeover is a durable conversation flag shared by every responder.
ALTER TABLE conversations ADD COLUMN bot_paused boolean NOT NULL DEFAULT false;
