"use client";

/**
 * Per-node configuration form, dispatched by node_type.
 *
 * One component, ten branches. Each branch renders the inputs that
 * map onto the node's `config` JSONB shape (text + buttons for
 * send_buttons, prompt + var_key for collect_input, etc.) and forwards
 * edits up via `onUpdateConfig`.
 *
 * Why this lives in src/components/flows/forms/ instead of next to
 * the list editor: PR 2 (canvas editing) needs to mount the same
 * form in a side panel when a user clicks a node on the canvas.
 * Keeping the per-node forms here means there's exactly one place
 * where each form's behaviour and validation lives — drift between
 * "what the list editor shows" and "what the canvas side panel
 * shows" becomes impossible.
 *
 * `showAdvanced` is the disclosure that surfaces internal
 * identifiers (node_key, button reply_id, list row reply_id) — owned
 * by the host (NodeCard / SideSheet) so the toggle is rendered
 * outside this form alongside whatever delete/cancel buttons that
 * host wants. The form just reads the boolean and conditionally
 * renders the advanced rows.
 */

import { useCallback, useRef, useState } from "react";
import {
  Loader2,
  Paperclip,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { uploadAccountMedia, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";
import { slugify, type BuilderNode } from "../shared";
import { NextNodeRow, NodeKeySelect, TextRow } from "./fields";
import { ConditionForm, QuestionForm, SetAttributeForm, TimingFields } from "./question-forms";
import { useUserTags } from "./use-pickers";
import { ApiRequestForm, AssignAgentForm, ConnectFlowForm, SendTemplateForm } from "./integration-forms";

interface NodeConfigFormProps {
  node: BuilderNode;
  allNodes: BuilderNode[];
  showAdvanced: boolean;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}

export function NodeConfigForm(props: NodeConfigFormProps) {
  const t = useTranslations("Flows.builder.form");
  return (
    <>
      <NodeFields {...props} />
      <TimingFields node={props.node} allNodes={props.allNodes} onUpdateConfig={props.onUpdateConfig} t={t} />
    </>
  );
}

function NodeFields({
  node,
  allNodes,
  showAdvanced,
  onUpdateConfig,
}: NodeConfigFormProps) {
  const t = useTranslations("Flows.builder.form");
  const cfg = node.config;
  switch (node.node_type) {
    case "start":
      return (
        <NextNodeRow
          value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
          allNodes={allNodes}
          currentKey={node.node_key}
          onChange={(v) => onUpdateConfig({ next_node_key: v })}
          label={t("advancesTo")}
        />
      );

    case "send_message":
      return (
        <>
          <TextRow
            label={t("textToCustomer")}
            value={(cfg as { text?: string }).text ?? ""}
            onChange={(v) => onUpdateConfig({ text: v })}
            rows={3}
          />
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label={t("advancesTo")}
          />
        </>
      );

    case "send_buttons":
      return (
        <SendButtonsForm
          cfg={cfg as SendButtonsCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          showAdvanced={showAdvanced}
          t={t}
        />
      );

    case "send_list":
      return (
        <SendListForm
          cfg={cfg as SendListCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          showAdvanced={showAdvanced}
          t={t}
        />
      );

    case "send_media":
      return (
        <SendMediaForm
          cfg={cfg as SendMediaCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          t={t}
        />
      );

    case "collect_input":
    case "ask_media":
    case "ask_location":
    case "ask_address":
      return <QuestionForm node={node} allNodes={allNodes} onUpdateConfig={onUpdateConfig} t={t} />;

    case "set_attribute":
      return <SetAttributeForm node={node} allNodes={allNodes} onUpdateConfig={onUpdateConfig} t={t} />;

    case "send_template":
      return <SendTemplateForm node={node} allNodes={allNodes} onUpdateConfig={onUpdateConfig} t={t} />;

    case "api_request":
      return <ApiRequestForm node={node} allNodes={allNodes} onUpdateConfig={onUpdateConfig} t={t} />;

    case "assign_agent":
      return <AssignAgentForm node={node} allNodes={allNodes} onUpdateConfig={onUpdateConfig} t={t} />;

    case "connect_flow":
      return <ConnectFlowForm node={node} allNodes={allNodes} onUpdateConfig={onUpdateConfig} t={t} />;

    case "condition":
      return <ConditionForm node={node} allNodes={allNodes} onUpdateConfig={onUpdateConfig} t={t} />;

    case "set_tag":
      return (
        <SetTagForm
          cfg={cfg as SetTagCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          t={t}
        />
      );

    case "handoff":
      return (
        <TextRow
          label={t("internalNote")}
          value={(cfg as { note?: string }).note ?? ""}
          onChange={(v) => onUpdateConfig({ note: v })}
          rows={2}
        />
      );

    case "end":
      return (
        <p className="text-xs text-muted-foreground">
          {t("endNodeHelp")}
        </p>
      );
  }
}

// ============================================================
// send_buttons
// ============================================================

interface SendButtonsCfg {
  text?: string;
  footer_text?: string;
  buttons?: Array<{ reply_id: string; title: string; next_node_key: string }>;
}

function SendButtonsForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  showAdvanced,
  t,
}: {
  cfg: SendButtonsCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  showAdvanced: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const buttons = cfg.buttons ?? [];
  const updateButton = (
    idx: number,
    patch: Partial<NonNullable<SendButtonsCfg["buttons"]>[number]>,
  ) => {
    onUpdateConfig({
      buttons: buttons.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    });
  };
  const addButton = () =>
    onUpdateConfig({
      buttons: [
        ...buttons,
        {
          reply_id: `btn_${buttons.length + 1}`,
          title: t("defaultOptionTitle"),
          next_node_key: "",
        },
      ],
    });
  const removeButton = (idx: number) =>
    onUpdateConfig({ buttons: buttons.filter((_, i) => i !== idx) });

  return (
    <>
      <TextRow
        label={t("bodyText")}
        value={cfg.text ?? ""}
        onChange={(v) => onUpdateConfig({ text: v })}
        rows={3}
      />
      <TextRow
        label={t("footerText")}
        value={cfg.footer_text ?? ""}
        onChange={(v) => onUpdateConfig({ footer_text: v })}
      />
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-xs text-muted-foreground">
            {t("buttonsHelp")}
          </label>
        </div>
        <div className="flex flex-col gap-3">
          {buttons.map((b, i) => (
            <div
              key={i}
              className={cn(
                "grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/40 p-3",
                showAdvanced
                  ? "md:grid-cols-[1fr_2fr_2fr_auto]"
                  : "md:grid-cols-[2fr_2fr_auto]",
              )}
            >
              {showAdvanced && (
                <Input
                  value={b.reply_id}
                  onChange={(e) =>
                    updateButton(i, {
                      reply_id: slugify(e.target.value, `btn_${i + 1}`),
                    })
                  }
                  placeholder="reply_id"
                  className="bg-muted font-mono text-xs"
                />
              )}
              <Input
                value={b.title}
                onChange={(e) => updateButton(i, { title: e.target.value })}
                placeholder={t("optionTitlePlaceholder")}
                className="bg-muted"
                maxLength={20}
              />
              <NodeKeySelect
                value={b.next_node_key || null}
                nodes={allNodes}
                excludeKey={currentKey}
                onChange={(v) => updateButton(i, { next_node_key: v ?? "" })}
                placeholder={t("nextNodePlaceholder")}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeButton(i)}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        {buttons.length < 3 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={addButton}
            className="mt-2"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("addButton")}
          </Button>
        )}
      </div>
    </>
  );
}

// ============================================================
// send_list
// ============================================================

interface SendListCfg {
  text?: string;
  button_label?: string;
  footer_text?: string;
  sections?: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
}

function SendListForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  showAdvanced,
  t,
}: {
  cfg: SendListCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  showAdvanced: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const sections = cfg.sections ?? [];
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0);

  const updateSection = (
    sIdx: number,
    patch: Partial<NonNullable<SendListCfg["sections"]>[number]>,
  ) => {
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, ...patch } : s,
      ),
    });
  };
  const addSection = () =>
    onUpdateConfig({
      sections: [
        ...sections,
        {
          title: "",
          rows: [
            {
              reply_id: `row_${totalRows + 1}`,
              title: t("optionN", { n: totalRows + 1 }),
              next_node_key: "",
            },
          ],
        },
      ],
    });
  const removeSection = (sIdx: number) =>
    onUpdateConfig({ sections: sections.filter((_, i) => i !== sIdx) });
  const updateRow = (
    sIdx: number,
    rIdx: number,
    patch: Partial<
      NonNullable<SendListCfg["sections"]>[number]["rows"][number]
    >,
  ) => {
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: s.rows.map((r, j) => (j === rIdx ? { ...r, ...patch } : r)),
            }
          : s,
      ),
    });
  };
  const addRow = (sIdx: number) =>
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: [
                ...s.rows,
                {
                  reply_id: `row_${totalRows + 1}`,
                  title: t("optionN", { n: totalRows + 1 }),
                  next_node_key: "",
                },
              ],
            }
          : s,
      ),
    });
  const removeRow = (sIdx: number, rIdx: number) =>
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, rows: s.rows.filter((_, j) => j !== rIdx) } : s,
      ),
    });

  return (
    <>
      <TextRow
        label={t("bodyText")}
        value={cfg.text ?? ""}
        onChange={(v) => onUpdateConfig({ text: v })}
        rows={3}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TextRow
          label={t("buttonLabel")}
          value={cfg.button_label ?? ""}
          onChange={(v) => onUpdateConfig({ button_label: v })}
        />
        <TextRow
          label={t("footerText")}
          value={cfg.footer_text ?? ""}
          onChange={(v) => onUpdateConfig({ footer_text: v })}
        />
      </div>

      <div className="mt-2">
        <label className="mb-2 block text-xs text-muted-foreground">
          {t("rowsHelp")}
        </label>
        {sections.map((section, sIdx) => (
          <div
            key={sIdx}
            className="mb-3 rounded-md border border-border bg-muted/40 p-3"
          >
            <div className="mb-2 flex items-center gap-2">
              <Input
                value={section.title ?? ""}
                onChange={(e) =>
                  updateSection(sIdx, { title: e.target.value })
                }
                placeholder={t("sectionTitlePlaceholder", { count: sIdx + 1 })}
                className="bg-muted text-xs"
              />
              {sections.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeSection(sIdx)}
                  className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  aria-label={t("removeSection")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {section.rows.map((row, rIdx) => (
              <div
                key={rIdx}
                className={cn(
                  "mb-2 grid grid-cols-1 gap-2",
                  showAdvanced
                    ? "md:grid-cols-[1fr_2fr_2fr_auto]"
                    : "md:grid-cols-[2fr_2fr_auto]",
                )}
              >
                {showAdvanced && (
                  <Input
                    value={row.reply_id}
                    onChange={(e) =>
                      updateRow(sIdx, rIdx, {
                        reply_id: slugify(
                          e.target.value,
                          `row_${rIdx + 1}`,
                        ),
                      })
                    }
                    placeholder="reply_id"
                    className="bg-muted font-mono text-xs"
                  />
                )}
                <Input
                  value={row.title}
                  onChange={(e) =>
                    updateRow(sIdx, rIdx, { title: e.target.value })
                  }
                  placeholder={t("rowTitlePlaceholder")}
                  className="bg-muted"
                  maxLength={24}
                />
                <NodeKeySelect
                  value={row.next_node_key || null}
                  nodes={allNodes}
                  excludeKey={currentKey}
                  onChange={(v) =>
                    updateRow(sIdx, rIdx, { next_node_key: v ?? "" })
                  }
                  placeholder={t("nextNodePlaceholder")}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(sIdx, rIdx)}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {totalRows < 10 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => addRow(sIdx)}
                className="mt-1"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("addRow")}
              </Button>
            )}
          </div>
        ))}
        {/* WhatsApp's interactive-list spec caps sections at 10. Group rows
            by category (Billing / Support / Sales etc.) to give customers a
            scannable menu. */}
        {sections.length < 10 && (
          <Button variant="outline" size="sm" onClick={addSection}>
            <Plus className="h-3.5 w-3.5" />
            {t("addSection")}
          </Button>
        )}
      </div>
    </>
  );
}

