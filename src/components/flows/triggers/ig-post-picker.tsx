"use client";

/**
 * The comment trigger's post picker: the chosen Instagram account's posts and
 * reels (GET /api/instagram/accounts/{id}/media, agent and up), ticked to
 * listen on. Posts load when the picker opens, not on every render; "Load
 * more" reads the next page; reels carry a badge and an All / Posts / Reels
 * filter. A failure offers a retry and keeps the ids already chosen.
 */

import { useEffect, useState } from "react";
import { Check, Clapperboard, Image as ImageIcon, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import { cn } from "@/lib/utils";
import type { InstagramMedia } from "@/lib/instagram/graph";

/** A connected Instagram account as the trigger editors list it (from GET /api/instagram/status). */
/** A connected account for the trigger pickers; `username` (without @) builds ref links. */
export interface PickerAccount { id: string; label: string; username?: string | null }

interface StatusAccount { id: string; username: string | null; name: string | null; igUserId: string; status: string }

/** The workspace's live Instagram accounts; empty while Instagram is off or on failure. */
export function useInstagramAccounts(): PickerAccount[] {
  const [accounts, setAccounts] = useState<PickerAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/instagram/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { enabled?: boolean; accounts?: StatusAccount[] } | null) => {
        if (cancelled || !json?.enabled || !Array.isArray(json.accounts)) return;
        setAccounts(json.accounts.filter((a) => a.status !== "disconnected")
          .map((a) => ({ id: a.id, label: a.username ? `@${a.username}` : a.name ?? a.igUserId, username: a.username })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return accounts;
}

/**
 * Whether the Share-to-Story trigger is on for this deployment (INSTAGRAM_SHARE_TO_STORY_ENABLED, from
 * GET /api/instagram/status). False while loading and on failure, so the picker never offers a trigger
 * that cannot fire; a flow that already has it keeps showing it.
 */
export function useShareToStoryEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/instagram/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { enabled?: boolean; shareToStoryEnabled?: boolean } | null) => {
        if (!cancelled) setEnabled(json?.enabled === true && json.shareToStoryEnabled === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; posts: InstagramMedia[]; next: string | null };
type Kind = "all" | "posts" | "reels";
const KINDS: Kind[] = ["all", "posts", "reels"];

/** One page of the account's posts and reels (`after`: the cursor of an earlier page), or null on failure. */
export async function loadPosts(accountId: string, after?: string | null, fetcher: typeof authFetch = authFetch):
  Promise<{ posts: InstagramMedia[]; next: string | null } | null> {
  try {
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    const res = await fetcher(`/api/instagram/accounts/${encodeURIComponent(accountId)}/media${query}`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { posts?: InstagramMedia[]; next?: unknown } | null;
    if (!Array.isArray(json?.posts)) return null;
    return { posts: json.posts, next: typeof json.next === "string" ? json.next : null };
  } catch {
    return null;
  }
}

/** Adds a later page to the loaded posts; a post on both pages (published in between) is kept once. */
export function mergePostPages(loaded: InstagramMedia[], page: InstagramMedia[]): InstagramMedia[] {
  const seen = new Set(loaded.map((p) => p.id));
  return [...loaded, ...page.filter((p) => !seen.has(p.id))];
}

/** `onLoaded` hands every loaded post to the parent (the quick-automation preview shows the chosen one). */
export function IgPostPicker({ accountId, selected, onToggle, onLoaded }: {
  accountId: string;
  selected: string[];
  onToggle: (mediaId: string) => void;
  onLoaded?: (posts: InstagramMedia[]) => void;
}) {
  const t = useTranslations("Flows.triggers.igComment");
  // The parent keys this picker by account, so a new account starts over at "loading".
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [kind, setKind] = useState<Kind>("all");
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => {
    let cancelled = false;
    void loadPosts(accountId).then((page) => {
      if (cancelled) return;
      setLoad(page ? { state: "ready", posts: page.posts, next: page.next } : { state: "failed" });
      if (page) onLoaded?.(page.posts);
    });
    return () => {
      cancelled = true;
    };
    // onLoaded only reports; refetching whenever the parent re-renders would cost an Instagram call each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, attempt]);
  const retry = () => {
    setLoad({ state: "loading" });
    setAttempt((n) => n + 1);
  };
  const loadMore = async () => {
    if (load.state !== "ready" || !load.next) return;
    setMore("loading");
    const page = await loadPosts(accountId, load.next);
    if (!page) {
      setMore("failed");
      return;
    }
    const posts = mergePostPages(load.posts, page.posts);
    setLoad({ state: "ready", posts, next: page.next });
    setMore("idle");
    onLoaded?.(posts);
  };

  if (load.state === "loading") {
    return <p className="text-muted-foreground flex items-center gap-2 text-xs"><Loader2 className="size-3.5 animate-spin" />{t("loadingPosts")}</p>;
  }
  if (load.state === "failed") {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-destructive">{t("postsLoadFailed")}</span>
        <Button type="button" variant="outline" size="sm" onClick={retry}>{t("retry")}</Button>
      </div>
    );
  }
  // Chosen posts that are no longer among the loaded ones stay listed by id, so they can be removed.
  const known = new Set(load.posts.map((p) => p.id));
  const older = selected.filter((id) => !known.has(id));
  if (load.posts.length === 0 && older.length === 0) return <p className="text-muted-foreground text-xs">{t("noPosts")}</p>;
  const shown = load.posts.filter((p) => kind === "all" || (kind === "reels") === p.isReel);
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label={t("filterLabel")} className="flex gap-1">
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
            className={cn("rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              kind === k ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground")}>
            {t(`filter.${k}`)}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="group" aria-label={t("choosePosts")}>
        {shown.map((post) => {
          const on = selected.includes(post.id);
          const caption = post.caption?.trim() || t("untitledPost");
          return (
            <button key={post.id} type="button" aria-pressed={on} title={caption}
              aria-label={post.isReel ? `${t("reel")}: ${caption}` : caption} onClick={() => onToggle(post.id)}
              className={cn("relative aspect-square overflow-hidden rounded-md border text-left",
                on ? "border-primary ring-primary ring-2" : "border-border hover:border-primary/50")}>
              {post.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN URLs; next/image would need every CDN host configured.
                <img src={post.previewUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="bg-muted text-muted-foreground flex h-full w-full items-center justify-center"><ImageIcon className="size-5" /></span>
              )}
              {post.isReel && (
                <span className="absolute top-1 left-1 flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[9px] font-semibold text-white">
                  <Clapperboard className="size-2.5" aria-hidden />{t("reel")}
                </span>
              )}
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-[10px] text-white">{caption}</span>
              {on && <span className="bg-primary text-primary-foreground absolute top-1 right-1 rounded-full p-0.5"><Check className="size-3" /></span>}
            </button>
          );
        })}
        {older.map((id) => (
          <button key={id} type="button" aria-pressed onClick={() => onToggle(id)}
            className="border-primary ring-primary bg-muted relative flex aspect-square items-center justify-center rounded-md border p-1 font-mono text-[10px] ring-2">
            {id}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="text-muted-foreground text-xs">{t(kind === "reels" ? "noReels" : "noPosts")}</p>}
      {load.next && (
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={more === "loading"} onClick={() => void loadMore()}>
            {more === "loading" ? <><Loader2 className="size-3.5 animate-spin" />{t("loadingPosts")}</> : t("loadMore")}
          </Button>
          {more === "failed" && <span className="text-destructive text-xs" role="alert">{t("postsLoadFailed")}</span>}
        </div>
      )}
    </div>
  );
}
