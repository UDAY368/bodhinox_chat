/** A coarse, display-only reading of a User-Agent header for the session/device list. */
export type DeviceKind = 'desktop' | 'mobile' | 'tablet' | 'unknown';
export interface DeviceInfo {
  browser: string | null;
  os: string | null;
  device: DeviceKind;
}
export const USER_AGENT_MAX = 512;

/** Trim and bound a header before storing it; control characters are dropped. */
export function storableUserAgent(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return clean ? clean.slice(0, USER_AGENT_MAX) : null;
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

export function parseUserAgent(value: string | null | undefined): DeviceInfo {
  const ua = storableUserAgent(value);
  if (!ua) return { browser: null, os: null, device: 'unknown' };
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const device: DeviceKind = /\biPad\b|\bTablet\b|Android(?!.*\bMobile\b)/.test(ua)
    ? 'tablet'
    : /\bMobile\b|\biPhone\b|\biPod\b/.test(ua)
      ? 'mobile'
      : os
        ? 'desktop'
        : 'unknown';
  return { browser, os, device };
}