// ============================================================
// set_tag
// ============================================================

interface SetTagCfg {
  mode?: "add" | "remove";
  tag_id?: string;
  next_node_key?: string;
}

function SetTagForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: SetTagCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tags = useUserTags();

  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t("actionLabel")}</label>
          <Select
            value={cfg.mode ?? "add"}
            onValueChange={(v) =>
              onUpdateConfig({ mode: v as SetTagCfg["mode"] })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="add">{t("addTag")}</SelectItem>
              <SelectItem value="remove">{t("removeTag")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t("tagLabel")}</label>
          {tags.length > 0 ? (
            <Select
              value={cfg.tag_id ?? ""}
              onValueChange={(v) => onUpdateConfig({ tag_id: v })}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue placeholder={t("pickTag")} />
              </SelectTrigger>
              <SelectContent>
                {tags.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={cfg.tag_id ?? ""}
              onChange={(e) => onUpdateConfig({ tag_id: e.target.value })}
              placeholder={t("tagUuidPlaceholder")}
              className="bg-muted font-mono text-xs"
            />
          )}
        </div>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("thenAdvanceTo")}
      />
    </>
  );
}

// ============================================================
// send_media
// ============================================================

interface SendMediaCfg {
  media_type?: "image" | "video" | "document";
  media_url?: string;
  caption?: string;
  filename?: string;
  next_node_key?: string;
}

