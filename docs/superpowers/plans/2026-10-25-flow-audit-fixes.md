# Flow audit fixes

Approved scope: the four fixes from the October 25 flow audit.

1. Add regression coverage for missing variables, invalid validation settings, template email validation, and historical execution duration. Confirm failures before implementation.
2. Add warning-only analysis of variable references using reachable earlier collection nodes; preserve externally supplied variables. Add validation controls to the shared node form and validate their configuration before activation. Configure new lead-capture templates to validate email. Preserve existing collected data and node identities.
3. Replace the history's completion-age calculation with start-to-end duration. Verify affected tests, translations, lint, types, and build. Request independent review before release.
4. Release the verified code through CI to both services. In the active IMC flow connect Yes to the existing service menu and enable phone validation. Preserve all other connections and settings. Verify saved configuration and simulated execution without customer sends.
