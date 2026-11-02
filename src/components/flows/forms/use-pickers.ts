"use client";

// Workspace lists the flow forms pick from. Each loads once per form
// mount and falls back to an empty list, leaving manual entry possible.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/data/client";
import { authFetch } from "@/lib/auth/client";
import { loadFlowTags, type FlowTag } from "../load-tags";

export interface FlowCustomField {
  id: string;
  field_name: string;
}

function useLoaded<T>(load: () => Promise<T[]>): T[] {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    let cancelled = false;
    load().then((loaded) => !cancelled && setItems(loaded)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [load]);
  return items;
}

async function loadCustomFields(): Promise<FlowCustomField[]> {
  try {
    const { data, error } = await createClient().from<FlowCustomField>("custom_fields").select("id,field_name").order("field_name");
    return error ? [] : data ?? [];
  } catch {
    return [];
  }
}

/** Shared by `condition` (subject=tag) and `set_tag`; manual UUID entry remains a fallback. */
export function useUserTags(): FlowTag[] {
  return useLoaded(loadFlowTags);
}

export function useCustomFields(): FlowCustomField[] {
  return useLoaded(loadCustomFields);
}

export interface FlowTemplate {
  id: string;
  name: string;
  language: string | null;
  body_text: string;
  header_type: string | null;
  header_content: string | null;
  header_media_url: string | null;
  buttons: Array<{ type: string; text: string; url?: string }> | null;
}

/**
 * Whether a flow can send this template: the step fills only body values
 * and quick-reply payloads, so a header value, a media header without a
 * stored file, or a URL button with a value would fail on every send.
 */
export function templateFlowSendable(t: FlowTemplate): boolean {
  if (t.header_type === "text" && /\{\{\s*\d+\s*\}\}/.test(t.header_content ?? "")) return false;
  if ((t.header_type === "image" || t.header_type === "video" || t.header_type === "document") && !t.header_media_url) return false;
  return !(t.buttons ?? []).some((b) => b.type === "URL" && /\{\{/.test(b.url ?? ""));
}

export interface FlowSummary {
  id: string;
  name: string;
  status: string;
}

export interface FlowMember {
  user_id: string;
  full_name: string;
  role: string;
}

async function loadApprovedTemplates(): Promise<FlowTemplate[]> {
  try {
    const { data, error } = await createClient().from<FlowTemplate>("message_templates")
      .select("id,name,language,body_text,header_type,header_content,header_media_url,buttons").eq("status", "APPROVED").order("name");
    return error ? [] : data ?? [];
  } catch {
    return [];
  }
}

async function loadFlows(): Promise<FlowSummary[]> {
  try {
    const { data, error } = await createClient().from<FlowSummary>("flows").select("id,name,status").order("name");
    return error ? [] : data ?? [];
  } catch {
    return [];
  }
}

async function loadMembers(): Promise<FlowMember[]> {
  try {
    const res = await authFetch("/api/account/members", { cache: "no-store" });
    if (!res.ok) return [];
    const json = (await res.json()) as { members?: FlowMember[] };
    return (json.members ?? []).filter((m) => m.role !== "viewer");
  } catch {
    return [];
  }
}

const loadSendableTemplates = async () => (await loadApprovedTemplates()).filter(templateFlowSendable);
const loadQuickReplyTemplates = async () =>
  (await loadApprovedTemplates()).filter((t) => (t.buttons ?? []).some((b) => b.type === "QUICK_REPLY"));

/** Approved templates a flow can send (see templateFlowSendable): Meta refuses anything unapproved. */
export function useApprovedTemplates(): FlowTemplate[] {
  return useLoaded(loadSendableTemplates);
}

/** Approved templates with quick-reply buttons, whoever sends them (a broadcast, say). */
export function useQuickReplyTemplates(): FlowTemplate[] {
  return useLoaded(loadQuickReplyTemplates);
}

async function loadIceBreakers(): Promise<string[]> {
  try {
    const res = await authFetch("/api/whatsapp/ice-breakers", { cache: "no-store" });
    if (!res.ok) return [];
    const json = (await res.json()) as { prompts?: string[] };
    return json.prompts ?? [];
  } catch {
    return [];
  }
}

/** The number's ice breakers, offered as exact keywords. */
export function useIceBreakers(): string[] {
  return useLoaded(loadIceBreakers);
}

export function useFlowList(): FlowSummary[] {
  return useLoaded(loadFlows);
}

/** Members who can own a conversation (viewers cannot). */
export function useAssignableMembers(): FlowMember[] {
  return useLoaded(loadMembers);
}
