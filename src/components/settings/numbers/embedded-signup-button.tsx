"use client";

/**
 * "Connect with Facebook": Meta's Embedded Signup popup. Hidden unless
 * NEXT_PUBLIC_META_APP_ID and NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID are
 * set. The popup returns a one-time code (FB.login) and, through a
 * WA_EMBEDDED_SIGNUP window message from facebook.com (Embedded Signup v5),
 * the WABA and phone number the admin picked; both go to /api/whatsapp/embedded-signup, which
 * exchanges the code server side. Mount it next to "Add number manually".
 *
 * Before the popup the admin may enter the number's existing two-step PIN
 * (optional); without it the server sets a fresh one and shows it once. When
 * Meta rejects the PIN, a retry dialog asks for it and finishes registration
 * of the saved row ({ config_id, pin }), so no second signup is needed.
 * The PIN is never logged and is cleared from state after each request.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";
import { EMBEDDED_SIGNUP_EXTRAS, embeddedSignupPublicConfig, parseEmbeddedSignupMessage } from "@/lib/whatsapp/embedded-signup";

const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
const GRAPH_VERSION = "v21.0";

type FbLoginResponse = { authResponse?: { code?: string; accessToken?: string } | null; status?: string };
type FbSdk = {
  init: (opts: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }) => void;
  login: (cb: (response: FbLoginResponse) => void, opts: Record<string, unknown>) => void;
};
declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

let sdkPromise: Promise<FbSdk> | null = null;
function loadSdk(appId: string): Promise<FbSdk> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<FbSdk>((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION });
      resolve(window.FB);
      return;
    }
    window.fbAsyncInit = () => {
      if (!window.FB) return reject(new Error("sdk"));
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION });
      resolve(window.FB);
    };
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("sdk"));
    };
    document.body.appendChild(script);
  });
  return sdkPromise;
}

export interface EmbeddedSignupConnected {
  id: string;
  phone_number_id: string;
  waba_id: string | null;
  display_name: string | null;
  status: string;
  is_default: boolean;
}

const PIN_RE = /^\d{6}$/;
const onlyDigits = (value: string) => value.replace(/\D/g, "").slice(0, 6);

export type SignupResponse = {
  error?: unknown;
  code?: unknown;
  pin?: unknown;
  config_id?: unknown;
  number?: EmbeddedSignupConnected;
};

/** What the dialog does with an answer from /api/whatsapp/embedded-signup. */
export type SignupOutcome =
  | { kind: "connected"; number: EmbeddedSignupConnected | null; generatedPin: string | null }
  | { kind: "retryPin"; configId: string; error: string; generatedPin: null }
  | { kind: "failed"; error: string; generatedPin: string | null };

export function signupOutcome(ok: boolean, json: SignupResponse, fallback: string): SignupOutcome {
  const generatedPin = typeof json.pin === "string" ? json.pin : null;
  const error = typeof json.error === "string" ? json.error : fallback;
  if (ok) return { kind: "connected", number: json.number ?? null, generatedPin };
  if ((json.code === "pinMismatch" || json.code === "pinLocked") && typeof json.config_id === "string") {
    return { kind: "retryPin", configId: json.config_id, error, generatedPin: null };
  }
  return { kind: "failed", error, generatedPin };
}

