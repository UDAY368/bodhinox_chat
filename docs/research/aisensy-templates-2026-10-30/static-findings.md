# Template Messages — static evidence supplement

Captured locally on 30 October 2026. This supplement inspects the existing shipped JavaScript acquired on 29 October; it does not establish that the current site still ships identical bytes. No network calls, browser actions, approval submissions, or application implementation occurred in this static pass.

## Evidence and boundaries

- Original: `.reference/aisensy-full-2026-10-29/source/main.01f91df0.js` (3,437,689 bytes). Exact digest and extracted module identities are in `static-source-manifest.json`.
- All line references below refer to `../aisensy-campaigns-ads-2026-10-29/main-readable.js`, an inert Babel-formatted copy, **not recovered original source**.
- `static-modules/72283.js`: template fetching/store module, original formatted lines 62043 onward.
- `static-modules/50789.js`: authentication localization table, original lines 13192–13610.
- `static-modules/46946.js`: shared UI module containing the template preview renderer (also unrelated shared UI), original lines 15399–21165. Manually inspected; not included in focused REA run.
- Focused REA CLI 6.7.0 evidence: `ev_8d9e2b673f858819390cdc497003695b1951161c57433771e5abd12ace0a66b8`, stored in `rea-static-evidence.json`. It parsed two analyst-extracted modules as inert syntax: 37,719 bytes, 1,661 AST nodes, zero parse failures, zero emitted findings. Graph coverage is partial; one inventoried module was unselected. Wrapping extracted factories removes original webpack application context; this is **not** complete application reconstruction. Conclusions below come from direct inspection of the cited control/data flow, not invented REA findings.

## Route and missing management code

The registry declares `Template Message` at `/template-message` under Manage (`manage:1`, `power:1`, `whiteLabel:0`), lines 8086–8100. The route component is lazy module **92422**, loaded at line 7941 from chunks **2324, 2491, 9867, 8845, 3982, 4808, 8558, 9223, 8157, 1533, 5577, 9698, 2354**.

The existing corpus lacks **4808, 8558, 8157, 9698, 2354**. Therefore the creation form, submission endpoint, edit/delete controls, approval/rejection status UI, template count limits, validation rules, category selection, language selection UI, sample-upload requirements, and template library cannot be fully established from this corpus. Route existence does not prove every feature is enabled for this account. Do not substitute the unrelated ad-template APIs for WhatsApp message-template APIs.

## Fetching, status and model behavior

| Capability | Actual code behavior | Source |
|---|---|---|
| Fetch project templates | POST `URL + /api/templates` with `{assistantId}`; Axios requests `responseType:stream`; optional cancellation token | 62071–62090 |
| Parse response stream | Removes final character and wraps response in brackets before JSON.parse; assumes comma-delimited JSON items with trailing delimiter | 62091–62094 |
| Approved templates collection | Only records whose `status === APPROVED` populate `templates`, indexed by `name` | 62095–62097 |
| All-status collection | Every returned record populates `allTemplates`, also indexed by name | 62098–62100 |
| Retry | Initial request plus up to three retries at 1500 ms; both parse failure and request failure trigger retry | 62080–62085, 62115–62123 |
| Error/loading state | Start clears error; success clears loading and installs both maps; failure records error | 62136–62163 |
| Reset | Unload resets entire store to initial empty maps | 62125–62130, 62173–62176 |
| Add/update | Reducer branches add/replace the named entry in `templates`; these branches alone do not establish a backend approval bypass | 62164–62172, 62177–62185 |
| Analytics caveat | Metric named `project_approved_templates_count` uses total returned array length, not filtered approved length | 62101–62103 |

Status values beyond APPROVED are not enumerated by this module. `allTemplates` preserves server statuses without validating them. Two records sharing a name would overwrite each other in these maps; this is observed indexing behavior, not proof the server permits duplicates.

## Shared preview capability inventory

The shared renderer is a graphical preview. Its own disclaimer says delivered messages may differ; preview support does not prove that every type can be created in the management screen.

