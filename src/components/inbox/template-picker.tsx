"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/data/client";
import type { MessageTemplate } from "@/types";
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
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ChevronRight,
  LayoutTemplate,
  Loader2,
} from "lucide-react";
import {
  COUPON_CODE_MAX_LENGTH,
  templateSendNeeds,
  type TemplateSendNeeds,
} from "@/lib/whatsapp/template-send-params";
import {
  AUTH_CODE_MAX_LENGTH,
  type SendTimeParams,
} from "@/lib/whatsapp/template-send-builder";
import { useTranslations } from "next-intl";

/** Everything the picker collected; sent as `template_message_params`. */
export type TemplateSendValues = SendTimeParams & { body: string[] };

interface TemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: MessageTemplate, values: TemplateSendValues) => void;
}

function renderBodyPreview(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    const value = params[idx];
    return value && value.trim().length > 0 ? value : `{{${raw}}}`;
  });
}

/**
 * Whether the agent must type anything before this template goes out:
 * variables, a location, an offer end, a one-time code or carousel card
 * values. A copy-code button alone falls back to its stored example, as
 * before, so it never blocks a one-click send.
 */
function needsInput(n: TemplateSendNeeds): boolean {
  return (
    n.bodyVars.length > 0 ||
    n.headerVarCount > 0 ||
    n.urlButtons.length > 0 ||
    n.location ||
    n.offerExpiration ||
    n.authCode ||
    n.cards.some((c) => c.bodyVars.length > 0 || c.urlButtons.length > 0)
  );
}

interface LocationDraft {
  latitude: string;
  longitude: string;
  name: string;
  address: string;
}
const EMPTY_LOCATION: LocationDraft = { latitude: "", longitude: "", name: "", address: "" };

interface CardDraft {
  body: string[];
  buttonParams: Record<number, string>;
}

