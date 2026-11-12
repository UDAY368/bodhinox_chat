import { describe, expect, it } from "vitest";
import {
  adClickMatch, byPrecedence, igAdClickMatch, instagramFactsFrom, isTestContact, keywordTriggerMatches, liveCommentMatches, phoneDigits,
  refTriggerMatch, templateReplyMatch,
} from "./triggers";
import type { FlowRow, ParsedInbound, ParsedInboundReferral } from "./types";

const tap = (patch: Partial<Extract<ParsedInbound, { kind: "interactive_reply" }>> = {}): ParsedInbound =>
  ({ kind: "interactive_reply", reply_id: "Track", reply_title: "Track", meta_message_id: "m", context_template: "order_update", ...patch });

describe("keyword triggers", () => {
  it("searches a regex, with or without case", async () => {
    expect(await keywordTriggerMatches("my ORDER #123 please", { keywords: [], match_type: "regex", pattern: "order\\s*#?\\d+" })).toBe(true);
    expect(await keywordTriggerMatches("my ORDER #123", { keywords: [], match_type: "regex", pattern: "order\\s*#?\\d+", case_sensitive: true })).toBe(false);
    expect(await keywordTriggerMatches("hello", { keywords: [], match_type: "regex", pattern: "(" })).toBe(false);
    expect(await keywordTriggerMatches("hello", { keywords: [], match_type: "regex" })).toBe(false);
  });

  it("gives up on a catastrophic pattern instead of hanging", async () => {
    const started = Date.now();
    expect(await keywordTriggerMatches("a".repeat(40) + "!", { keywords: [], match_type: "regex", pattern: "(a+)+$" })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("matches whole words in any script and treats keyword symbols literally", async () => {
    const word = (text: string, keywords: string[]) => keywordTriggerMatches(text, { keywords, match_type: "word" });
    expect(await word("What is the PRICE?", ["price"])).toBe(true);
    expect(await word("priceless", ["price"])).toBe(false);
    expect(await word("price_list", ["price"])).toBe(false);
    expect(await word("दाम क्या है", ["दाम"])).toBe(true);
    expect(await word("c++ course", ["c++"])).toBe(true);
    expect(await word("cpp course", ["c++"])).toBe(false);
    expect(await word("a.b", ["a.b"])).toBe(true);
    expect(await word("axb", ["a.b"])).toBe(false);
  });

  it("matches at the start, and fires on none-of only when every keyword is absent", async () => {
    expect(await keywordTriggerMatches("  Hi there", { keywords: ["hi"], match_type: "starts_with" })).toBe(true);
    expect(await keywordTriggerMatches("oh hi", { keywords: ["hi"], match_type: "starts_with" })).toBe(false);
    expect(await keywordTriggerMatches("book a table", { keywords: ["stop", "unsubscribe"], match_type: "not_contains" })).toBe(true);
    expect(await keywordTriggerMatches("please STOP", { keywords: ["stop", "unsubscribe"], match_type: "not_contains" })).toBe(false);
    expect(await keywordTriggerMatches("anything", { keywords: [""], match_type: "not_contains" })).toBe(false);
    expect(await keywordTriggerMatches("", { keywords: ["stop"], match_type: "not_contains" })).toBe(false);
  });
});

describe("template-reply triggers", () => {
  it("matches a tap on the right template and records the button", () => {
    expect(templateReplyMatch(tap(), { template_name: "order_update" })).toEqual({ trigger_button: "Track" });
    expect(templateReplyMatch(tap(), { template_name: "order_update", buttons: ["Track"] })).toEqual({ trigger_button: "Track" });
  });

  it("ignores other templates, other buttons, plain text and taps with no template", () => {
    expect(templateReplyMatch(tap(), { template_name: "promo" })).toBeNull();
    expect(templateReplyMatch(tap(), { template_name: "order_update", buttons: ["Help"] })).toBeNull();
    expect(templateReplyMatch(tap({ context_template: undefined }), { template_name: "order_update" })).toBeNull();
    expect(templateReplyMatch({ kind: "text", text: "Track", meta_message_id: "m" }, { template_name: "order_update" })).toBeNull();
  });
});

it("orders flows by trigger precedence, then testing drafts, then age", () => {
  const flows: { id: string; trigger_type: FlowRow["trigger_type"]; created_at: string; status: FlowRow["status"] }[] = [
    { id: "first", trigger_type: "first_inbound_message", created_at: "2026-01-01", status: "active" },
    { id: "kw-new", trigger_type: "keyword", created_at: "2026-03-01", status: "active" },
    { id: "tpl", trigger_type: "template_reply", created_at: "2026-05-01", status: "active" },
    { id: "kw-old", trigger_type: "keyword", created_at: "2026-02-01", status: "active" },
    { id: "kw-draft", trigger_type: "keyword", created_at: "2026-06-01", status: "draft" },
  ];
  expect(byPrecedence(flows).map((f) => f.id)).toEqual(["tpl", "kw-draft", "kw-old", "kw-new", "first"]);
});

it("lets a draft run only for its test numbers", () => {
  const draft = { status: "draft" as const, test_numbers: ["919876543210"] };
  expect(isTestContact(draft, phoneDigits("+91 98765-43210"))).toBe(true);
  expect(isTestContact(draft, "14155550100")).toBe(false);
  expect(isTestContact(draft, "")).toBe(false);
  expect(isTestContact({ ...draft, status: "active" }, "919876543210")).toBe(false);
});

describe("adClickMatch", () => {
  const referral: ParsedInboundReferral = { source_id: "120211234567890", source_type: "ad", headline: "Summer sale", source_url: "https://fb.me/x" };
  const fromAd = (r: Partial<ParsedInboundReferral> | null = {}): ParsedInbound =>
    ({ kind: "text" as const, text: "Hi", meta_message_id: "m", ...(r ? { referral: { ...referral, ...r } } : {}) });

  it("starts for any ad when no ad ids are listed, with the ad variables and never the click id", () => {
    const vars = adClickMatch(fromAd(), {});
    expect(vars).toEqual({ ad_id: "120211234567890", ad_headline: "Summer sale", ad_source_url: "https://fb.me/x" });
    expect(Object.keys(vars ?? {})).not.toContain("ctwa_clid");
    expect(adClickMatch(fromAd({ headline: null, source_url: null }), { ad_ids: [] }))
      .toEqual({ ad_id: "120211234567890", ad_headline: "", ad_source_url: "" });
  });

  it("starts only for the listed ads when ad ids are set", () => {
    expect(adClickMatch(fromAd(), { ad_ids: ["120211234567890"] })).not.toBeNull();
    expect(adClickMatch(fromAd(), { ad_ids: ["999"] })).toBeNull();
    expect(adClickMatch(fromAd({ source_id: null }), { ad_ids: ["999"] })).toBeNull();
  });

  it("ignores posts, unknown sources and messages without a referral", () => {
    expect(adClickMatch(fromAd({ source_type: "post" }), {})).toBeNull();
    expect(adClickMatch(fromAd({ source_type: "unknown" }), {})).toBeNull();
    expect(adClickMatch(fromAd(null), {})).toBeNull();
  });

  it("ranks ad_click after order_received and ahead of template replies and keywords", () => {
    const flows: { id: string; trigger_type: FlowRow["trigger_type"]; created_at: string; status: FlowRow["status"] }[] = [
      { id: "kw", trigger_type: "keyword", created_at: "2026-01-01", status: "active" },
      { id: "tpl", trigger_type: "template_reply", created_at: "2026-01-01", status: "active" },
      { id: "ad", trigger_type: "ad_click", created_at: "2026-06-01", status: "active" },
      { id: "order", trigger_type: "order_received", created_at: "2026-06-01", status: "active" },
    ];
    expect(byPrecedence(flows).map((f) => f.id)).toEqual(["order", "ad", "tpl", "kw"]);
  });
});

describe("Instagram ref links, click-to-Direct ads and Live comments (Stage 3)", () => {
  const stored = (referral: Record<string, string>, extra: Record<string, unknown> = {}) => ({ ig: { referral, ...extra } });

  it("reads the ref and the ad from the stored message, and drops a ref it would not store", () => {
    expect(instagramFactsFrom(stored({ ref: "summer-sale", source: "SHORTLINK", type: "OPEN_THREAD" })).referral)
      .toEqual({ ref: "summer-sale", fromAd: false, adId: null, adTitle: null });
    expect(instagramFactsFrom(stored({ ref: "x", source: "ads", ad_id: "123", ad_title: "Sale" })).referral)
      .toEqual({ ref: "x", fromAd: true, adId: "123", adTitle: "Sale" });
    expect(instagramFactsFrom(stored({ ref: "bad ref!", source: "SHORTLINK" })).referral).toBeUndefined();
    expect(instagramFactsFrom(stored({ ref: "ok" }, { story: true, story_id: "55" }))).toMatchObject({
      referral: { ref: "ok" }, storyReply: { storyId: "55" } });
    expect(instagramFactsFrom({ ig: { story_mention: true } })).toEqual({ storyMention: true });
    expect(instagramFactsFrom(null)).toEqual({});
  });

  it("starts an ig_ref flow only for one of its keys (any case) on its account, and sets the ref variable", () => {
    const facts = instagramFactsFrom(stored({ ref: "Summer-Sale", source: "SHORTLINK" }));
    expect(refTriggerMatch(facts, { refs: ["summer-sale"] }, "acc")).toEqual({ ig_ref: "Summer-Sale" });
    expect(refTriggerMatch(facts, { refs: ["other"] }, "acc")).toBeNull();
    expect(refTriggerMatch(facts, { refs: [] }, "acc")).toBeNull();
    expect(refTriggerMatch(facts, { refs: ["summer-sale"], instagram_account_id: "acc" }, "acc")).not.toBeNull();
    expect(refTriggerMatch(facts, { refs: ["summer-sale"], instagram_account_id: "other" }, "acc")).toBeNull();
    expect(refTriggerMatch({}, { refs: ["summer-sale"] }, "acc")).toBeNull();
    expect(refTriggerMatch(facts, undefined, "acc")).toBeNull();
  });

  it("starts an Instagram ad_click flow only from an ad message, optionally from listed ads", () => {
    const ad = instagramFactsFrom(stored({ source: "ADS", ad_id: "900", ad_title: "Launch" }));
    expect(igAdClickMatch(ad, {})).toEqual({ ad_id: "900", ad_headline: "Launch", ad_source_url: "" });
    expect(igAdClickMatch(ad, { ad_ids: ["900", "901"] })).not.toBeNull();
    expect(igAdClickMatch(ad, { ad_ids: ["901"] })).toBeNull();
    expect(igAdClickMatch(instagramFactsFrom(stored({ ref: "x", source: "SHORTLINK" })), {})).toBeNull();
    expect(igAdClickMatch({}, {})).toBeNull();
  });

  it("matches a Live comment by account and keyword, and any comment when no keyword is set", () => {
    expect(liveCommentMatches({}, { instagramAccountId: "a", text: "hello" })).toBe(true);
    expect(liveCommentMatches({ keywords: [] }, { instagramAccountId: "a", text: "hello" })).toBe(true);
    expect(liveCommentMatches({ keywords: ["price"] }, { instagramAccountId: "a", text: "PRICE?" })).toBe(true);
    expect(liveCommentMatches({ keywords: ["price"] }, { instagramAccountId: "a", text: "hello" })).toBe(false);
    expect(liveCommentMatches({ keywords: ["price"], match_mode: "exact" }, { instagramAccountId: "a", text: "price?" })).toBe(false);
    expect(liveCommentMatches({ instagram_account_id: "b" }, { instagramAccountId: "a", text: "hello" })).toBe(false);
    expect(liveCommentMatches(undefined, { instagramAccountId: "a", text: "" })).toBe(true);
  });

  it("ranks an ig_ref flow above template replies and keywords, below ad clicks", () => {
    const f = (id: string, trigger_type: FlowRow["trigger_type"]) => ({ id, trigger_type, created_at: "2026-01-01", status: "active" as const });
    expect(byPrecedence([f("kw", "keyword"), f("ref", "ig_ref"), f("tr", "template_reply"), f("ad", "ad_click")]).map((x) => x.id))
      .toEqual(["ad", "ref", "tr", "kw"]);
  });
});