| Area | Extracted behavior | Source |
|---|---|---|
| Base model | Reads `type`, `format` or `payload.text`, `headerType`, `headerText`, `footerText`, `actionType`, `category`, `language`/`templateLanguage`, `quickReplies`, `callToAction`, `buttons` | 20788–20855 |
| Body variables | Passes body and supplied parameters through formatting helper; separates encoded buttons from body | 20802–20809 |
| Text-only models | TEXT and ORDER_STATUS classified text-only | 20553 |
| Commerce preview | ORDER_DETAILS, CATALOGUE_MESSAGE, MULTI_PRODUCT_MESSAGE render an order/product card, with product name, quantity, amount/total placeholders | 20240–20315, 20554, 20949–20953 |
| Header/media | IMAGE, VIDEO, FILE/DOCUMENT, LOCATION placeholders; resolved media URL and filename; fetches media with credentials disabled, creates blob URL, revokes it on cleanup | 20253, 20596–20619 |
| Location data | name/address/latitude/longitude read from supplied media | 20843–20849 |
| Footer/header/body | Optional text header/footer, formatted body, optional clamp/full-height/compact variants | 20930–21054 |
| WhatsApp icon | Small/large/none presentation choice | 20929–20947, 21058–21067 |
| Reply/action display | QUICK_REPLY, ORDER_DETAILS, CATALOG, MPM, FLOW display text action rows | 20345, 20378–20384 |
| Contact request | REQUEST_CONTACT_INFO renders Share phone number | 20374–20378 |
| Call action | PHONE_NUMBER renders `tel:` link and tooltip | 20385–20403 |
| URL action | Resolves URL metadata/button parameter substitution; opens rendered destination in new tab with noreferrer | 20423–20447, 20667–20681 |
| Copy code | Copies example/supplied coupon code via clipboard; authentication category uses localized Copy Code label | 20364–20368, 20405–20422 |
| Action precedence | actionType None returns no buttons; explicit formatted buttons/model buttons then quickReplies, callToAction, encoded buttons used by renderer | 20760–20776 |
| Dynamic CTA | templateCTAUrl, callToAction URL with last parameter substitution, then sampleCTAUrl fallback | 20777–20787 |
| Carousel detection | type CAROUSEL or nonempty carouselCards enables carousel renderer | 20802–20804 |
| Carousel media | Reads HEADER format and parameters from currently selected card; takes per-card media link before general media URL | 20622–20645 |
| Carousel contents | Card BODY text/examples and BUTTONS; accumulates preceding parameter counts; per-card body receives sliced variables; card count from supplied cards or template carouselCards | 20646–20665, 20851–20870 |
| Carousel interactions | Controlled or local selected index; previous/next navigation and optional card-add/card-delete callbacks wired by parent | 20465–20548, 20891–20904, 21002–21029 |
| Limited-time offer | Offer text, coupon code, expiry time; supports ended/urgent/normal styling; separate offer media slot | 20318–20348, 20716–20758, 20958–20965 |
| Offer expiry labels | Ended if past; same-day shows time; under 15 days shows remaining days; otherwise date | 20737–20758 |

## Authentication templates

Module 50789 provides localized `templateFormat`, `codeExpirationWarning`, `securityText`, and `copyCode` text keyed by language. It uses `{{1}}` for the verification code and `<>` as the minutes placeholder in the warning. The exact language keys are saved in `authentication-languages.json`. The preview falls back to English when no language is supplied. This demonstrates localization data and preview integration, not which languages the current creation dropdown enables or which fields Meta accepts.

## Unknowns that require the management route or live UI

1. Actual create, edit, delete, sync and approval request endpoints/payloads.
2. Whether submission immediately sends to Meta, saves a draft, or supports separate stages.
3. Name syntax/length and uniqueness enforcement; body/footer/header/button limits; variable ordering rules.
4. Allowed media sizes/MIME types; upload/sample retention; number of carousel cards.
5. Exact status tabs, rejection reasons, appeal/resubmit behavior, category reclassification and quality rating.
6. Supported authentication modes, OTP expiry/security options, one-tap/zero-tap package/signature configuration.
7. Template library search/filter/copy behavior and AI-assisted content generation.
8. Current account entitlements, billing, server validation, delivery and Meta approval decisions.

No inference that a backend operation exists should be drawn solely from a renderer property or reducer action name. Reconcile these findings with the separately captured live UI before treating them as replica requirements.
