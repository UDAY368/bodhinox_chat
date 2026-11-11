// Instagram message limits (Phase 11, Stage 2). Pure: no I/O, safe in client
// components (the composer counter and the flow editors use them; graph.ts
// enforces them before any request). Documented on Meta's Send Messages,
// generic/button template, ice breaker and comment reply pages unless marked
// (unconfirmed), which a live check confirms; kept as named constants.

export const INSTAGRAM_LIMITS = {
  textBytes: 1000,
  /**
   * (unconfirmed) quick replies per message. Meta's Instagram pages have shown
   * both 13 and 11; Stage 2 uses the smaller value until a live send confirms.
   */
  quickReplies: 11,
  quickReplyTitleChars: 20,
  quickReplyPayloadChars: 1000,
  /** Buttons per button template or generic-template card. */
  buttons: 3,
  buttonTitleChars: 20,
  /** Postback payloads carry our own codes (postback-payloads.ts); Meta allows 1000. */
  postbackPayloadChars: 1000,
  /** Cards in one generic template (a gallery). */
  genericCards: 10,
  cardTitleChars: 80,
  cardSubtitleChars: 80,
  /** Button-template text (the message above the buttons). */
  buttonTemplateTextChars: 640,
  /** Ice breakers (conversation starters) per account. */
  iceBreakers: 4,
  /** (unconfirmed) ice breaker question length. */
  iceBreakerQuestionChars: 80,
  /** (unconfirmed) public comment reply length (an Instagram comment's cap). */
  commentReplyChars: 2200,
  /** (unconfirmed) persistent menu items per account (Messenger's documented top-level cap; Stage 3). */
  persistentMenuItems: 20,
  /** (unconfirmed) persistent menu item title length. */
  persistentMenuTitleChars: 30,
  urlChars: 2048,
  imageBytes: 8 * 1024 * 1024,
  audioBytes: 25 * 1024 * 1024,
  videoBytes: 25 * 1024 * 1024,
  fileBytes: 25 * 1024 * 1024,
} as const;

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;
/** Length in user-perceived code points (an emoji counts once), as Meta counts titles. */
export const charLength = (text: string): number => [...text].length;

/** A message body Instagram accepts: non-empty, at most 1000 UTF-8 bytes. */
export function validInstagramText(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0 && utf8Bytes(text) <= INSTAGRAM_LIMITS.textBytes;
}

export interface QuickReply { title: string; payload: string }

/** True when the replies fit Instagram's quick-reply limits. */
export function quickRepliesFit(replies: readonly QuickReply[]): boolean {
  return replies.length >= 1 && replies.length <= INSTAGRAM_LIMITS.quickReplies && replies.every((r) =>
    typeof r.title === 'string' && r.title.trim().length > 0 && charLength(r.title) <= INSTAGRAM_LIMITS.quickReplyTitleChars &&
    typeof r.payload === 'string' && r.payload.length > 0 && r.payload.length <= INSTAGRAM_LIMITS.quickReplyPayloadChars);
}

/** An https URL of at most 2048 characters. */
export function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > INSTAGRAM_LIMITS.urlChars) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const nonEmpty = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && charLength(value) <= max;

/** A template button: opens an https link, or posts a payload back. */
export type IgTemplateButton =
  | { type: 'web_url'; title: string; url: string }
  | { type: 'postback'; title: string; payload: string };

export function buttonFits(button: IgTemplateButton): boolean {
  if (!button || !nonEmpty(button.title, INSTAGRAM_LIMITS.buttonTitleChars)) return false;
  if (button.type === 'web_url') return validHttpsUrl(button.url);
  if (button.type === 'postback')
    return typeof button.payload === 'string' && button.payload.length > 0 && button.payload.length <= INSTAGRAM_LIMITS.postbackPayloadChars;
  return false;
}

/** Button-template text plus 1–3 buttons. */
export function buttonTemplateFits(text: string, buttons: readonly IgTemplateButton[]): boolean {
  return nonEmpty(text, INSTAGRAM_LIMITS.buttonTemplateTextChars) &&
    buttons.length >= 1 && buttons.length <= INSTAGRAM_LIMITS.buttons && buttons.every(buttonFits);
}

/** One generic-template element. */
export interface IgGenericCard {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  defaultUrl?: string;
  buttons?: IgTemplateButton[];
}

export function cardFits(card: IgGenericCard): boolean {
  if (!card || !nonEmpty(card.title, INSTAGRAM_LIMITS.cardTitleChars)) return false;
  if (card.subtitle !== undefined && !nonEmpty(card.subtitle, INSTAGRAM_LIMITS.cardSubtitleChars)) return false;
  if (card.imageUrl !== undefined && !validHttpsUrl(card.imageUrl)) return false;
  if (card.defaultUrl !== undefined && !validHttpsUrl(card.defaultUrl)) return false;
  const buttons = card.buttons ?? [];
  return buttons.length <= INSTAGRAM_LIMITS.buttons && buttons.every(buttonFits);
}

/** 1–10 cards, each fitting. */
export function genericTemplateFits(cards: readonly IgGenericCard[]): boolean {
  return cards.length >= 1 && cards.length <= INSTAGRAM_LIMITS.genericCards && cards.every(cardFits);
}

export interface IceBreaker { question: string; payload: string }

/** 0–4 ice breakers (an empty list clears them), questions distinct. */
export function iceBreakersFit(items: readonly IceBreaker[]): boolean {
  if (items.length > INSTAGRAM_LIMITS.iceBreakers) return false;
  const questions = new Set(items.map((i) => (typeof i?.question === 'string' ? i.question.trim().toLowerCase() : '')));
  return questions.size === items.length && items.every((i) =>
    nonEmpty(i.question, INSTAGRAM_LIMITS.iceBreakerQuestionChars) &&
    typeof i.payload === 'string' && i.payload.length > 0 && i.payload.length <= INSTAGRAM_LIMITS.postbackPayloadChars);
}

/**
 * One persistent menu item (Stage 3): a link or a postback, like a template
 * button but with the menu's longer title.
 */
export type PersistentMenuItem = IgTemplateButton;

/** 0–20 menu items (an empty list removes the menu), titles distinct. */
export function persistentMenuFits(items: readonly PersistentMenuItem[]): boolean {
  if (items.length > INSTAGRAM_LIMITS.persistentMenuItems) return false;
  const titles = new Set(items.map((i) => (typeof i?.title === 'string' ? i.title.trim().toLowerCase() : '')));
  return titles.size === items.length && items.every((item) => {
    if (!item || !nonEmpty(item.title, INSTAGRAM_LIMITS.persistentMenuTitleChars)) return false;
    if (item.type === 'web_url') return validHttpsUrl(item.url);
    if (item.type === 'postback')
      return typeof item.payload === 'string' && item.payload.length > 0 && item.payload.length <= INSTAGRAM_LIMITS.postbackPayloadChars;
    return false;
  });
}

/** A public comment reply: non-empty, at most 2200 characters. */
export function validCommentReply(text: unknown): text is string {
  return nonEmpty(text, INSTAGRAM_LIMITS.commentReplyChars);
}
