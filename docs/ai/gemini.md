# Gemini for the existing AI assistant

Set `GEMINI_API_KEY` in the server environment. For local development, put it in the ignored `.env.local` file. For a Railway deployment, set it on both the web and worker services because drafts/playground run in web and automatic replies run in the worker. Do not use a `NEXT_PUBLIC_` variable or enter the key in the browser.

Apply the `20261017000000_gemini_provider` database migration before deploying code that saves Gemini configurations. It adds Gemini to the existing provider checks and allows a null `ai_configs.api_key` only for Gemini. Other providers retain their encrypted per-account keys.

In **Settings → AI Assistant**, select **Google Gemini**. The default model is `gemini-3.8-flash`. Use **Test connection**, then save the configuration. The Playground can test the agent before enabling it. Enable the assistant and automatic replies when ready. Existing system prompts, knowledge retrieval, handoff routing, usage logging, and workflow settings continue through the shared agent path.

The Gemini key is held only in the server environment. Gemini configuration rows store no key. A missing server key makes a saved Gemini configuration unavailable until the environment is corrected. Provider errors are categorized as invalid key, unsupported model, quota, rate limit, network/timeout, blocked content, or general provider failure.
