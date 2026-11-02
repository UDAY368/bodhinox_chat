"use client";

// Workspace lists the flow forms pick from. Each loads once per form
// mount and falls back to an empty list, leaving manual entry possible.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/data/client";
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
