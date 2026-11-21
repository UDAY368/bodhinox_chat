// The browser's stand-in for @app-messages (next.config aliases it under the `browser` condition).
// Server code and server rendering keep the real catalogue file. In the browser, code outside React
// (src/lib/i18n/translate.ts and anything shared with the server) reads the catalogue the root
// layout already sent to NextIntlClientProvider, filled in by <BrowserMessages>, instead of every
// page bundling its own ~780 KB copy of messages/<locale>.json.
const messages: Record<string, unknown> = {};

/** Fills the shared object in place, so modules that imported it earlier see the catalogue too. */
export function registerBrowserMessages(next: Record<string, unknown>): void {
  if (messages === next) return;
  Object.assign(messages, next);
}

export default messages;
