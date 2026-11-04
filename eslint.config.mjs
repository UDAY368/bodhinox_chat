import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { files: ["scripts/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
  // Phase 12: the flow dry run may only read (one tenant transaction, made
  // read-only by withDryRun) and call pure simulators. It must not import a
  // module that sends, enqueues, charges, books or calls out. This covers
  // direct imports; withDryRun's runtime guard covers transitive ones.
  {
    files: ["src/lib/flows/dry-run.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: [
            "@/lib/flows/engine", "./engine",
            "@/lib/jobs/*", "../jobs/*",
            "@/lib/whatsapp/*", "../whatsapp/*", "!@/lib/whatsapp/interactive-limits", "!../whatsapp/interactive-limits",
            "@/lib/instagram/*", "../instagram/*",
            "@/lib/payments/*", "../payments/*",
            "@/lib/appointments/*", "../appointments/*",
            "@/lib/webhooks/*", "../webhooks/*",
            "@/lib/meta-ads/*", "../meta-ads/*",
            "@/lib/notifications/*", "../notifications/*",
            "@/lib/automations/engine", "../automations/engine",
            "@/lib/contacts/tag-events", "../contacts/tag-events",
          ],
          message: "A dry run must not import a module with side effects (sends, jobs, payments, bookings, webhooks). Use the read transaction and the pure simulators only.",
        }],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".reference/**",
    ".superpowers/**",
    ".firecrawl/**",
    ".certs/**",
    "mcp-server/dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // Third-party research captures and one-off extraction scripts, not app code.
    "docs/research/**",
  ]),
]);

export default eslintConfig;