export function EmbeddedSignupButton({
  canEdit,
  onConnected,
}: {
  canEdit: boolean;
  onConnected?: (number: EmbeddedSignupConnected) => void;
}) {
  const t = useTranslations("Settings.embeddedSignup");
  const config = embeddedSignupPublicConfig();
  const [busy, setBusy] = useState(false);
  // A PIN the server generated, shown once.
  const [pin, setPin] = useState<string | null>(null);
  // Optional existing PIN, asked before the popup opens.
  const [askPin, setAskPin] = useState(false);
  const [existingPin, setExistingPin] = useState("");
  // Meta rejected the PIN: retry registration of the saved row with the right one.
  const [retry, setRetry] = useState<{ configId: string; error: string } | null>(null);
  const [retryPin, setRetryPin] = useState("");
  const [retrying, setRetrying] = useState(false);
  // The popup's message arrives separately from FB.login's callback; whichever comes second submits.
  const session = useRef<{ code: string | null; wabaId: string | null; phoneNumberId: string | null; pin: string | null; sent: boolean } | null>(null);

  const post = useCallback(
    async (body: Record<string, string>) => {
      const res = await authFetch("/api/whatsapp/embedded-signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const outcome = signupOutcome(res.ok, await res.json().catch(() => ({})), t("failed"));
      if (outcome.generatedPin) setPin(outcome.generatedPin);
      if (outcome.kind === "failed") throw new Error(outcome.error);
      if (outcome.kind === "retryPin") {
        setRetryPin("");
        setRetry({ configId: outcome.configId, error: outcome.error });
        return;
      }
      setRetry(null);
      toast.success(t("connected", { name: outcome.number?.display_name || outcome.number?.phone_number_id || "" }));
      if (outcome.number) onConnected?.(outcome.number);
    },
    [onConnected, t]
  );

  const submit = useCallback(async () => {
    const s = session.current;
    if (!s || s.sent || !s.code || !s.wabaId || !s.phoneNumberId) return;
    s.sent = true;
    try {
      await post({
        code: s.code,
        waba_id: s.wabaId,
        phone_number_id: s.phoneNumberId,
        ...(s.pin ? { pin: s.pin } : {}),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      session.current = null;
      setBusy(false);
    }
  }, [post, t]);

  const submitRetry = async () => {
    if (!retry || !PIN_RE.test(retryPin) || retrying) return;
    setRetrying(true);
    try {
      await post({ config_id: retry.configId, pin: retryPin });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      setRetryPin("");
      setRetrying(false);
    }
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const parsed = parseEmbeddedSignupMessage(event.origin, event.data);
      const s = session.current;
      if (!parsed || !s) return;
      if (parsed.kind === "finish") {
        s.wabaId = parsed.wabaId;
        s.phoneNumberId = parsed.phoneNumberId;
        void submit();
      } else if (parsed.kind === "bizApp") {
        session.current = null;
        setBusy(false);
        toast.error(t("bizAppUnsupported"));
      } else if (parsed.kind === "cancel") {
        session.current = null;
        setBusy(false);
        toast.message(t("cancelled"));
      } else {
        session.current = null;
        setBusy(false);
        toast.error(t("failed"));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [submit, t]);

  if (!config) return null;

  const openPinPrompt = () => {
    setExistingPin("");
    setAskPin(true);
    // Warm the SDK so the popup opens straight from the Continue click.
    void loadSdk(config.appId).catch(() => undefined);
  };

  const start = async () => {
    const givenPin = PIN_RE.test(existingPin) ? existingPin : null;
    setAskPin(false);
    setExistingPin("");
    setBusy(true);
    session.current = { code: null, wabaId: null, phoneNumberId: null, pin: givenPin, sent: false };
    let fb: FbSdk;
    try {
      fb = await loadSdk(config.appId);
    } catch {
      session.current = null;
      setBusy(false);
      toast.error(t("sdkFailed"));
      return;
    }
    fb.login(
      (response) => {
        const code = response.authResponse?.code;
        const s = session.current;
        if (!s) return;
        if (!code) {
          session.current = null;
          setBusy(false);
          return;
        }
        s.code = code;
        void submit();
        // A finished popup without the window message (e.g. it was blocked) would otherwise spin forever.
        window.setTimeout(() => {
          if (session.current === s && !s.sent) {
            session.current = null;
            setBusy(false);
            toast.error(t("noNumberPicked"));
          }
        }, 15_000);
      },
      {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: EMBEDDED_SIGNUP_EXTRAS,
      }
    );
  };

  const existingPinInvalid = existingPin !== "" && !PIN_RE.test(existingPin);

  return (
    <>
      <Button type="button" variant="outline" onClick={openPinPrompt} disabled={!canEdit || busy}>
        {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        {t("button")}
      </Button>
      <Dialog open={askPin} onOpenChange={(open) => { if (!open) { setAskPin(false); setExistingPin(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("existingPinTitle")}</DialogTitle>
            <DialogDescription>{t("existingPinDescription")}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!existingPinInvalid) void start();
            }}
          >
            <Label htmlFor="es-existing-pin">{t("existingPinLabel")}</Label>
            <Input
              id="es-existing-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={existingPin}
              aria-invalid={existingPinInvalid}
              onChange={(e) => setExistingPin(onlyDigits(e.target.value))}
            />
            {existingPinInvalid ? <p className="text-sm text-destructive">{t("pinInvalid")}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={existingPinInvalid}>{t("continue")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={retry !== null} onOpenChange={(open) => { if (!open && !retrying) { setRetry(null); setRetryPin(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("retryPinTitle")}</DialogTitle>
            <DialogDescription>{t("retryPinDescription")}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submitRetry();
            }}
          >
            <p role="alert" className="text-sm text-destructive">{retry?.error}</p>
            <Label htmlFor="es-retry-pin">{t("existingPinLabel")}</Label>
            <Input
              id="es-retry-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={retryPin}
              onChange={(e) => setRetryPin(onlyDigits(e.target.value))}
            />
            <DialogFooter>
              <Button type="submit" disabled={!PIN_RE.test(retryPin) || retrying}>
                {retrying ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                {t("retryPin")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={pin !== null} onOpenChange={(open) => { if (!open) setPin(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("pinTitle")}</DialogTitle>
            <DialogDescription>{t("pinDescription")}</DialogDescription>
          </DialogHeader>
          <p className="text-center font-mono text-3xl tracking-[0.4em] text-foreground">{pin}</p>
          <DialogFooter>
            <Button type="button" onClick={() => setPin(null)}>{t("pinDone")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
