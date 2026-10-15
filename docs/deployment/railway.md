# Railway deployment runbook

Project: Bodhinox_Chat (`45ece5a5-786b-4ed5-848a-aaefb8589c04`). Environment: production (`6fe2fdf9-f4cb-4cad-8f55-f2912abb93f4`). GitHub repository: https://github.com/UDAY368/bodhinox_chat.

| Resource | ID | Configuration |
| --- | --- | --- |
| Postgres | 2c9ad580-bdf3-4adf-903a-a5812509052d | PostgreSQL 18, existing volume |
| Bodhinox-Web | 3dc6ac06-e3ba-484f-96df-e0d763de249a | Dockerfile, port 3000, /api/health |
| Bodhinox-Worker | 1dd980b1-d523-4b4e-b685-faca2fc83087 | Dockerfile.worker, continuous process |
| Bodhinox-Media | bbdc1ab1-8b5b-4b0a-9e59-98d39bbef508 | Private S3-compatible bucket |

The configured application hostname is https://bodhinox-web-production.up.railway.app. Domain allocation and service configuration alone do not confirm a successful deployment; record the deployment status and HTTP checks after connecting source.

The public PostgreSQL proxy uses port26854. On Railway's private network use postgres.railway.internal:5432. Every cloud role URL trusts `/app/deploy/railway-postgres-ca.crt` with verify-ca/uselibpqcompat, without disabling TLS certificate-chain validation. If Railway rotates the project CA, verify the replacement against the operator's database service, update this public certificate, and deploy it alongside updated clients.

The web receives constrained application, auth and worker connections because authenticated API handlers also enqueue work and resolve incoming provider routing. The worker receives only its worker connection; it has no auth database URL, JWT private key or owner migration credential. Tenant domain operations still require transaction-local tenant context and FORCE ROW LEVEL SECURITY.

Use `${{Bodhinox-Media.ENDPOINT}}`, `.BUCKET`, `.REGION`, `.ACCESS_KEY_ID`, and `.SECRET_ACCESS_KEY` reference variables for S3 settings. Bucket URL style is virtual-host; S3_FORCE_PATH_STYLE=false. Set APP_URL and AUTH_JWT_ISSUER to the exact HTTPS application origin.

## Releases

1. Run local/CI typechecking, linting, unit and isolated PostgreSQL integration tests and the production build.
2. Review additive migrations. Existing applied migration files are immutable.
3. Take a Railway backup before changing a database that contains customer data. The initial target was verified empty.
4. Run the manually dispatched production migration workflow, or `npm run db:migrate` locally using the dedicated migration-owner URL. Role bootstrap is only required for onboarding or coordinated role-password rotation.
5. Deploy the checked application commit to both services. Wait for SUCCESS and verify /api/health, unauthenticated login, protected page redirects and worker readiness.
6. Configure SMTP and Meta credentials when ready, then test signup/verification/MFA, inbound status and message webhooks, private media, a single approved recipient send, and broadcast completion with the browser closed.

Keep one web and one worker replica until shared API rate limiting and provider-wide throughput coordination have been implemented and measured. PostgreSQL job claims and lease fencing support crash recovery; browser request rate-limit buckets are currently process-local. Avoid overlapping worker releases; uncertain dispatches require operator reconciliation.

## Operations

Inspect failed jobs by ID, type, attempts and sanitized last_error through a trusted operator database session. Inspect inbound_action_steps and outbound_intents for interrupted external actions. Do not reset unknown/dispatching intents or stage checkpoints and resend blindly. First reconcile the provider's delivery state and application audit records.

Rotate RSA signing keys with a new AUTH_JWT_KID. Retired public keys remain configured only for the bounded 15-minute access-token overlap described in authentication-validation.md; keep refresh revocation and current-membership checks enabled.

For account defaults run `npm run db:seed -- ACCOUNT_UUID EXISTING_OWNER_USER_UUID` after verified owner onboarding. It is idempotent and does not create demo contacts or send any message. Email-provider setup is explicitly deferred; no live-email success is implied by database authentication tests.
