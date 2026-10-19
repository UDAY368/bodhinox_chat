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
