# Quick reply media and actions

In Settings → Quick replies, create or edit an Interactive reply. Choose Text,
Image, Video, Location, or File in Media. Upload attachments through the existing
account media storage, or enter a supported URL. For Location, enter coordinates
and an optional name and address. The preview shows the resulting messages.

Enable Advanced to configure each reply button's action:

- Reply only: keep the existing reply ID behavior.
- Link: enter an HTTP(S) URL. WhatsApp supports one link button in this message;
  it cannot be mixed with other reply buttons.
- Automation: select an active automation in this workspace.
- Flow: select an active flow in this workspace.

Save the quick reply and select it from the Inbox's existing quick reply picker.
A customer tap on an Automation or Flow button runs the selected workflow. These
buttons hand control back from a manually paused bot. An already active flow is
not replaced. Inactive or deleted destinations cannot be selected or sent; an
older sent button whose destination is unavailable will not start another bot.

Image, video, and file attachments replace a reply-button message's text header.
WhatsApp requires locations, and media attached to a list, to be sent as a
separate message before the interactive prompt. The preview shows this order.
Existing WhatsApp service-window and media size/type rules still apply.

No new environment variables or database migrations are required. The web and
worker services must both run this release. Existing account media storage and
WhatsApp credentials remain required.

Workflow actions use an opaque per-send button ID and the exact parent message,
account, and conversation. The existing durable inbound checkpoints prevent
reprocessing the same customer event. Link buttons open a URL and do not produce
an automation callback.
