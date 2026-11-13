"use client";

// Share a place in a WhatsApp chat (Meta's location message): a name, an
// address and the map point. "Use my current location" fills the point from
// the browser (the member allows it); the server checks every value again.
import { useState } from "react";
import { Loader2, LocateFixed, MapPin } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface SendLocationPayload {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

/** The form's values as a location, or which field is wrong. */
export function parseLocationForm(values: { name: string; address: string; latitude: string; longitude: string }):
  | { ok: true; location: SendLocationPayload }
  | { ok: false; field: "latitude" | "longitude" } {
  const latitude = Number(values.latitude.trim().replace(",", "."));
  const longitude = Number(values.longitude.trim().replace(",", "."));
  if (!values.latitude.trim() || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return { ok: false, field: "latitude" };
  if (!values.longitude.trim() || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return { ok: false, field: "longitude" };
  const name = values.name.trim();
  const address = values.address.trim();
  return { ok: true, location: { latitude, longitude, ...(name ? { name } : {}), ...(address ? { address } : {}) } };
}

export function LocationDialog({
  open,
  onOpenChange,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (location: SendLocationPayload) => void;
}) {
  const t = useTranslations("Inbox.location");
  const [values, setValues] = useState({ name: "", address: "", latitude: "", longitude: "" });
  const [error, setError] = useState<"latitude" | "longitude" | null>(null);
  const [locating, setLocating] = useState(false);

  const set = (key: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setValues((prev) => ({ ...prev, [key]: event.target.value }));
    setError(null);
  };

  const locate = () => {
    if (!navigator.geolocation) {
      toast.error(t("locateUnsupported"));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setValues((prev) => ({
          ...prev,
          latitude: position.coords.latitude.toFixed(6),
          longitude: position.coords.longitude.toFixed(6),
        }));
        setError(null);
        setLocating(false);
      },
      () => {
        toast.error(t("locateFailed"));
        setLocating(false);
      },
      { timeout: 10_000 },
    );
  };

  const submit = () => {
    const parsed = parseLocationForm(values);
    if (!parsed.ok) {
      setError(parsed.field);
      return;
    }
    onSend(parsed.location);
    setValues({ name: "", address: "", latitude: "", longitude: "" });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="location-name">{t("name")}</Label>
            <Input id="location-name" value={values.name} maxLength={100} placeholder={t("namePlaceholder")} onChange={set("name")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="location-address">{t("address")}</Label>
            <Input id="location-address" value={values.address} maxLength={300} placeholder={t("addressPlaceholder")} onChange={set("address")} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="location-lat">{t("latitude")}</Label>
              <Input id="location-lat" inputMode="decimal" value={values.latitude} placeholder="17.4126" onChange={set("latitude")}
                aria-invalid={error === "latitude"} aria-describedby={error === "latitude" ? "location-lat-error" : undefined} />
              {error === "latitude" && <p id="location-lat-error" className="text-destructive text-xs">{t("latitudeError")}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="location-lng">{t("longitude")}</Label>
              <Input id="location-lng" inputMode="decimal" value={values.longitude} placeholder="78.4482" onChange={set("longitude")}
                aria-invalid={error === "longitude"} aria-describedby={error === "longitude" ? "location-lng-error" : undefined} />
              {error === "longitude" && <p id="location-lng-error" className="text-destructive text-xs">{t("longitudeError")}</p>}
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={locate} disabled={locating}>
            {locating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LocateFixed className="h-4 w-4" aria-hidden />}
            {t("useCurrent")}
          </Button>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
            <Button type="submit">
              <MapPin className="h-4 w-4" aria-hidden />
              {t("send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
