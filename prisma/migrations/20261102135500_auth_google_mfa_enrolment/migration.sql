-- Lets an account created through Google (no password of its own) confirm two-step setup with a
-- fresh Google sign-in instead of a password.
--   auth_users.password_set: false only for accounts created through Google until the person sets a
--     password ("Forgot password"). Existing rows default to true, so they keep the password rule.
--   auth_sessions.sign_in_method: how the session was created; NULL for sessions created before this.
ALTER TABLE auth_users ADD COLUMN password_set BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE auth_sessions ADD COLUMN sign_in_method TEXT CHECK (sign_in_method IN ('password', 'google'));
