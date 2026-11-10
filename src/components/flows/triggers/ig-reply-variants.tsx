"use client";

/**
 * Up to 3 text variants, one picked per comment (the comment trigger's public
 * replies and the "Reply to comment" step share it). Each variant is cut to
 * Instagram's comment length while typing.
 */

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { addVariant, MAX_REPLY_VARIANTS, removeVariant, setVariant } from "../nodes/ig-node-config";

export function IgReplyVariants({ id, variants, onChange, keepOne = false, placeholder, labels }: {
  id: string;
  variants: string[];
  onChange: (next: string[]) => void;
  /** A comment-reply step keeps at least one variant. */
  keepOne?: boolean;
  placeholder?: string;
  labels: { add: string; remove: (n: number) => string; variant: (n: number) => string };
}) {
  return (
    <div className="flex flex-col gap-2">
      {variants.map((text, i) => (
        <div key={i} className="flex items-start gap-2">
          <Textarea
            id={`${id}-${i}`}
            aria-label={labels.variant(i + 1)}
            value={text}
            rows={2}
            placeholder={placeholder}
            onChange={(e) => onChange(setVariant(variants, i, e.target.value))}
            className="bg-muted"
          />
          <Button type="button" variant="ghost" size="sm" aria-label={labels.remove(i + 1)}
            disabled={keepOne && variants.length <= 1}
            onClick={() => onChange(removeVariant(variants, i, keepOne))}
            className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {variants.length < MAX_REPLY_VARIANTS && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onChange(addVariant(variants))}>
          <Plus className="mr-1 h-3.5 w-3.5" />{labels.add}
        </Button>
      )}
    </div>
  );
}
