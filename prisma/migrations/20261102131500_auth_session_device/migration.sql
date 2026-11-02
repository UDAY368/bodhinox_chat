-- The browser's User-Agent for the session/device list. Captured at sign-in (or the first time
-- the device list is opened from that session). No IP address or location is stored.
ALTER TABLE auth_sessions ADD COLUMN user_agent TEXT CHECK (char_length(user_agent) <= 512);
