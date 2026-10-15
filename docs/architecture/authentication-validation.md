# Authentication validation

Validated on 14 October 2026 against the isolated Railway `bodhinox_test` database. The authentication client used the constrained `bodhinox_auth` role and CA-verified TLS. Integration tests reject a database whose name does not contain `test`, and reject a connection whose current role is not `bodhinox_auth`. Generated test identities and their workspaces are removed after the suite. SMTP is captured in the test process; no real verification emails were sent.

## Implementation

Access JWTs use RS256 with a 15-minute lifetime and required `sub`, `sid`, `jti`, `tenant_id`, `iss`, `aud`, `iat`, `exp`, and `token_use=access`. Verification permits only the configured algorithm and trusted operator key identifiers. Each request additionally resolves an active database session, verified enabled identity, and current workspace membership. Role changes apply immediately. Session logout, refresh reuse, password recovery and email confirmation invalidate already issued access JWTs through database revocation.

Refresh secrets contain 256 random bits. Only SHA-256 digests are stored. Rotation locks the session/token records, inserts one successor, consumes its predecessor, and retains the original seven-day session deadline. Replaying a consumed refresh secret commits family revocation and a durable `audit_logs` entry before returning an authentication failure. Browser refreshes are serialized in-process and across tabs through Web Locks where available. Concurrent server refreshes are independently protected by PostgreSQL.

Passwords use salted Argon2id (64 MiB, three iterations, parallelism one), with a 12-character minimum and a 1024-byte input ceiling. Authentication attempts use shared PostgreSQL rate-limit counters. Pre-auth routes also have application-wide budgets and enforce bounded JSON bodies.

Browser credentials are host-only HttpOnly cookies. Production cookies have `__Host-` names, Secure, Path=/ and SameSite=Lax. A separate readable random CSRF cookie is bound to the session's database digest. Mutations require the configured exact Origin and the matching CSRF header. Browser response JSON and public session types contain no JWT/refresh secret, and auth code does not write bearer credentials to localStorage or sessionStorage.

TOTP uses otplib with encrypted AES-256-GCM secrets, locked time-step replay protection, ten-minute pending enrollment and hashed single-use recovery codes. Verified factors are required on login and on password/email security changes. In production, owner/admin sessions without an enrolled factor can access only the restricted auth session, MFA enrollment and logout flow; normal CRM session resolution rejects them. Enrollment revokes other existing sessions; disabling MFA revokes every session.

Email changes require the current password and an enabled MFA factor. The old email remains active until a one-time proof is delivered to and confirmed from the new address. Confirmation atomically changes identity/profile email and revokes all sessions. Password changes and password recovery cancel pending email changes. A security notification goes to the previous address.

Workspace switching checks membership, changes the session's active workspace, and issues a new tenant-bound JWT. Old tenant JWTs immediately fail session resolution. The session family deadline remains fixed.

## Explicit REST token client

`POST /api/auth/token-login` accepts `{clientMode:"token",email,password,mfaCode?,accountId?}`. `POST /api/auth/token-refresh` accepts `{clientMode:"token",refreshToken,csrfToken}`. These routes require HTTPS, the configured HTTPS application origin, and a non-browser request with no Cookie, Origin or Sec-Fetch-* headers. Only this explicit mode returns `access_token`, `refresh_token`, `csrf_token`, token type and expiry metadata.

Native clients send `Authorization: Bearer <access JWT>` to first-party authenticated routes. Cookie/bearer combinations fail closed. The same JWT, database session, membership and production MFA checks apply. Native refresh secret handling is the client's responsibility. `/api/v1` integration API keys retain their separate scope/organization contract; they are not JWT access tokens.

`POST /api/auth/switch` accepts `{accountId}` for cookie clients, or `{accountId,clientMode:"token"}` with a native bearer request. The browser response updates the HttpOnly access cookie; the native response returns only the replacement access JWT. Public browser sessions expose workspace ID, role and `mfaRequired` but no bearer credential.

## Required configuration and key rotation

Configure `AUTH_DATABASE_URL`, `APP_URL`, `AUTH_JWT_PRIVATE_KEY`, `AUTH_JWT_PUBLIC_KEY`, `AUTH_JWT_KID`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `AUTH_MFA_ENCRYPTION_KEY`, `SMTP_URL`, and `AUTH_EMAIL_FROM`. The MFA key must contain 32 random bytes encoded as 64 hex characters. Production database credentials must use the constrained role. No deployed default keys, passwords or users are included.

During a signing-key rollover, switch the active private/public key and active `kid`. Add the previous public key to optional `AUTH_JWT_VERIFICATION_KEYS` as an operator-controlled JSON map: `old-kid: {publicKey: PEM, expiresAt: ISO timestamp}`. The retirement timestamp must be in the future and no more than 15 minutes away when verified. Remove the retiring entry after expiry. Tokens cannot nominate remote keys or URLs. For an emergency compromise, revoke database sessions and replace the signing key; ordinary access-token expiry alone is insufficient revocation.

## Evidence

- Focused authentication regressions: **35 tests passed across 11 files**, covering claims/signature/expiry/algorithm/key rollover, Argon2id, Origin/CSRF, refresh failure transactions, TOTP secret tampering/replay/recovery, native-client gating, production cookie flags, browser refresh coordination and safe callbacks.
- Real constrained PostgreSQL suite: **12 tests passed**, repeated successfully after the email-change migration. The final run took about 92 seconds because it includes many cloud database round trips and password hashes. Coverage includes atomic signup and captured verification email; live roles/logout; hashed refresh/reuse; concurrent refresh; revoked membership; password/reset one-time proof; native bearer login/refresh; tenant switching; the production privileged MFA enrollment boundary; atomic verified email change; cancellation of pending changes after password update; TOTP enrollment and recovery reuse.
- Commands: `npm exec vitest run <focused auth test files> -- --pool=threads --maxWorkers=1 --reporter=dot`; `npm exec vitest run src/lib/auth/auth.integration.test.ts -- --pool=threads --maxWorkers=1 --reporter=dot`.
- Test configuration is read quietly from ignored `.env.test`; database URLs and credentials are not printed. The real suite requires `TEST_AUTH_DATABASE_URL` and explicitly reports failures if configured infrastructure is unavailable.
- Final full `tsc --noEmit` completed with exit code zero. Scoped ESLint across auth modules/endpoints/screens, the auth hook, proxy and profile form completed with zero errors and zero warnings. The React review retained deliberate full-page navigation after session revocation so prior cookie-bound application state is discarded.

## Practical limits

Live SMTP delivery, browser navigation against a deployed application, password-hashing load under production concurrency and a live signing-key rollover remain deployment acceptance checks. Auth unit/database evidence does not establish that every CRM/provider feature is production-ready. Public/non-browser token mode has route-handler and database coverage; a real external REST client still needs deployment testing. Browsers without Web Locks retain process-local refresh serialization; simultaneous refreshes from distinct tabs may deliberately trigger family revocation rather than issue two successors.
