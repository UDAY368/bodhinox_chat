# Cream and Copper Redesign Implementation Plan

**Goal:** Apply the supplied CRM Studio reference to the real BODHINOX Next.js app.
**Architecture:** Keep routes, authentication, APIs, state, and existing interactions. Centralize warm neutral surfaces and copper accent in existing tokens; refine shared primitives and selected screen compositions. No new dependencies or placeholder data.
**Decision:** User selected cream and copper, superseding the attached brief's midnight/blue palette. Work in the existing project as requested; preserve unrelated documentation changes.

- [x] Add a first-class copper theme and cream default appearance, preserving saved appearance choices and dark mode.
- [x] Refine shared controls, cards, tables, dialogs, shell, and responsive navigation; provide real searchable page navigation.
- [x] Restyle the live dashboard with an editorial heading, real metrics, existing charts, and useful links.
- [x] Refine Inbox and KHAGA AI surfaces without changing message, provider, or automation behavior.
- [x] Carry consistent surfaces to contacts, pipelines, broadcasts, automations, flows, notifications, and settings through shared components and targeted style hooks.
- [x] Run theme/navigation tests, typecheck, lint, build, and browser checks at desktop/mobile sizes. Check reduced motion, focus, overflow, and readable fallback materials.

## Review focus
Saved theme compatibility; truthful connection/AI status; mobile dialog and navigation overflow; readable dense tables/messages; no backend or production-data mutations during visual QA.

## Verification results

- Full Vitest suite: 155 files, 1,449 tests passed.
- Final navigation/theme/i18n checks: 16 tests passed.
- TypeScript and production webpack build passed.
- ESLint: zero errors, 33 existing warnings; final changed-file lint also has zero errors (five existing unused-import warnings).
- Browser: all ten main modules rendered against an isolated TEST workspace. Confirmed Ctrl/Cmd+K search and Enter navigation; Copper and existing Violet selection; dark/light switching; mobile drawer; mobile conversation selection; composer bottom within viewport; contact Deals tab accessible; real deal dialog opens/cancels.
- Browser widths: 1440px desktop and 390px mobile. No document-level horizontal overflow in checked views.
- Review corrections: dynamic Inbox sizing, dark-variant attribute, mobile sheet/tab sizing, closed-drawer focus visibility.

## Delivery

Existing data services, permission checks, AI configuration, workflows, and WhatsApp APIs are unchanged. QA fixtures are restricted to the isolated test database and clearly labeled Design verification / TEST. The local preview uses that workspace. Visual QA made no outbound WhatsApp/provider calls. The user approved production deployment after reviewing the local preview; release uses the existing GitHub-to-Railway pipeline without database, environment-variable, or integration changes.

## Changed areas

Theme registry and tokens: src/lib/themes.ts, src/app/globals.css, src/app/studio.css.
Shell/search: src/components/layout and dashboard-shell.tsx.
Dashboard: existing dashboard components plus dashboard.module.css.
Inbox/KHAGA: existing Inbox and Agents pages/components.
Contact sheets: shared Sheet responsive widths and Contact detail tab scrolling.
Brand/labels: messages/en.json, es.json, pt.json, ko.json.

Saved appearance preferences remain valid; select Light mode and Copper under Settings > Appearance to adopt the new default on a previously customized device.
