"use client";
import { authFetch } from "@/lib/auth/client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  KeyboardEvent,
} from "react";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Square,
  X,
  Loader2,
  Sparkles,
  Plus,
  MessageSquareDashed,
  Zap,
  ClipboardList,
  CreditCard,
  ShoppingBag,
  Store,
  Images,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "@/hooks/use-can";
import { shouldSendOnEnter } from '@/lib/inbox/composer-keyboard';
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";
import { useTranslations } from "next-intl";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import { validateInteractivePayload } from "@/lib/whatsapp/interactive";
import type { InteractiveMessagePayload, QuickReply } from "@/types";
import { QuickReplyPicker } from "./quick-reply-picker";
import { SendFormDialog } from "./send-form-dialog";
import { SendPaymentLinkDialog } from "./send-payment-link-dialog";
import { SendStorefrontLinkDialog } from "./send-storefront-link-dialog";
import { SendProductDialog } from "@/components/commerce/catalog/send-product-dialog";
import { MediaPicker, type PickedMedia } from "./media-library/media-picker";
import type { ConversationChannel } from "@/types";
import { instagramMediaAllowed } from "@/lib/channels/capabilities";
import { INSTAGRAM_LIMITS, utf8Bytes } from "@/lib/instagram/graph-limits";
import { instagramWindowBanner } from "@/lib/instagram/window";
import { AiReplySuggestions, type ReplyOptionView } from "./ai-assist/ai-reply-suggestions";
import { FollowUpBar } from "./follow-up-bar";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = "chat-media";

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /**
   * Storage object path — lets the caller GC the object if the send fails.
   * Empty for a media-library file, which the library owns and must never
   * be deleted by a failed send.
   */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
export type AttachMenuItem = "photo" | "video" | "document" | "voiceNote" | "mediaLibrary";

/**
 * Attach-menu entries per channel. Instagram gets no voice note (the
 * recorder only produces Ogg/Opus, which Meta's Instagram API refuses:
 * audio must be aac/m4a/wav/mp4) and no media library (library files are
 * not checked against Instagram's formats).
 */
/**
 * The composer's assist state after a conversation switch (null when the
 * conversation is unchanged): suggestions panel closed, no suggestion id, no
 * text carried over to the next customer.
 */
export function assistResetOnSwitch(
  shownFor: string,
  conversationId: string,
): { suggestionsOpen: false; aiSuggestionId: null; text: "" } | null {
  return shownFor === conversationId ? null : { suggestionsOpen: false, aiSuggestionId: null, text: "" };
}

export function attachMenuItems(isInstagram: boolean): AttachMenuItem[] {
  return isInstagram
    ? ["photo", "video", "document"]
    : ["photo", "video", "document", "voiceNote", "mediaLibrary"];
}

/** What Instagram accepts (Phase 11): png/jpeg, video, PDF. */
const INSTAGRAM_PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg",
  video: "video/mp4,video/3gpp",
  document: "application/pdf",
};

const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  /** `aiSuggestionId`: the text started as an AI suggested reply (recorded after the send). */
  onSend: (text: string, replyToId?: string, aiSuggestionId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  onSendInteractive: (payload: InteractiveMessagePayload, replyToId?: string) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  /**
   * The conversation's channel (from the row). On Instagram the composer
   * offers text, png/jpeg, audio, video and PDF only, counts the 1000-byte
   * limit and shows the Instagram reply window instead of the 24h template
   * hint. The server re-checks every send.
   */
  channel?: ConversationChannel;
  /** Instagram: the customer's last message (ISO), for the window banner. */
  lastCustomerAt?: string | null;
  /** Instagram: the session clock (ms), so the banner ticks with the thread. */
  now?: number;
  /** Instagram: Meta approved the Human Agent feature (staff replies up to 7 days). */
  humanAgentEnabled?: boolean;
  /**
   * Suggested replies are on for this workspace and member: the ✨ button
   * opens up to three options to review instead of the single AI draft.
   */
  assistSuggest?: boolean;
}

