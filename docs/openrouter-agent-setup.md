# OpenRouter agent setup

In AI Agents → Setup, select **OpenRouter — free models**. The preset uses the
existing OpenAI-compatible adapter at `https://openrouter.ai/api/v1`; no new
database schema or environment variable is needed.

Enter the OpenRouter key in the password field, test it, then save. The existing
settings API validates the credentials and encrypts the key with AES-256-GCM
using the server's existing `ENCRYPTION_KEY`. It returns only key availability,
never the key. Do not place a real key in source files or public environment
variables. Changing a compatible API endpoint requires entering its key again.

The default `openrouter/free` selects an available free model automatically.
The Free models list loads current free text models from OpenRouter's public
catalogue without sending the account key. If the list is unavailable, the
automatic free router remains selectable. Manual model IDs remain supported;
choose `openrouter/free` or a current `:free` ID to use free models. A manual
paid model ID can incur charges; the app never automatically switches to it.

Save, open Playground, and send a test prompt. This uses the same configured
provider, conversation history, knowledge retrieval, business prompt, and human
handoff logic as the existing agent. Saving a provider preserves the current
assistant and auto-reply switches. Playground works while the assistant is off;
enable customer auto-replies only when ready.

Free models have request/daily limits, variable latency, and variable availability.
The app distinguishes invalid keys, access policies, exhausted quotas, unavailable
models, and rate limits. It does not retry in a loop or fall back to paid models.
OpenRouter embeddings are not configured by this preset; the existing optional
OpenAI embeddings key or keyword knowledge search continues to apply.

References: [Free router](https://openrouter.ai/docs/guides/routing/routers/free-router),
[limits](https://openrouter.ai/docs/api/reference/limits).