/** A coordinate typed into the form, or null when it is not a valid number in range. */
function coordinate(raw: string, limit: number): number | null {
  if (!raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** `datetime-local` value -> epoch ms in the agent's time zone, or null. */
function localDateTimeMs(raw: string): number | null {
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const inputClass =
  "border-border bg-muted text-foreground placeholder:text-muted-foreground";

export function TemplatePicker({
  open,
  onOpenChange,
  onSelect,
}: TemplatePickerProps) {
  const t = useTranslations("Inbox.templatePicker");

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MessageTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [headerText, setHeaderText] = useState<string>("");
  const [buttonParams, setButtonParams] = useState<Record<number, string>>({});
  const [location, setLocation] = useState<LocationDraft>(EMPTY_LOCATION);
  const [offerEnds, setOfferEnds] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [cards, setCards] = useState<CardDraft[]>([]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const db = createClient();
      const {
        data: { user },
      } = await db.auth.getUser();

      if (!user) {
        if (!cancelled) {
          setTemplates([]);
          setLoading(false);
        }
        return;
      }

      // Scope by RLS (message_templates_select → is_account_member), NOT by
      // user_id. Templates are account-owned, so filtering on the caller's
      // user_id hid templates that a teammate created — leaving them unable
      // to send approved templates in a shared account.
      const { data, error } = await db
        .from("message_templates")
        .select("*")
        .eq("status", "APPROVED")
        .order("created_at", { ascending: false });

      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch templates:", error);
        setTemplates([]);
      } else {
        setTemplates((data as MessageTemplate[]) ?? []);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function resetSelection() {
    setSelected(null);
    setParams([]);
    setHeaderText("");
    setButtonParams({});
    setLocation(EMPTY_LOCATION);
    setOfferEnds("");
    setCouponCode("");
    setAuthCode("");
    setCards([]);
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetSelection();
    onOpenChange(next);
  }

  function pickTemplate(template: MessageTemplate) {
    const picked = templateSendNeeds(template);
    if (!needsInput(picked)) {
      onSelect(template, { body: [] });
      handleOpenChange(false);
      return;
    }
    resetSelection();
    setSelected(template);
    setParams(new Array(picked.bodyVars.length).fill(""));
    setCards(picked.cards.map((c) => ({ body: new Array(c.bodyVars.length).fill(""), buttonParams: {} })));
  }

  const needs = useMemo(
    () => (selected ? templateSendNeeds(selected) : null),
    [selected],
  );
  const lat = coordinate(location.latitude, 90);
  const lng = coordinate(location.longitude, 180);
  const locationValue =
    lat !== null && lng !== null
      ? {
          latitude: lat,
          longitude: lng,
          ...(location.name.trim() ? { name: location.name.trim() } : {}),
          ...(location.address.trim() ? { address: location.address.trim() } : {}),
        }
      : null;
  const offerMs = localDateTimeMs(offerEnds);
  // The server re-checks the end time, so a clock read during render is enough here.
  // eslint-disable-next-line react-hooks/purity
  const offerInPast = offerMs !== null && offerMs <= Date.now();
  const filled = (v: string | undefined) => (v ?? "").trim().length > 0;
  const canConfirm =
    !!selected &&
    !!needs &&
    needs.bodyVars.every((_, i) => filled(params[i])) &&
    (needs.headerVarCount === 0 || filled(headerText)) &&
    needs.urlButtons.every((s) => filled(buttonParams[s.index])) &&
    (!needs.location || !!locationValue) &&
    (!needs.offerExpiration || (offerMs !== null && !offerInPast)) &&
    (!needs.authCode || filled(authCode)) &&
    needs.cards.every(
      (c, ci) =>
        c.bodyVars.every((_, i) => filled(cards[ci]?.body[i])) &&
        c.urlButtons.every((s) => filled(cards[ci]?.buttonParams[s.index])),
    );

  const trimmedButtons = (values: Record<number, string>) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [Number(k), v.trim()]));

  function confirm() {
    if (!selected || !needs) return;
    const values: TemplateSendValues = { body: params };
    if (headerText.trim()) values.headerText = headerText.trim();
    if (Object.keys(buttonParams).length > 0) values.buttonParams = trimmedButtons(buttonParams);
    if (needs.location && locationValue) values.location = locationValue;
    if (needs.offerExpiration && offerMs) values.offerExpirationTimeMs = offerMs;
    if (couponCode.trim()) values.couponCode = couponCode.trim();
    if (needs.authCode) values.authCode = authCode.trim();
    if (needs.kind === "carousel") {
      values.cards = cards.map((c) => ({
        body: c.body,
        ...(Object.keys(c.buttonParams).length ? { buttonParams: trimmedButtons(c.buttonParams) } : {}),
      }));
    }
    onSelect(selected, values);
    handleOpenChange(false);
  }

  function updateCard(ci: number, patch: (card: CardDraft) => CardDraft) {
    setCards((prev) => prev.map((c, i) => (i === ci ? patch(c) : c)));
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <LayoutTemplate className="h-4 w-4 text-primary" />
            {selected ? selected.name : t("sendTemplate")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {selected
              ? t("fillPlaceholders")
              : t("pickTemplate")}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : templates.length === 0 ? (
              <div className="rounded-md border border-border bg-background/50 p-6 text-center">
                <p className="text-sm text-popover-foreground">{t("noApprovedTemplates")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("noApprovedTemplatesHint")}
                </p>
              </div>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTemplate(t)}
                  className="w-full rounded-md border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/40 hover:bg-popover"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-popover-foreground">
                          {t.name}
                        </p>
                        <Badge className="border border-primary/30 bg-primary/20 text-[10px] text-primary">
                          {t.category}
                        </Badge>
                        {t.language && (
                          <span className="text-[10px] uppercase text-muted-foreground">
                            {t.language}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {t.body_text}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-background/50 p-3">
              <p className="mb-1 text-xs text-muted-foreground">{t("preview")}</p>
              <p className="whitespace-pre-wrap text-sm text-popover-foreground">
                {needs?.authCode
                  ? t("authPreview")
                  : renderBodyPreview(selected.body_text, params)}
              </p>
              {selected.footer_text && (
                <p className="mt-2 text-xs italic text-muted-foreground">
                  {selected.footer_text}
                </p>
              )}
            </div>
            {needs?.authCode && (
              <div className="space-y-1">
                <Label htmlFor="tpl-auth-code" className="text-xs text-popover-foreground">
                  {t("authCodeLabel")}
                </Label>
                <Input
                  id="tpl-auth-code"
                  value={authCode}
                  maxLength={AUTH_CODE_MAX_LENGTH}
                  autoComplete="off"
                  onChange={(e) => setAuthCode(e.target.value)}
                  placeholder={t("authCodePlaceholder")}
                  className={inputClass}
                />
                <p className="text-[10px] text-muted-foreground">
                  {t("authCodeHint", { max: AUTH_CODE_MAX_LENGTH })}
                </p>
              </div>
            )}
            {needs?.location && (
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-xs font-medium text-popover-foreground">{t("locationTitle")}</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="tpl-loc-lat" className="text-xs text-popover-foreground">{t("latitude")}</Label>
                    <Input
                      id="tpl-loc-lat"
                      inputMode="decimal"
                      value={location.latitude}
                      onChange={(e) => setLocation((l) => ({ ...l, latitude: e.target.value }))}
                      placeholder="37.4847"
                      aria-invalid={!!location.latitude && lat === null}
                      className={inputClass}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="tpl-loc-lng" className="text-xs text-popover-foreground">{t("longitude")}</Label>
                    <Input
                      id="tpl-loc-lng"
                      inputMode="decimal"
                      value={location.longitude}
                      onChange={(e) => setLocation((l) => ({ ...l, longitude: e.target.value }))}
                      placeholder="-122.1484"
                      aria-invalid={!!location.longitude && lng === null}
                      className={inputClass}
                    />
                  </div>
                </div>
                {((location.latitude && lat === null) || (location.longitude && lng === null)) && (
                  <p className="text-[10px] text-destructive">{t("locationInvalid")}</p>
                )}
                <Input
                  aria-label={t("locationName")}
                  value={location.name}
                  onChange={(e) => setLocation((l) => ({ ...l, name: e.target.value }))}
                  placeholder={t("locationName")}
                  className={inputClass}
                />
                <Input
                  aria-label={t("locationAddress")}
                  value={location.address}
                  onChange={(e) => setLocation((l) => ({ ...l, address: e.target.value }))}
                  placeholder={t("locationAddress")}
                  className={inputClass}
                />
              </div>
            )}
            {needs?.offerExpiration && (
              <div className="space-y-1">
                <Label htmlFor="tpl-offer-ends" className="text-xs text-popover-foreground">
                  {t("offerEndsLabel")}
                </Label>
                <Input
                  id="tpl-offer-ends"
                  type="datetime-local"
                  value={offerEnds}
                  onChange={(e) => setOfferEnds(e.target.value)}
                  aria-invalid={offerInPast}
                  className={inputClass}
                />
                {offerInPast && (
                  <p className="text-[10px] text-destructive">{t("offerEndsPast")}</p>
                )}
              </div>
            )}
            {needs?.couponButtons.map((b) => (
              <div key={`coupon-${b.index}`} className="space-y-1">
                <Label htmlFor="tpl-coupon" className="text-xs text-popover-foreground">
                  {t("couponLabel", { text: b.text })}
                </Label>
                <Input
                  id="tpl-coupon"
                  value={couponCode}
                  maxLength={COUPON_CODE_MAX_LENGTH}
                  onChange={(e) => setCouponCode(e.target.value)}
                  placeholder={b.example}
                  className={inputClass}
                />
                <p className="text-[10px] text-muted-foreground">{t("couponHint")}</p>
              </div>
            ))}
            {needs && needs.headerVarCount > 0 && (
              <div className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {t("headerVarLabel", { var: "{{1}}" })}
                </Label>
                <Input
                  value={headerText}
                  onChange={(e) => setHeaderText(e.target.value)}
                  placeholder={t("headerValuePlaceholder")}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            )}
            {needs?.bodyVars.map((v, i) => (
              <div key={v} className="space-y-1">
                <Label className="text-xs text-popover-foreground">{t("bodyVarLabel", { var: `{{${v}}}` })}</Label>
                <Input
                  value={params[i] ?? ""}
                  onChange={(e) => {
                    const next = [...params];
                    next[i] = e.target.value;
                    setParams(next);
                  }}
                  placeholder={t("bodyValuePlaceholder", { val: `{{${v}}}` })}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            ))}
            {needs?.urlButtons.map((slot) => (
              <div key={slot.index} className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {t("urlButtonVarLabel", { text: slot.text, var: "{{1}}" })}
                </Label>
                <Input
                  value={buttonParams[slot.index] ?? ""}
                  onChange={(e) =>
                    setButtonParams((prev) => ({
                      ...prev,
                      [slot.index]: e.target.value,
                    }))
                  }
                  placeholder={t("urlSuffixValuePlaceholder")}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-[10px] text-muted-foreground break-all">
                  {t("finalUrl", { url: slot.url.replace(/\{\{1\}\}/g, buttonParams[slot.index] || "{{1}}") })}
                </p>
              </div>
            ))}
            {needs?.cards
              .filter((c) => c.bodyVars.length > 0 || c.urlButtons.length > 0)
              .map((c) => (
                <div key={`card-${c.index}`} className="space-y-2 rounded-md border border-border p-3">
                  <p className="text-xs font-medium text-popover-foreground">
                    {t("cardTitle", { n: c.index + 1 })}
                  </p>
                  {selected.cards?.[c.index]?.body_text && (
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {renderBodyPreview(selected.cards[c.index].body_text, cards[c.index]?.body ?? [])}
                    </p>
                  )}
                  {c.bodyVars.map((v, i) => (
                    <Input
                      key={v}
                      aria-label={t("cardBodyVarLabel", { n: c.index + 1, var: `{{${v}}}` })}
                      value={cards[c.index]?.body[i] ?? ""}
                      onChange={(e) =>
                        updateCard(c.index, (card) => ({
                          ...card,
                          body: card.body.map((x, j) => (j === i ? e.target.value : x)),
                        }))
                      }
                      placeholder={t("bodyValuePlaceholder", { val: `{{${v}}}` })}
                      className={inputClass}
                    />
                  ))}
                  {c.urlButtons.map((slot) => (
                    <Input
                      key={`url-${slot.index}`}
                      aria-label={t("urlButtonVarLabel", { text: slot.text, var: "{{1}}" })}
                      value={cards[c.index]?.buttonParams[slot.index] ?? ""}
                      onChange={(e) =>
                        updateCard(c.index, (card) => ({
                          ...card,
                          buttonParams: { ...card.buttonParams, [slot.index]: e.target.value },
                        }))
                      }
                      placeholder={t("urlSuffixValuePlaceholder")}
                      className={inputClass}
                    />
                  ))}
                </div>
              ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={resetSelection}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                {t("back")}
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={confirm}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {t("send")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
