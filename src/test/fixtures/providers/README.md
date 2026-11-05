# Provider contract corpus

Request and response examples for each external provider. The contract tests
(`*.contract.test.ts`) replay them through the real clients, and the webhook route
tests and ordering suites replay the inbound payloads with a test signature.

## File shape

`<provider>/<case>.json`:

```json
{
  "source": "docs-derived | sandbox-capture",
  "capturedAt": "YYYY-MM-DD",
  "docsUrl": "https://… (the provider page the shape follows)",
  "note": "optional",
  "request": { "method": "POST", "path": "…", "headers": { "…": "redacted" }, "body": {} },
  "response": { "status": 200, "headers": {}, "body": {} }
}
```

## Status today

There are no production or sandbox keys yet, so every fixture is `docs-derived`.
Each one is hand-written to the documented shape with synthetic values. None is
copied from the provider docs as a whole. Evidence calls them "docs-derived
contract", never "verified against provider". When a sandbox capture replaces one,
change `source` to `sandbox-capture` and set `capturedAt` to the capture date.

## Capturing from a sandbox (later)

1. Use sandbox or test-mode keys only, such as Razorpay `rzp_test_…`, a Meta test
   number, or a Shopify development store. Never capture with live keys.
2. Save the request and response. Remove `Authorization`, cookies, signatures and
   any token from the headers, and write `<redacted>` in their place.
3. Replace personal data:
   - emails become `…@example.com`;
   - Indian mobiles go into the reserved test range `98000 00000` to `98000 99999`;
   - names become plain test names;
   - addresses and UPI ids become synthetic values.
4. Run `npx vitest run src/test/fixtures/providers/scrub.test.ts`. It refuses
   token-like strings (`EAA…`, `rzp_live_`, `shpat_`, JWTs, bearer or basic
   credentials), emails outside `example.com`, and mobiles outside the reserved
   range.
5. Rerun the provider's `*.contract.test.ts`. If a capture shows the documented
   shape was wrong, fix the client and keep the capture as its regression test.

## Helpers

`index.ts` provides `loadProviderFixture`, `fixtureBody` and `fixtureFetch`.
`fixtureFetch` is a fetch stub that serves fixture responses in order and records
each request.

`drain.ts` provides `drainJobs`, `permutations` and `seededShuffle` for the
ordering suites. `drainJobs` runs only the jobs a suite created, through the real
`handleJob`, so suites that share the test database never take each other's jobs.
