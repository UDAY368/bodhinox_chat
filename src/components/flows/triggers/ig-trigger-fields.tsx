"use client";

/**
 * Settings for the Stage 2 triggers, mounted by the trigger panel:
 * - a comment on a post (`ig_comment`): account, which posts (any, chosen,
 *   the next one), include / exclude keywords with their modes, and 0–3
 *   public replies;
 * - a reply to a story (`ig_story_reply`): stories, keywords, reactions;
 * - a story mention (`ig_story_mention`) and the default reply
 *   (`default_reply`): how often per person;
 * - (Stage 3) a comment on a Live broadcast (`ig_live_comment`): account and
 *   keywords; a ref link (`ig_ref`): account, ref keys and the links to share.
 * Every list is capped as the author types (ig-trigger-config.ts).
 */

import { useState } from "react";
import { Copy, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IG_TRIGGER_LIMITS, type IgKeywordMode, type IgPostScope, type TriggerFrequency } from "@/lib/flows/types";
import { refLinkUrl } from "@/lib/instagram/ref-links";
import { IgKeywordEditor } from "./ig-keyword-editor";
import { IgPostPicker, useInstagramAccounts, type PickerAccount } from "./ig-post-picker";
import { IgReplyVariants } from "./ig-reply-variants";
import { addIds, addRefKeys, readStrings, setPostScope, setPublicReplies, setTriggerAccount, toggleMedia } from "./ig-trigger-config";

type Config = Record<string, unknown>;
type Props = { config: Config; onChange: (c: Config) => void };
const label = "text-muted-foreground mb-1 block text-xs";
const help = "text-muted-foreground mt-1 text-[10px]";
const ANY = "__any__";

const mode = (value: unknown): IgKeywordMode => (value === "exact" ? "exact" : "contains");
const withoutKey = (config: Config, key: string): Config => {
  const next = { ...config };
  delete next[key];
  return next;
};

/** "All connected accounts" or one account; hidden when the workspace has at most one and none is set. */
function AccountSelect({ id, config, onChange, accounts }: Props & { id: string; accounts: PickerAccount[] }) {
  const t = useTranslations("Flows.triggers.igComment");
  const value = typeof config.instagram_account_id === "string" ? config.instagram_account_id : ANY;
  if (accounts.length <= 1 && value === ANY) return null;
  return (
    <div>
      <label htmlFor={id} className={label}>{t("account")}</label>
      <Select value={value} onValueChange={(v) => onChange(setTriggerAccount(config, v === ANY ? null : v))}>
        <SelectTrigger id={id} className="bg-muted"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{t("anyAccount")}</SelectItem>
          {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}
          {value !== ANY && !accounts.some((a) => a.id === value) && <SelectItem value={value}>{value}</SelectItem>}
        </SelectContent>
      </Select>
    </div>
  );
}

