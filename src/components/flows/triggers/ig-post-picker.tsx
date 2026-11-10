"use client";

/**
 * The comment trigger's post picker: the chosen Instagram account's recent
 * posts (GET /api/instagram/accounts/{id}/media, agent and up), ticked to
 * listen on. Posts load when the picker opens, not on every render; a
 * failure offers a retry and keeps the ids already chosen.
 */

import { useEffect, useState } from "react";
import { Check, Image as ImageIcon, Loader2 } from "lucide-react";
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

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; posts: InstagramMedia[] };

export async function loadPosts(accountId: string, fetcher: typeof authFetch = authFetch): Promise<InstagramMedia[] | null> {
  try {
    const res = await fetcher(`/api/instagram/accounts/${encodeURIComponent(accountId)}/media`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { posts?: InstagramMedia[] } | null;
    return Array.isArray(json?.posts) ? json.posts : null;
  } catch {
    return null;
  }
}

export function IgPostPicker({ accountId, selected, onToggle }: {
  accountId: string;
  selected: string[];
  onToggle: (mediaId: string) => void;
}) {
  const t = useTranslations("Flows.triggers.igComment");
  // The parent keys this picker by account, so a new account starts over at "loading".
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void loadPosts(accountId).then((posts) => {
      if (!cancelled) setLoad(posts ? { state: "ready", posts } : { state: "failed" });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, attempt]);
  const retry = () => {
    setLoad({ state: "loading" });
    setAttempt((n) => n + 1);
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
  // Chosen posts that are no longer among the recent ones stay listed by id, so they can be removed.
  const known = new Set(load.posts.map((p) => p.id));
  const older = selected.filter((id) => !known.has(id));
  if (load.posts.length === 0 && older.length === 0) return <p className="text-muted-foreground text-xs">{t("noPosts")}</p>;
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="group" aria-label={t("choosePosts")}>
      {load.posts.map((post) => {
        const on = selected.includes(post.id);
        const caption = post.caption?.trim() || t("untitledPost");
        return (
          <button key={post.id} type="button" aria-pressed={on} title={caption} onClick={() => onToggle(post.id)}
            className={cn("relative aspect-square overflow-hidden rounded-md border text-left",
              on ? "border-primary ring-primary ring-2" : "border-border hover:border-primary/50")}>
            {post.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN URLs; next/image would need every CDN host configured.
              <img src={post.previewUrl} alt={caption} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <span className="bg-muted text-muted-foreground flex h-full w-full items-center justify-center"><ImageIcon className="size-5" /></span>
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
  );
}
