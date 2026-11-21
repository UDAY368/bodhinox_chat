"use client";
import { authFetch } from "@/lib/auth/client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  History,
  Loader2,
  SearchX,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { flowRunDuration } from '@/lib/flows/run-duration';

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { GroupedList } from "@/components/ui/grouped-list";
import { InlineError } from "@/components/ui/inline-error";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { OptionSelect } from "@/components/ui/option-select";
import { cn } from "@/lib/utils";
import { RUN_STATUSES, STATUS_META, EventLine, runStatusKey, type EventRow, type RunRow } from "./run-shared";

/**
 * Run history viewer.
 *
 * Lists a flow's runs, newest first, 50 at a time ("Load more" follows
 * the server's cursor), filtered by status and version. Each row
 * collapses to a one-liner (contact + status + version + time);
 * expanding shows the `flow_run_events` timeline, and "Details" opens
 * the run page (outbound intent states, replay and cancel).
 */

export default function FlowRunsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const t = useTranslations("Flows.logs");
  const tEdit = useTranslations("Flows.edit");

  const [flow, setFlow] = useState<{ id: string; name: string } | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [versions, setVersions] = useState<Array<{ id: string; version: number }>>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [versionFilter, setVersionFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notFound, setNotFound] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  const fetchPage = useCallback(async (before: string | null) => {
    const query = new URLSearchParams();
    if (statusFilter) query.set("status", statusFilter);
    if (versionFilter) query.set("version", versionFilter);
    if (before) query.set("before", before);
    const res = await authFetch(`/api/flows/${params.id}/runs?${query.toString()}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return (await res.json()) as {
      flow: { id: string; name: string };
      runs: RunRow[];
      events: EventRow[];
      versions: Array<{ id: string; version: number }>;
      next_cursor: string | null;
    };
  }, [params.id, statusFilter, versionFilter]);

  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    (async () => {
      setLoadFailed(false);
      try {
        const json = await fetchPage(null);
        if (cancelled) return;
        if (!json) {
          setNotFound(true);
          return;
        }
        setFlow(json.flow);
        setRuns(json.runs ?? []);
        setEvents(json.events ?? []);
        setVersions(json.versions ?? []);
        setCursor(json.next_cursor);
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setLoadFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id, fetchPage, retryToken]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const json = await fetchPage(cursor);
      if (!json) return;
      setRuns((prev) => [...prev, ...json.runs]);
      setEvents((prev) => [...prev, ...json.events]);
      setCursor(json.next_cursor);
    } catch (err) {
      console.error(err);
      toast.error(t("loadError"));
    } finally {
      setLoadingMore(false);
    }
  }

  function toggle(runId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  if (loading) {
    return <div className="mx-auto max-w-4xl p-6"><PageLoading /></div>;
  }
  if (loadFailed && !notFound) {
    return (
      <InlineError
        message={t("loadError")}
        onRetry={() => {
          setLoading(true);
          setRetryToken((n) => n + 1);
        }}
      />
    );
  }
  if (notFound || !flow) {
    return (
      <EmptyState
        icon={SearchX}
        title={tEdit("notFound")}
        action={<Button variant="outline" onClick={() => router.push("/flows")}>{tEdit("backToFlows")}</Button>}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <button
        type="button"
        onClick={() => router.push(`/flows/${flow.id}`)}
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        {flow.name}
      </button>
      <PageHeader title={t("title")} subtitle={t("description")} className="mb-4">
        <OptionSelect
          size="sm"
          className="w-auto text-xs"
          aria-label={t("filterStatus")}
          value={statusFilter}
          onValueChange={setStatusFilter}
          options={[
            { value: "", label: t("filterAllStatuses") },
            ...RUN_STATUSES.map((s) => ({ value: s, label: t(runStatusKey(s)) })),
          ]}
        />
        <OptionSelect
          size="sm"
          className="w-auto text-xs"
          aria-label={t("filterVersion")}
          value={versionFilter}
          onValueChange={setVersionFilter}
          options={[
            { value: "", label: t("filterAllVersions") },
            ...versions.map((v) => ({ value: v.id, label: t("versionLabel", { version: v.version }) })),
            { value: "none", label: t("filterUnversioned") },
          ]}
        />
      </PageHeader>

      {runs.length === 0 ? (
        <EmptyState icon={History} title={t("emptyState")} />
      ) : (
        <div className="flex flex-col gap-2">
          <GroupedList>
          {runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              events={events.filter((e) => e.flow_run_id === run.id)}
              expanded={expanded.has(run.id)}
              onToggle={() => toggle(run.id)}
              detailHref={`/flows/${flow.id}/runs/${run.id}`}
              t={t}
            />
          ))}
          </GroupedList>
          {cursor && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="mx-auto mt-2 inline-flex items-center gap-1 text-xs text-primary hover:opacity-80 disabled:opacity-50"
            >
              {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
              {t("loadMore")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RunCard({
  run,
  events,
  expanded,
  onToggle,
  detailHref,
  t,
}: {
  run: RunRow;
  events: EventRow[];
  expanded: boolean;
  onToggle: () => void;
  detailHref: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const meta = STATUS_META[run.status] ?? STATUS_META.failed;
  const StatusIcon = meta.icon;
  const contactLabel =
    run.contact?.name?.trim() || run.contact?.phone || t("unknownContact");
  const duration = flowRunDuration(run.started_at, run.ended_at);
  return (
    <div className="border-t border-separator first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {contactLabel}
            </span>
            <Badge variant="outline" className={cn("gap-1", meta.classes)}>
              <StatusIcon className="h-3 w-3" />
              {t(runStatusKey(run.status))}
            </Badge>
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {run.version ? t("versionLabel", { version: run.version }) : t("unversioned")}
            </span>
            {run.status === "active" && run.current_node_key && (
              <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t("atNode", { node: run.current_node_key })}
              </code>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{t("started", { time: format(new Date(run.started_at), "PP p") })}</span>
            {run.reprompt_count > 0 && (
              <span>· {t("reprompts", { count: run.reprompt_count })}</span>
            )}
            {duration && <span>· {t("ranFor", { duration })}</span>}
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <Link href={detailHref} className="mb-2 inline-flex items-center gap-1 text-xs text-primary hover:opacity-80">
            <ExternalLink className="h-3 w-3" />
            {t("openDetails")}
          </Link>
          {Object.keys(run.vars).length > 0 && (
            <details className="mb-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("capturedVars", { count: Object.keys(run.vars).length })}
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-background p-2 text-[11px] text-muted-foreground">
                {JSON.stringify(run.vars, null, 2)}
              </pre>
            </details>
          )}
          <div className="flex flex-col gap-1">
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("noEvents")}
              </p>
            ) : (
              events.map((ev, ix) => <EventLine key={ix} ev={ev} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}
