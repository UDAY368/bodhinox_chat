"use client";

// Browser-side calls to /api/whatsapp/forms. Every request goes through
// authFetch, which adds the session and the mutation-origin headers.

import { authFetch } from "@/lib/auth/client";
import type { FormCategory, FormDefinition, FormStatus, WhatsAppForm } from "@/lib/whatsapp/forms/types";

export interface FormListItem {
  id: string;
  name: string;
  category: FormCategory;
  status: FormStatus;
  response_count?: number;
  updated_at: string;
}

export interface FormApiError {
  path?: string;
  message: string;
}

export interface FormResponseRow {
  id: string;
  created_at: string;
  contact: { id: string; name: string | null; phone: string | null } | null;
  answers: Record<string, unknown>;
  labels: Record<string, string>;
}

export type FormResult =
  | { ok: true; form: WhatsAppForm }
  | { ok: false; status: number; errors: FormApiError[]; error?: string };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function formResult(res: Response): Promise<FormResult> {
  const json = await readJson(res);
  if (res.ok && json.form) return { ok: true, form: json.form as WhatsAppForm };
  const errors = Array.isArray(json.errors) ? (json.errors as FormApiError[]) : [];
  return { ok: false, status: res.status, errors, error: typeof json.error === "string" ? json.error : undefined };
}

export async function listForms(): Promise<FormListItem[]> {
  const res = await authFetch("/api/whatsapp/forms", { cache: "no-store" });
  if (!res.ok) throw new Error(`forms ${res.status}`);
  const json = await readJson(res);
  return (json.forms as FormListItem[] | undefined) ?? [];
}

export async function createForm(body: { name: string; category: FormCategory }): Promise<FormResult> {
  return formResult(await authFetch("/api/whatsapp/forms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** Null when the form does not exist in this account (404). */
export async function getForm(id: string): Promise<WhatsAppForm | null> {
  const res = await authFetch(`/api/whatsapp/forms/${id}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`form ${res.status}`);
  return ((await readJson(res)).form as WhatsAppForm | undefined) ?? null;
}

export async function saveForm(
  id: string,
  body: { name: string; category: FormCategory; definition: FormDefinition; uses_endpoint: boolean },
): Promise<FormResult> {
  return formResult(await authFetch(`/api/whatsapp/forms/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function publishForm(id: string): Promise<FormResult> {
  return formResult(await authFetch(`/api/whatsapp/forms/${id}/publish`, { method: "POST" }));
}

export async function duplicateForm(id: string): Promise<FormResult> {
  return formResult(await authFetch(`/api/whatsapp/forms/${id}/duplicate`, { method: "POST" }));
}

export async function deleteForm(id: string): Promise<boolean> {
  const res = await authFetch(`/api/whatsapp/forms/${id}`, { method: "DELETE" });
  return res.ok;
}

/** False when the key is missing or the caller can't see its status. */
export async function loadEncryptionStatus(): Promise<{ configured: boolean; uploaded_at: string | null }> {
  try {
    const res = await authFetch("/api/whatsapp/forms/encryption-key", { cache: "no-store" });
    if (!res.ok) return { configured: false, uploaded_at: null };
    const json = await readJson(res);
    return { configured: json.configured === true, uploaded_at: (json.uploaded_at as string | null) ?? null };
  } catch {
    return { configured: false, uploaded_at: null };
  }
}

export async function listResponses(
  id: string,
  cursor: string | null,
  limit = 50,
): Promise<{ responses: FormResponseRow[]; next_cursor: string | null }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const res = await authFetch(`/api/whatsapp/forms/${id}/responses?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`responses ${res.status}`);
  const json = await readJson(res);
  return {
    responses: (json.responses as FormResponseRow[] | undefined) ?? [],
    next_cursor: (json.next_cursor as string | null | undefined) ?? null,
  };
}

/** Downloads the CSV export; resolves false when the server refused it. */
export async function exportResponses(id: string): Promise<boolean> {
  const res = await authFetch(`/api/whatsapp/forms/${id}/responses/export`);
  if (!res.ok) return false;
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "form-responses.csv";
  link.click();
  URL.revokeObjectURL(url);
  return true;
}
