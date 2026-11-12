# ManyChat builder vs Bodhinox: gap report (2026-11-12)

Source: a hands-on pass through ManyChat's WhatsApp automation builder in the
owner's trial account. One test automation ("REA test - Bodhinox mapping") was
created, every step type and panel was opened, and the automation was then
deleted (it sits in ManyChat's trash). No other automation was touched. Only
patterns are recorded here; Bodhinox keeps its own words, colours and icons.

## What was mapped

**Builder frame.** Breadcrumb with inline rename, Draft/Live chip, "Saved"
autosave state, undo/redo, Preview with a dropdown (in the app, or on the real
channel), Set live, a ⋮ menu (Duplicate, Convert channels, Copy to another
page, Version history, Delete, Revert to published), "Go to basic builder",
and a "Tap a step to edit" hint. Right toolbar: round +, auto-arrange (magic
wand), zoom in/out; ? help at the bottom right.

**Cards.** Hover shows a small duplicate/delete toolbar above the card. There
is no right-click menu. Each button has its own output handle; questions add
"reply" and "no reply" outputs.

**Delete.** A dialog names the automation, lists the triggers that go with it
and says both move to the trash, from which they can be restored. A green toast
confirms ("has been deleted"), and the deleted editor shows a red banner with
a link to the trash.

**Preview.** A dark phone simulator beside the canvas with close and restart
buttons. Buttons in the bubbles are tappable, and the tap shows as a blue
outgoing bubble.

**Basic builder** (the same automation shown as a list). Three columns:

1. The steps, grouped as *Starting step*, *Attached steps* (reachable) and
   *Unattached steps*, with "+ Create new step" at the bottom. Each row gets
   drag, rename, duplicate and delete tools when hovered or selected.
2. The editor for the selected step (the same form as the canvas side panel).
3. A light phone mock-up showing the step as the customer sees it.

A "Go to flow builder" button switches back. Both views edit the same data.

**Animation timings** (computed styles):

| Element | Timing |
|---|---|
| Hover colours | 100–150 ms ease-in-out |
| Popovers and menus | fade/translate 200–300 ms |
| Side panel | slides in from the left, 200 ms ease-in-out |
| Dialogs | 300–400 ms ease-in-out |
| One spring-like move | 300 ms `cubic-bezier(0.29, 0.01, 0, 1.04)` |
| Typing dots | 1 s bounce |

## Bodhinox status

Already at parity, from Stage 5 and UI redesign phases 1–4:

- **Steps and triggers:** the "When…" trigger card with several triggers,
  intent (AI) keyword triggers, Actions, Randomizer, Smart delay (by duration
  or date, with send windows, up to 365 days), Conditions with all/any,
  questions with retries and timeouts, and contact-event automations
  (tag added, field changed and similar, in Automation › Basic).
- **Builder chrome:** the sectioned + menu, auto-arrange, the help dialog,
  canvas notes (ManyChat's "Comment"), versions, Revert to published,
  Duplicate, Delete, autosave, undo/redo, the dark phone preview and the
  six WhatsApp starters.

Gaps found:

| # | Gap | Status |
|---|---|---|
| 1 | Keyword matches "whole word", "begins with", "doesn't contain" | **Built in this change** |
| 2 | Basic builder: list view of the same flow with a live phone mock-up | Next. It builds on the phone-preview work now in progress on `feature/phone-preview-composer`, so it waits for that to land. |
| 3 | Several keyword conditions joined by AND in one trigger | Not built: two triggers or a condition step cover it. |
| 4 | Several content blocks stacked in one message step | Not built: Bodhinox uses one node per message, chained. This is a design choice. |
| 5 | Else-if chains inside one Condition | Not built: chained Condition steps do the same. |
| 6 | Question reply types URL / first name / last name | Not built: `regex` covers URL, and `set_attribute` saves the reply to a name field. |
| 7 | Convert channels, Copy to another page | Left out, as in redesign phase 1. |

## Built here: three new keyword match types

`flows.trigger_config.match_type` accepts three new values. Existing flows are
unchanged, and the database needs no migration because the trigger config is
JSON.

- **`word`:** the keyword appears as a whole word. A letter, digit or
  underscore on either side means no match, in any script. "price" matches
  "the price?" but not "priceless"; Devanagari works. Keyword symbols are
  literal (`c++`, `a.b`).
- **`starts_with`:** the message begins with the keyword. Leading spaces are
  ignored.
- **`not_contains`:** the message contains none of the keywords. Empty
  messages and empty keywords never match. Because this fires on almost every
  message, ahead of the default reply, the validator warns about it (without
  blocking), and the flow list says "Triggers on messages without: …".