/** Time left in an Instagram reply window: "3d", "5h", "12m". */
function windowTimeLeft(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes >= 48 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  onSendInteractive,
  onOpenTemplates,
  replyTo,
  onClearReply,
  channel = "whatsapp",
  lastCustomerAt = null,
  now,
  humanAgentEnabled = false,
  assistSuggest = false,
}: MessageComposerProps) {
  const t = useTranslations("Inbox.composer");
  const tAssist = useTranslations("AiAssist");
  const tGate = useTranslations("GatedButton");
  const tc = useTranslations("Inbox.channel");
  const isInstagram = channel === "instagram";
  // Instagram: 24h standard window, then (only where Meta approved the Human
  // Agent feature, which the server checks) staff replies up to 7 days.
  const igBanner = isInstagram
    ? instagramWindowBanner(lastCustomerAt ? new Date(lastCustomerAt) : null, humanAgentEnabled, new Date(now ?? Date.now()))
    : null;
  const windowClosed = igBanner ? igBanner.kind === "closed" : sessionExpired;

  const [text, setText] = useState("");
  // Instagram caps a message at 1000 UTF-8 bytes (checked again on the server).
  const textBytes = isInstagram ? utf8Bytes(text.trim()) : 0;
  const overInstagramLimit = isInstagram && textBytes > INSTAGRAM_LIMITS.textBytes;
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  // Suggested replies panel, and the suggestion the current text came from.
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionsKey, setSuggestionsKey] = useState(0);
  const [aiSuggestionId, setAiSuggestionId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The composer is reused across conversations: on a switch, close the
  // suggestions panel (an open panel would otherwise generate, and spend
  // tokens, for the next conversation unasked) and drop the text and the
  // suggestion it came from, so one conversation's reply is never sent to
  // another customer.
  const [composerConversationId, setComposerConversationId] = useState(conversationId);
  const reset = assistResetOnSwitch(composerConversationId, conversationId);
  if (reset) {
    setComposerConversationId(conversationId);
    setSuggestionsOpen(reset.suggestionsOpen);
    setAiSuggestionId(reset.aiSuggestionId);
    setText(reset.text);
  }

  // Interactive-message builder dialog + quick-reply picker.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [interactivePayload, setInteractivePayload] =
    useState<InteractiveMessagePayload>(blankButtonsPayload);
  const [savingQuickReply, setSavingQuickReply] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const [sendFormOpen, setSendFormOpen] = useState(false);
  const [paymentLinkOpen, setPaymentLinkOpen] = useState(false);
  const [storefrontLinkOpen, setStorefrontLinkOpen] = useState(false);
  const [sendProductOpen, setSendProductOpen] = useState(false);
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  const attachItems = attachMenuItems(isInstagram);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  // (opus-recorder) so there's no server-side transcode.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan("send-messages");
  const readOnly = !canSend;
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || windowClosed;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC a staged-but-unsent
  // attachment so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || windowClosed) return;
    if (isInstagram && utf8Bytes(trimmed) > INSTAGRAM_LIMITS.textBytes) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id, aiSuggestionId ?? undefined);
      setText("");
      setAiSuggestionId(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, windowClosed, isInstagram, onSend, replyTo?.id, aiSuggestionId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (shouldSendOnEnter(e.nativeEvent, window.matchMedia('(pointer: coarse)').matches)) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      // Clearing the box drops the link to an AI suggestion.
      if (!e.target.value.trim()) setAiSuggestionId(null);
      adjustHeight();
    },
    [adjustHeight]
  );

  // Ask the AI assistant for a suggested reply and drop it into the
  // composer for the agent to edit + send. Read-only server-side —
  // nothing is sent until the agent hits Send.
  const handleDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const res = await authFetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      // A health or sensitive question, or a withheld draft: staff reply themselves.
      if (data.code === "route_to_staff") {
        toast.warning(tAssist("draftRouteToStaff"));
        return;
      }
      if (data.code === "guard_blocked") {
        toast.warning(tAssist("draftWithheld"));
        return;
      }
      if (!res.ok) {
        if (data.code === "ai_not_configured") {
          toast.error(t("aiNotConfigured"));
        } else if (data.code === "ai_disabled") {
          toast.error(tAssist("aiDisabled"));
        } else {
          toast.error(data.error ?? t("draftFailed"));
        }
        return;
      }
      const draftText = typeof data.draft === "string" ? data.draft.trim() : "";
      if (!draftText) {
        toast.error(t("draftEmpty"));
        return;
      }
      setText(draftText);
      setAiSuggestionId(null);
      // Let the textarea grow to fit and drop the cursor at the end so
      // the agent can tweak immediately.
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch {
      toast.error(t("aiUnreachable"));
    } finally {
      setDrafting(false);
    }
  }, [drafting, conversationId, adjustHeight, t, tAssist]);

  // ✨ with suggested replies on: open (or refresh) the options panel.
  const handleSuggest = useCallback(() => {
    setSuggestionsKey((k) => k + 1);
    setSuggestionsOpen(true);
  }, []);

  // "Use" puts the option in the box for the agent to edit; nothing is sent.
  const applySuggestion = useCallback((option: ReplyOptionView) => {
    setText(option.text);
    setAiSuggestionId(option.suggestionId);
    setSuggestionsOpen(false);
    requestAnimationFrame(() => {
      adjustHeight();
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, [adjustHeight]);

  // ---- Interactive message + quick replies --------------------------

  const openInteractiveBuilder = useCallback(
    (seed?: InteractiveMessagePayload) => {
      setInteractivePayload(seed ?? blankButtonsPayload());
      setInteractiveOpen(true);
    },
    [],
  );

  const sendInteractive = useCallback(() => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSendInteractive(interactivePayload, replyTo?.id);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [interactivePayload, onSendInteractive, replyTo?.id, onClearReply]);

  // Persist the current builder payload as a reusable interactive snippet.
  const saveAsQuickReply = useCallback(async () => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const title = window
      .prompt(t("quickReplyNamePrompt"))
      ?.trim();
    if (!title) return;
    setSavingQuickReply(true);
    try {
      const res = await authFetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          kind: "interactive",
          interactive_payload: interactivePayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("quickReplySaveError"));
        return;
      }
      toast.success(t("quickReplySaved"));
    } catch {
      toast.error(t("quickReplySaveError"));
    } finally {
      setSavingQuickReply(false);
    }
  }, [interactivePayload, t]);

  // A picked quick reply: text fills the composer; interactive opens the
  // builder pre-filled so the agent can tweak before sending.
  const handlePickQuickReply = useCallback(
    (qr: QuickReply) => {
      setQuickReplyOpen(false);
      if (qr.kind === "interactive" && qr.interactive_payload) {
        // Saved replies insert text on Instagram; interactive ones are WhatsApp-only.
        if (isInstagram) {
          toast.error(tc("notOnChannel"));
          return;
        }
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      const body = qr.content_text ?? "";
      // Separate the snippet from any existing draft with a newline so the
      // words don't run together ("Thanks" + "we'll…" → "Thankswe'll…").
      setText((prev) =>
        prev && !/\s$/.test(prev) ? `${prev}\n${body}` : `${prev}${body}`,
      );
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    },
    [openInteractiveBuilder, adjustHeight, isInstagram, tc],
  );

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      if (isInstagram && !instagramMediaAllowed(file.type, file.size).ok) {
        toast.error(tc("notOnChannel"));
        return;
      }
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          t("fileTooLarge", {
            size: (file.size / 1024 / 1024).toFixed(1),
            kind: t(`mediaKind.${kind}`),
            max: Math.round(max / 1024 / 1024),
          }),
        );
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        // Replacing an existing draft? GC the previous object first.
        removeStaged(draftRef.current?.path);
        setDraft({ kind, mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, t, isInstagram, tc],
  );

  const handlePicked = useCallback(
    (kind: "image" | "video" | "document", file: File | undefined) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload],
  );

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  // The encoded Ogg/Opus file from opus-recorder → upload as an audio
  // draft. WhatsApp renders Ogg/Opus as a playable voice note.
  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error(t("recordingTooLong"));
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        removeStaged(draftRef.current?.path);
        setDraft({ kind: "audio", mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, t],
  );

  const startRecording = useCallback(async () => {
    // Instagram refuses the recorder's Ogg/Opus output; the menu hides the
    // entry, and this keeps any other caller from starting a doomed take.
    if (isInstagram || inputsDisabled || busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error(t("recordingUnsupported"));
      return;
    }
    try {
      // Lazy-load the encoder (≈400 KB worker) only when the user records,
      // keeping it out of the main bundle.
      const { default: Recorder } = await import("opus-recorder");
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes);
      };
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error(t("microphoneDenied"));
    }
  }, [isInstagram, inputsDisabled, busy, recording, finalizeRecording, t]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  // Auto-stop at the cap so a forgotten recording can't blow the
  // upload size limit.
  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  // A media-library file becomes a draft with no staged path: the library
  // owns the object, so discarding or a failed send must not delete it.
  const handlePickLibraryMedia = useCallback(
    (media: PickedMedia) => {
      removeStaged(draftRef.current?.path);
      setDraft({
        kind: media.kind,
        mediaUrl: media.url,
        path: "",
        filename: media.filename,
        caption: "",
      });
    },
    [removeStaged],
  );

  // ---- Draft send / discard -----------------------------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      // Audio takes no caption (Meta rejects it). Everything else: the
      // trimmed caption, or undefined when blank.
      caption:
        draft.kind === "audio" ? undefined : draft.caption.trim() || undefined,
      filename: draft.kind === "document" ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // ---- Render --------------------------------------------------------

  return (
    <div className="studio-composer border-t border-border bg-card p-3 sm:p-4">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {igBanner && (
        <div
          data-instagram-window={igBanner.kind}
          className={cn(
            "mb-2 rounded-lg px-3 py-2 text-xs",
            igBanner.kind === "open"
              ? "bg-muted text-muted-foreground"
              : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
          )}
        >
          {igBanner.kind === "closed"
            ? tc("windowClosed")
            : tc(igBanner.kind === "open" ? "windowOpen" : "windowHumanAgent", {
                time: windowTimeLeft(igBanner.closesAt.getTime() - (now ?? Date.now())),
              })}
        </div>
      )}
      {!draft && !recording && (
        <FollowUpBar
          conversationId={conversationId}
          channel={isInstagram ? "instagram" : "whatsapp"}
          draftText={text}
          readOnly={readOnly}
          scheduleDisabled={windowClosed || overInstagramLimit}
          onScheduled={() => {
            setText("");
            setAiSuggestionId(null);
            if (textareaRef.current) textareaRef.current.style.height = "auto";
          }}
        />
      )}
      {!isInstagram && sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("sessionExpiredHint")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t("templates")}
          </Button>
        </div>
      )}

      {suggestionsOpen && !readOnly && (
        <AiReplySuggestions
          key={`${conversationId}:${suggestionsKey}`}
          conversationId={conversationId}
          onUse={applySuggestion}
          onClose={() => setSuggestionsOpen(false)}
        />
      )}

      {/* Hidden file inputs driven by the attach menu. */}
      <input
        ref={imageInputRef}
        type="file"
        accept={(isInstagram ? INSTAGRAM_PICKER_ACCEPT : PICKER_ACCEPT).image}
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={(isInstagram ? INSTAGRAM_PICKER_ACCEPT : PICKER_ACCEPT).video}
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={(isInstagram ? INSTAGRAM_PICKER_ACCEPT : PICKER_ACCEPT).document}
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          allowCaption={!isInstagram}
          onDiscard={discardDraft}
          onSend={sendDraft}
          t={t}
        />
      ) : recording ? (
        // Recording bar — replaces the composer while the mic is live.
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-2.5">
          <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="flex-1 text-sm text-foreground">
            {t("recording", { current: formatDuration(recordSeconds), max: formatDuration(MAX_RECORDING_SECONDS) })}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
          >
            {t("cancel")}
          </button>
          <Button
            size="sm"
            onClick={stopRecording}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90"
            title={t("stopAndAttach")}
          >
            <Square className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          {/* Attach menu — photo / video / document / voice. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled || busy}
              title={
                readOnly
                  ? t("readOnlyTitle")
                  : inputsDisabled
                    ? undefined
                    : t("attachMedia")
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                <ImageIcon className="mr-2 h-4 w-4" />
                {t("photo")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                <Video className="mr-2 h-4 w-4" />
                {t("video")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                <FileText className="mr-2 h-4 w-4" />
                {t("document")}
              </DropdownMenuItem>
              {attachItems.includes("voiceNote") && (
                <DropdownMenuItem onClick={() => void startRecording()}>
                  <Mic className="mr-2 h-4 w-4" />
                  {t("voiceNote")}
                </DropdownMenuItem>
              )}
              {attachItems.includes("mediaLibrary") && (
                <DropdownMenuItem onClick={() => setMediaLibraryOpen(true)}>
                  <Images className="mr-2 h-4 w-4" />
                  {t("mediaLibrary")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* + menu — interactive messages + quick replies. Gated on the
              24h window like free-form text (interactive requires it). */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled}
              title={
                readOnly
                  ? t("readOnlyTitle")
                  : inputsDisabled
                    ? undefined
                    : t("moreActions")
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              {!isInstagram && (
                <DropdownMenuItem onClick={() => openInteractiveBuilder()}>
                  <MessageSquareDashed className="mr-2 h-4 w-4" />
                  {t("interactiveMessage")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setQuickReplyOpen(true)}>
                <Zap className="mr-2 h-4 w-4" />
                {t("quickReplies")}
              </DropdownMenuItem>
              {!isInstagram && (
                <DropdownMenuItem onClick={() => setSendFormOpen(true)}>
                  <ClipboardList className="mr-2 h-4 w-4" />
                  {t("sendForm")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setPaymentLinkOpen(true)}>
                <CreditCard className="mr-2 h-4 w-4" />
                {t("sendPaymentLink")}
              </DropdownMenuItem>
              {!isInstagram && (
                <DropdownMenuItem onClick={() => setSendProductOpen(true)}>
                  <ShoppingBag className="mr-2 h-4 w-4" />
                  {t("sendProducts")}
                </DropdownMenuItem>
              )}
              {canSend && (
                <DropdownMenuItem onClick={() => setStorefrontLinkOpen(true)}>
                  <Store className="mr-2 h-4 w-4" />
                  {t("sendStorefrontLink")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {!isInstagram && (
            <GatedButton
              variant="ghost"
              size="sm"
              canAct={!readOnly}
              gateReason={tGate("reasons.sendMessages")}
              title={readOnly ? undefined : t("sendTemplate")}
              className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
              onClick={onOpenTemplates}
            >
              <LayoutTemplate className="h-4 w-4" />
            </GatedButton>
          )}

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason={tGate("reasons.sendMessages")}
            disabled={drafting}
            title={readOnly ? undefined : assistSuggest ? tAssist("suggestReplies") : t("draftWithAI")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-primary"
            onClick={assistSuggest ? handleSuggest : handleDraft}
          >
            {drafting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </GatedButton>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              readOnly
                ? t("readOnlyPlaceholder")
                : windowClosed
                  ? isInstagram
                    ? tc("windowClosed")
                    : t("sessionExpiredPlaceholder")
                  : t("typeMessagePlaceholder")
            }
            disabled={windowClosed || readOnly}
            rows={1}
            // Textarea keeps its own inline title — the GatedButton
            // wrapping pattern doesn't apply to non-button inputs.
            // The placeholder text also surfaces the read-only state.
            title={readOnly ? t("readOnlyTitle") : undefined}
            className={cn(
              "min-w-0 flex-1 resize-none rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50",
              (windowClosed || readOnly) && "cursor-not-allowed opacity-50"
            )}
          />

          <GatedButton
            size="sm"
            canAct={!readOnly}
            gateReason={tGate("reasons.sendMessages")}
            disabled={!text.trim() || windowClosed || sending || overInstagramLimit}
            onClick={handleSend}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </GatedButton>
        </div>
      )}

      {/* Hint sits outside the flex row so its height doesn't push
          `items-end` buttons below the textarea. Indented to line up
          under the textarea left edge. */}
      {!draft && !recording && (
        <p className="mt-1 pl-[5.5rem] text-[10px] text-muted-foreground">
          {t("draftHint")}
          {isInstagram && (
            <span
              data-instagram-bytes
              className={cn("ml-2 tabular-nums", overInstagramLimit && "text-red-600 dark:text-red-400")}
            >
              {tc("byteCounter", { used: textBytes, max: INSTAGRAM_LIMITS.textBytes })}
            </span>
          )}
        </p>
      )}

      {/* Interactive-message builder dialog. */}
      <Dialog open={interactiveOpen} onOpenChange={setInteractiveOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("interactiveMessage")}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto">
            <InteractiveBuilder
              value={interactivePayload}
              onChange={setInteractivePayload}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingQuickReply}
              onClick={saveAsQuickReply}
            >
              {savingQuickReply ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-1 h-4 w-4" />
              )}
              {t("saveAsQuickReply")}
            </Button>
            <Button onClick={sendInteractive}>
              <Send className="mr-1 h-4 w-4" />
              {t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SendFormDialog open={sendFormOpen} onOpenChange={setSendFormOpen} conversationId={conversationId} />
      <SendPaymentLinkDialog open={paymentLinkOpen} onOpenChange={setPaymentLinkOpen} conversationId={conversationId} />
      <SendStorefrontLinkDialog open={storefrontLinkOpen} onOpenChange={setStorefrontLinkOpen} conversationId={conversationId} />
      <SendProductDialog open={sendProductOpen} onOpenChange={setSendProductOpen} conversationId={conversationId} />

      <MediaPicker
        open={mediaLibraryOpen}
        onOpenChange={setMediaLibraryOpen}
        onPick={handlePickLibraryMedia}
      />

      {/* Quick-reply picker. */}
      <QuickReplyPicker
        open={quickReplyOpen}
        onOpenChange={setQuickReplyOpen}
        onPick={handlePickQuickReply}
      />
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  allowCaption = true,
  onDiscard,
  onSend,
  t,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  /** Instagram has no media captions. */
  allowCaption?: boolean;
  onDiscard: () => void;
  onSend: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tGate = useTranslations("GatedButton");
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />
          )}
          {draft.kind === "audio" && (
            <audio src={draft.mediaUrl} controls className="w-full" />
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t("removeAttachment")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {allowCaption && draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (shouldSendOnEnter(e.nativeEvent, window.matchMedia('(pointer: coarse)').matches)) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t("addCaption")}
            className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
          />
        )}
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason={tGate("reasons.sendMessages")}
          disabled={busy}
          onClick={onSend}
          className={cn(
            "h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40",
            (draft.kind === "audio" || !allowCaption) && "ml-auto",
          )}
        >
          <Send className="h-4 w-4" />
        </GatedButton>
      </div>
    </div>
  );
}
