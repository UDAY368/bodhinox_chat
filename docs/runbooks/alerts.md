# Alerts and health monitoring

Requirement ids: OPS-01. Env var names only; no secrets, tenant ids or customer content belong in this file or in incident notes.

**Primary alert: external uptime monitor (owner sets up; owner-pending).**
1. Monitor A: `GET https://<app>/api/health` every 1 min; alert on non-200 or 2 consecutive timeouts. This is also Railway's healthcheck path; enable Railway deploy-failure notifications for web and worker.
2. Monitor B (needs a monitor that supports a custom request header): `GET https://<app>/api/health?deep=1` with header `Authorization: Bearer <HEALTH_TOKEN>` every 1–5 min. Alert on HTTP 503 (`down`), on a body containing `"status":"degraded"` for 10 minutes, and on a body without `"checks"` (a wrong or missing token, or a rollback to code without deep mode, returns the plain `{"status":"ok"}`). Never put the token in the URL; the route ignores it there.
3. Set `HEALTH_TOKEN` on the web service (random, ≥ 32 characters, e.g. `openssl rand -hex 32`). The web service also needs `PLATFORM_DATABASE_URL`, otherwise the deep body says `"ops":"unconfigured"` and stays `degraded`. Setting `PLATFORM_DATABASE_URL` on web also turns the platform admin console on (unsetting it is how docs/deployment/railway.md turns the console off), so enabling deep health is an explicit owner decision about the console too.

**Secondary: worker alert hook.** Set `OPS_ALERT_WEBHOOK_URL` (https) on the **worker** service, e.g. a Slack/Google Chat incoming webhook (the payload has a `text` field) or any JSON receiver. It posts when the status changes and every 15 min while `down`. A change to `degraded` or `ok` is posted only after it holds for two consecutive checks (about 2 minutes), so a backlog hovering at the threshold does not flap; `down` is posted at once. Each worker process keeps its own state, so run one worker replica. It cannot report the worker's own death or a dead database: Monitor B covers those.

**Fields → meaning → runbook**

| Field | Status effect (deep check and alert hook) | Go to |
|---|---|---|
| `checks.appDb=false` | down: app DB unreachable (also plain `/api/health` 503) | incident-response (SEV1) |
| `checks.worker.ok=false` | down: no heartbeat for > 90 s | delayed-jobs §worker not beating |
| `checks.queue.oldestDueS` > 300 | degraded: backlog | delayed-jobs |
| `checks.queue.expiredLeases` > 0 for long | informational only (no status change): stuck lease | delayed-jobs §stuck lease |
| `checks.queue.failed1h` > 0 | informational only (no status change): jobs that exhausted retries | delayed-jobs §failed jobs |
| `checks.intents.unknown` > 0 | degraded: ambiguous provider send | delayed-payments / provider-outage (reconcile, never re-send) |
| `checks.webhooks.unprocessed15m` > 0 | degraded: inbound receipts 15 min–24 h old not processed (also when their job already exhausted to `failed`) | delayed-jobs, provider-outage |
| `checks.ops` = `unavailable` | degraded: ops query failed or > 2 s (its counts use the partial indexes from `20261113090400`..`090600`) | check DB load; incident-response |
| `checks.migrations.latest` | compare with the release's newest migration after deploy | release-rollback |

Later options (not built): Sentry for exceptions, OpenTelemetry traces.

Known limit (rate limiting): `src/lib/rate-limit.ts` buckets (send, broadcast, public API, AI, deep health) are an in-memory `Map` per process: they reset on every deploy/restart and each replica has its own. The login/sign-up/booking/shop limits are durable (`auth_rate_limits`, proven by `src/lib/rate-limit.auth.integration.test.ts`). Smaller option named, not built: move the public API limit onto the `auth_rate_limits` pattern when a second web replica is planned.
