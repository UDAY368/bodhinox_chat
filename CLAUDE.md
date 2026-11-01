# Contributing to Bodhinox Chat

Read AGENTS.md and the installed Next.js guides before changing framework behavior. Original attribution remains in LICENSE and README.md.

Use Node24, npm, TypeScript, React and the existing UI components. Application data uses Prisma/PostgreSQL with constrained app/auth/worker roles. Every domain query runs inside withTenant; user_id is historical audit identity and account_id is the tenancy boundary. Current role comes from active membership and a live session.

Use additive Prisma migrations. Do not edit deployed checksums. Database tests use a separate test database, never production. scripts/ci-environment.cjs overwrites local env files and is intended only for disposable CI.

Preserve fixed resource/query/RPC contracts; never expose arbitrary tables, raw SQL, worker flags, system credentials, provider tokens or password hashes through a browser API. Require JWT/currentmembership/role and mutation-origin/CSRF checks before external actions.

Queue background tasks before acknowledging them. Outbound intents and inbound stage checkpoints prevent blind re-sends after ambiguous outcomes; surface reconciliation instead of automatically clearing those records. Keep customer content and secrets out of logs.

Validate with npm run typecheck, npm run lint, npm test -- --maxWorkers=1, and npm run build. Add meaningful security, durability and tenancy tests for behavior changes. Update the feature inventory and deployment runbook as behavior changes.

## ponytail

Use the ponytail skill in lite mode for every coding task in this project: build what was asked, name a smaller option in one line and let the user pick, finishing every caller, test and fixture it touches. Do not let it shorten anything under the security, tenancy and durability rules above.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