export function FrequencyField({ id, config, onChange }: Props & { id: string }) {
  const t = useTranslations("Flows.triggers.frequency");
  const value: TriggerFrequency = config.frequency === "once_per_24h" ? "once_per_24h" : "every_time";
  return (
    <div>
      <label htmlFor={id} className={label}>{t("label")}</label>
      <Select value={value} onValueChange={(frequency) => onChange({ ...config, frequency })}>
        <SelectTrigger id={id} className="bg-muted"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="every_time">{t("everyTime")}</SelectItem>
          <SelectItem value="once_per_24h">{t("oncePer24h")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

const MessageAccessNote = () => <p className={help}>{useTranslations("Flows.triggers")("needsMessageAccess")}</p>;

export function DefaultReplyTriggerFields({ config, onChange }: Props) {
  const t = useTranslations("Flows.triggers.defaultReply");
  return (
    <div className="space-y-3 md:col-span-2">
      <p className="text-muted-foreground text-xs">{t("help")}</p>
      <div className="max-w-xs"><FrequencyField id="trigger-frequency" config={config} onChange={onChange} /></div>
      <p className={help}>{t("oneOnly")}</p>
    </div>
  );
}

export function IgStoryMentionTriggerFields({ config, onChange }: Props) {
  const t = useTranslations("Flows.triggers.igStoryMention");
  const accounts = useInstagramAccounts();
  return (
    <div className="space-y-3 md:col-span-2">
      <p className="text-muted-foreground text-xs">{t("help")}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <AccountSelect id="trigger-ig-account" config={config} onChange={onChange} accounts={accounts} />
        <FrequencyField id="trigger-frequency" config={config} onChange={onChange} />
      </div>
      <MessageAccessNote />
    </div>
  );
}

/** Instagram ids as chips (stories have no picker: Meta lists only live stories). */
function IdChips({ id, ids, max, onChange, placeholder }: {
  id: string; ids: string[]; max: number; onChange: (ids: string[]) => void; placeholder: string;
}) {
  const tb = useTranslations("Flows.builder");
  const [draft, setDraft] = useState("");
  const add = (text = draft) => {
    const next = addIds(ids, text, max);
    if (next.length !== ids.length) onChange(next);
    setDraft("");
  };
  return (
    <div className="border-border bg-muted flex flex-wrap items-center gap-1.5 rounded-md border p-1.5">
      {ids.map((x) => (
        <span key={x} className="border-border bg-muted inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
          <span className="font-mono">{x}</span>
          <button type="button" aria-label={tb("removeKeyword", { keyword: x })} onClick={() => onChange(ids.filter((y) => y !== x))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input id={id} value={draft} inputMode="numeric" disabled={ids.length >= max}
        onChange={(e) => (/[\s,]$/.test(e.target.value) ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        onBlur={() => add()}
        placeholder={ids.length ? "" : placeholder}
        className="min-w-24 flex-1 bg-transparent px-1 font-mono text-sm outline-none" />
    </div>
  );
}

export function IgStoryReplyTriggerFields({ config, onChange }: Props) {
  const t = useTranslations("Flows.triggers.igStoryReply");
  const accounts = useInstagramAccounts();
  const storyIds = readStrings(config.story_ids);
  const [specific, setSpecific] = useState(storyIds.length > 0);
  return (
    <div className="space-y-3 md:col-span-2">
      <p className="text-muted-foreground text-xs">{t("help")}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <AccountSelect id="trigger-ig-account" config={config} onChange={onChange} accounts={accounts} />
        <div>
          <label htmlFor="trigger-story-scope" className={label}>{t("storyIds")}</label>
          <Select value={specific ? "specific" : "any"}
            onValueChange={(v) => {
              setSpecific(v === "specific");
              if (v === "any") onChange(withoutKey(config, "story_ids"));
            }}>
            <SelectTrigger id="trigger-story-scope" className="bg-muted"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">{t("anyStory")}</SelectItem>
              <SelectItem value="specific">{t("specificStories")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {specific && (
        <div>
          <IdChips id="trigger-story-ids" ids={storyIds} max={IG_TRIGGER_LIMITS.storyIds} placeholder="17890000000000000"
            onChange={(ids) => onChange(ids.length ? { ...config, story_ids: ids } : withoutKey(config, "story_ids"))} />
          <p className={help}>{t("storyIdsHelp", { max: IG_TRIGGER_LIMITS.storyIds })}</p>
        </div>
      )}
      <IgKeywordEditor id="trigger-story-keywords" label={t("keywords")} help={t("keywordsHelp")}
        keywords={readStrings(config.keywords)} mode={mode(config.match_mode)}
        onChange={({ keywords, mode: match_mode }) => onChange({ ...config, keywords, match_mode })} />
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={config.reactions === true} onChange={(e) => onChange({ ...config, reactions: e.target.checked })} />
        {t("reactions")}
      </label>
      <MessageAccessNote />
    </div>
  );
}

export function IgCommentTriggerFields({ config, onChange }: Props) {
  const t = useTranslations("Flows.triggers.igComment");
  const accounts = useInstagramAccounts();
  const scope: IgPostScope = config.post_scope === "specific" || config.post_scope === "next" ? config.post_scope : "any";
  const mediaIds = readStrings(config.media_ids);
  const chosenAccount = typeof config.instagram_account_id === "string" ? config.instagram_account_id : null;
  // Posts belong to one account: the chosen one, or the only one connected.
  const postsAccount = chosenAccount ?? (accounts.length === 1 ? accounts[0].id : null);
  const replies = setPublicReplies(readStrings(config.public_replies));
  return (
    <div className="space-y-4 md:col-span-2">
      <p className="text-muted-foreground text-xs">{t("help")}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <AccountSelect id="trigger-ig-account" config={config} onChange={onChange} accounts={accounts} />
        <div>
          <label htmlFor="trigger-post-scope" className={label}>{t("postScope")}</label>
          <Select value={scope} onValueChange={(v) => onChange(setPostScope(config, v as IgPostScope))}>
            <SelectTrigger id="trigger-post-scope" className="bg-muted"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">{t("postAny")}</SelectItem>
              <SelectItem value="specific">{t("postSpecific")}</SelectItem>
              <SelectItem value="next">{t("postNext")}</SelectItem>
            </SelectContent>
          </Select>
          {scope === "next" && <p className={help}>{t("postNextHelp")}</p>}
        </div>
      </div>

      {scope === "specific" && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className={label}>{t("choosePosts")}</span>
            <span className="text-muted-foreground text-[10px]">{t("postsChosen", { count: mediaIds.length })}</span>
          </div>
          {postsAccount ? (
            <IgPostPicker key={postsAccount} accountId={postsAccount} selected={mediaIds}
              onToggle={(id) => {
                const next = toggleMedia(config, id);
                // A chosen post pins the trigger to its account.
                onChange(chosenAccount || next === config ? next : { ...next, instagram_account_id: postsAccount });
              }} />
          ) : (
            <p className="text-muted-foreground text-xs">{t("chooseAccountFirst")}</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <IgKeywordEditor id="trigger-include" label={t("includeKeywords")} help={t("includeHelp")}
          keywords={readStrings(config.include_keywords)} mode={mode(config.include_mode)}
          onChange={({ keywords, mode: include_mode }) => onChange({ ...config, include_keywords: keywords, include_mode })} />
        <IgKeywordEditor id="trigger-exclude" label={t("excludeKeywords")}
          keywords={readStrings(config.exclude_keywords)} mode={mode(config.exclude_mode)}
          onChange={({ keywords, mode: exclude_mode }) => onChange({ ...config, exclude_keywords: keywords, exclude_mode })} />
      </div>

      <div>
        <span className={label}>{t("publicReplies")}</span>
        <IgReplyVariants id="trigger-public-reply" variants={replies} placeholder={t("publicReplyPlaceholder")}
          onChange={(next) => onChange({ ...config, public_replies: setPublicReplies(next) })}
          labels={{ add: t("addPublicReply"), remove: (n) => t("removeReply", { n }), variant: (n) => t("replyN", { n }) }} />
        <p className={help}>{t("publicRepliesHelp", { max: IG_TRIGGER_LIMITS.publicReplies })}</p>
      </div>
      <MessageAccessNote />
    </div>
  );
}

/** A comment on a Live broadcast: account and keywords (the first message is a private reply, as for post comments). */
export function IgLiveCommentTriggerFields({ config, onChange }: Props) {
  const t = useTranslations("Flows.triggers.igLiveComment");
  const accounts = useInstagramAccounts();
  return (
    <div className="space-y-3 md:col-span-2">
      <p className="text-muted-foreground text-xs">{t("help")}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <AccountSelect id="trigger-ig-account" config={config} onChange={onChange} accounts={accounts} />
      </div>
      <IgKeywordEditor id="trigger-live-keywords" label={t("keywords")} help={t("keywordsHelp")}
        keywords={readStrings(config.keywords)} mode={mode(config.match_mode)}
        onChange={({ keywords, mode: match_mode }) => onChange({ ...config, keywords, match_mode })} />
      <p className={help}>{t("liveOnly")}</p>
      <MessageAccessNote />
    </div>
  );
}

/** A ref link: the keys that start the flow, and the ig.me link for each on the chosen (or only) account. */
export function IgRefTriggerFields({ config, onChange }: Props) {
  const t = useTranslations("Flows.triggers.igRef");
  const tb = useTranslations("Flows.builder");
  const accounts = useInstagramAccounts();
  const [draft, setDraft] = useState("");
  const refs = readStrings(config.refs);
  const full = refs.length >= IG_TRIGGER_LIMITS.refs;
  const chosen = typeof config.instagram_account_id === "string" ? config.instagram_account_id : null;
  const account = accounts.find((a) => a.id === chosen) ?? (accounts.length === 1 ? accounts[0] : null);
  const add = (text = draft) => {
    const next = addRefKeys(refs, text);
    if (next.length !== refs.length) onChange({ ...config, refs: next });
    setDraft("");
  };
  const copy = (link: string) => {
    void navigator.clipboard?.writeText(link).then(() => toast.success(t("copied")), () => toast.error(t("copyFailed")));
  };
  return (
    <div className="space-y-3 md:col-span-2">
      <p className="text-muted-foreground text-xs">{t("help")}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <AccountSelect id="trigger-ig-account" config={config} onChange={onChange} accounts={accounts} />
      </div>
      <div>
        <label htmlFor="trigger-ref-keys" className={label}>{t("keys")}</label>
        <div className="border-border bg-muted flex flex-wrap items-center gap-1.5 rounded-md border p-1.5">
          {refs.map((key) => (
            <span key={key} className="border-border bg-muted inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
              <span className="font-mono">{key}</span>
              <button type="button" aria-label={tb("removeKeyword", { keyword: key })}
                onClick={() => onChange({ ...config, refs: refs.filter((k) => k !== key) })}>
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input id="trigger-ref-keys" value={draft} disabled={full} maxLength={80}
            onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            onBlur={() => add()}
            placeholder={refs.length ? "" : t("keysPlaceholder")}
            className="min-w-24 flex-1 bg-transparent px-1 font-mono text-sm outline-none" />
        </div>
        <p className={full ? "mt-1 text-[10px] text-amber-500" : help}>
          {full ? t("tooManyKeys", { max: IG_TRIGGER_LIMITS.refs }) : t("keysHelp", { max: IG_TRIGGER_LIMITS.refs })}
        </p>
      </div>
      {refs.length > 0 && (
        <div>
          <span className={label}>{t("links")}</span>
          {account?.username ? (
            <ul className="flex flex-col gap-1">
              {refs.map((key) => {
                const link = refLinkUrl(account.username ?? "", key);
                return link ? (
                  <li key={key} className="flex items-center gap-2 text-xs">
                    <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1">{link}</code>
                    <button type="button" aria-label={t("copyLink", { key })} onClick={() => copy(link)}
                      className="text-muted-foreground hover:text-foreground rounded p-1">
                      <Copy className="size-3.5" />
                    </button>
                  </li>
                ) : null;
              })}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs">{t("chooseAccountForLinks")}</p>
          )}
        </div>
      )}
      <MessageAccessNote />
    </div>
  );
}
