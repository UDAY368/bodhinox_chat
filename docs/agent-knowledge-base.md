# Give the agent business knowledge

1. Open **AI Agents → Setup → Knowledge base → Add document**.
2. Enter a clear title and approved business facts. Use question-and-answer pairs
   for FAQs, and separate documents for policies, products, prices, and services.
3. Click **Save document**. Saving creates searchable text chunks immediately.
4. Open **Playground** and ask a question covered by the document. Check the
   answer before relying on it for customer replies.

The saved text is retrieved and included as reference in each relevant agent
request. This is retrieval-augmented generation, not model retraining. The same
retrieval path is used by Playground, Inbox drafts, and automatic replies.
Editing a document rebuilds its searchable chunks; no model training job is
needed. Keep business instructions/personality in **Business context &
instructions**, and factual reference material in the Knowledge base.

With the current OpenRouter setup, keyword search works without any extra API
key. Include likely customer questions and product names in FAQs because this
mode matches words rather than meaning. An optional OpenAI embeddings key
enables semantic retrieval; adding an OpenRouter chat key alone does not create
embeddings. Reindex existing documents after adding an embeddings key.

Use only accurate, approved information. Do not include passwords, API keys, or
unnecessary customer details. The model receives the relevant retrieved excerpts
through the configured provider. When the knowledge does not cover a question,
the existing agent can hand off to a person instead of inventing an answer.

If a save reports an indexing warning, the document exists but its index may
need attention. An embeddings failure retains keyword-search chunks; a storage
failure may require retrying the document edit or reindexing.

## Understand replies and response time

Each Playground reply shows the selected model, number of retrieved knowledge
excerpts, and time spent retrieving knowledge versus waiting for the model.
Zero excerpts means no matching document was found for that question; the agent
can still use its business instructions and conversation context, or hand off.
OpenRouter calls request low reasoning effort for concise support replies.
Free-provider congestion can still cause delays. Errors stay visible and retain
the question so it can be retried; the app never switches to a paid model.

## Use AI in the Inbox

AI uses the current conversation, including button/list prompt text and customer
replies. Automatic replies require the assistant and auto-reply switches to be
enabled, an active 24-hour customer window, and an unassigned, unpaused chat.
Human-owned chats show why AI is waiting. **Resume AI** explicitly releases the
human assignment and pause for the next eligible customer message; it does not
send an old message again.

Unrelated requests, unsupported business questions, and explicit requests for a
person hand off instead of receiving a general-knowledge answer. Matched flows
and automations retain priority over AI.

To let AI answer unexpected typed questions while a flow is waiting for a menu
button/list tap, select **AI** as that flow's unknown-reply fallback. Supported
questions can be answered without changing the menu position or captured data;
the customer can still tap the original option afterward. Existing fallback
policies remain unchanged until this option is selected. Text collection nodes
keep their existing input-validation behavior.
