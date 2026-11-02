-- Forms key rotation, made safe against overlap and partial failure. A rotation
-- first claims the row (forms_key_rotation_started_at, a lease other rotations
-- wait out) and stores its new private key in forms_pending_private_key_enc,
-- then uploads the public half to Meta and promotes the pending key. If the
-- promote never happens after Meta accepted, the data endpoint still decrypts
-- with the pending key. Both columns stay server-only, like the current key.
ALTER TABLE whatsapp_config ADD COLUMN forms_pending_private_key_enc TEXT;
ALTER TABLE whatsapp_config ADD COLUMN forms_key_rotation_started_at TIMESTAMPTZ;