// Mirrors the bucket's allowed_mime_types from migration 016. Kept in
// sync with the storage policy so the picker rejects unsupported files
// before they hit the network rather than failing with a confusing
// Supabase RLS / mime-type error.
export const MEDIA_ACCEPT: Record<NonNullable<SendMediaCfg["media_type"]>, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

export const FLOW_MEDIA_BUCKET = "flow-media";

function SendMediaForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: SendMediaCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const mediaType = cfg.media_type ?? "image";
  const isDocument = mediaType === "document";
  const displayName =
    cfg.filename ||
    (cfg.media_url ? cfg.media_url.split("/").pop() ?? "" : "");

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > MEDIA_MAX_BYTES) {
        toast.error(
          t("fileTooLarge", { size: (file.size / 1024 / 1024).toFixed(1) }),
        );
        return;
      }
      setUploading(true);
      try {
        // Account-scoped upload (path `account-<id>/...`) — see
        // uploadAccountMedia + migration 020's flow-media RLS policy.
        const { publicUrl } = await uploadAccountMedia(FLOW_MEDIA_BUCKET, file);
        // Patch all fields in one call so the form doesn't re-render
        // with a half-uploaded state.
        onUpdateConfig({
          media_url: publicUrl,
          filename: file.name,
        });
        toast.success(t("fileUploaded"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("uploadFailed");
        toast.error(msg);
      } finally {
        setUploading(false);
      }
    },
    [onUpdateConfig, t],
  );

  const handleClear = () => {
    onUpdateConfig({ media_url: "", filename: "" });
  };

  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t("mediaTypeLabel")}</label>
        <Select
          value={mediaType}
          onValueChange={(v) => {
            // Changing type clears the existing file — the bucket
            // accepts different MIME sets per type and a previously
            // uploaded PDF can't be sent as an image.
            onUpdateConfig({
              media_type: v as NonNullable<SendMediaCfg["media_type"]>,
              media_url: "",
              filename: "",
            });
          }}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="image">{t("imageLabel")}</SelectItem>
            <SelectItem value="video">{t("videoLabel")}</SelectItem>
            <SelectItem value="document">
              {t("documentLabel")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t("fileLabel")}</label>
        {cfg.media_url ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <a
              href={cfg.media_url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-foreground hover:text-cyan-300"
              title={displayName || cfg.media_url}
            >
              {displayName || cfg.media_url}
            </a>
            <button
              type="button"
              onClick={handleClear}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t("removeFile")}
              disabled={uploading}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("uploading")}
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5" />
                {t("clickToUpload")}
              </>
            )}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={MEDIA_ACCEPT[mediaType]}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = "";
          }}
        />
      </div>

      <TextRow
        label={t("captionLabel")}
        value={cfg.caption ?? ""}
        onChange={(v) => onUpdateConfig({ caption: v })}
        rows={2}
      />

      {isDocument && (
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("filenameLabel")}
          </label>
          <Input
            value={cfg.filename ?? ""}
            onChange={(e) => onUpdateConfig({ filename: e.target.value })}
            placeholder={t("filenamePlaceholder")}
            className="bg-muted text-xs"
          />
        </div>
      )}

      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advanceAfterSending")}
      />
    </>
  );
}
