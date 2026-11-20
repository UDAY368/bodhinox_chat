/**
 * The public shop's self-hosted fonts (SHOP_FONTS in lib/commerce/shop-templates.ts names
 * these families). Ten SIL OFL 1.1 families from Fontsource, vendored as woff2 under
 * src/app/fonts/shop (latin and latin-ext, weights 400 and 600; each folder keeps its LICENSE),
 * so the build needs no outside font service and the CSP's font-src 'self' holds. Only the
 * public shop frame and the theme editor import this module, so other pages never ship these
 * @font-face rules; a browser downloads a file only when a page draws that family and range.
 *
 * Each family is declared twice under one fixed name, once per subset with its unicode-range
 * (latin-ext carries the rupee sign), so the browser fetches only the subsets a page uses.
 * display swap, no preload (a shop uses two of the ten), no generated fallback face (the
 * stacks in SHOP_FONTS fall back to system fonts).
 */
import localFont from 'next/font/local';

// next/font options must be literals, so each unicode-range is written out (Fontsource's latin and latin-ext ranges).
const interLatin = localFont({
  src: [
    { path: '../../app/fonts/shop/inter/inter-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/inter/inter-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-inter',
  declarations: [{ prop: 'font-family', value: 'ShopInter' }, { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const interExt = localFont({
  src: [
    { path: '../../app/fonts/shop/inter/inter-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/inter/inter-latin-ext-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-inter-ext',
  declarations: [{ prop: 'font-family', value: 'ShopInter' }, { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }],
});
const manropeLatin = localFont({
  src: [
    { path: '../../app/fonts/shop/manrope/manrope-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/manrope/manrope-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-manrope',
  declarations: [{ prop: 'font-family', value: 'ShopManrope' }, { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const manropeExt = localFont({
  src: [
    { path: '../../app/fonts/shop/manrope/manrope-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/manrope/manrope-latin-ext-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-manrope-ext',
  declarations: [{ prop: 'font-family', value: 'ShopManrope' }, { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }],
});
const dmSansLatin = localFont({
  src: [
    { path: '../../app/fonts/shop/dm-sans/dm-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/dm-sans/dm-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-dm-sans',
  declarations: [{ prop: 'font-family', value: 'ShopDmSans' }, { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const dmSansExt = localFont({
  src: [
    { path: '../../app/fonts/shop/dm-sans/dm-sans-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/dm-sans/dm-sans-latin-ext-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-dm-sans-ext',
  declarations: [{ prop: 'font-family', value: 'ShopDmSans' }, { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }],
});
const poppinsLatin = localFont({
  src: [
    { path: '../../app/fonts/shop/poppins/poppins-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/poppins/poppins-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-poppins',
  declarations: [{ prop: 'font-family', value: 'ShopPoppins' }, { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const poppinsExt = localFont({
  src: [
    { path: '../../app/fonts/shop/poppins/poppins-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/poppins/poppins-latin-ext-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-poppins-ext',
  declarations: [{ prop: 'font-family', value: 'ShopPoppins' }, { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }],
});
const nunitoLatin = localFont({
  src: [
    { path: '../../app/fonts/shop/nunito/nunito-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/nunito/nunito-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-nunito',
  declarations: [{ prop: 'font-family', value: 'ShopNunito' }, { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const nunitoExt = localFont({
  src: [
    { path: '../../app/fonts/shop/nunito/nunito-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/nunito/nunito-latin-ext-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-nunito-ext',
  declarations: [{ prop: 'font-family', value: 'ShopNunito' }, { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }],
});
const spaceGroteskLatin = localFont({
  src: [
    { path: '../../app/fonts/shop/space-grotesk/space-grotesk-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/space-grotesk/space-grotesk-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-space-grotesk',
  declarations: [{ prop: 'font-family', value: 'ShopSpaceGrotesk' }, { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const spaceGroteskExt = localFont({
  src: [
    { path: '../../app/fonts/shop/space-grotesk/space-grotesk-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/space-grotesk/space-grotesk-latin-ext-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-space-grotesk-ext',
  declarations: [{ prop: 'font-family', value: 'ShopSpaceGrotesk' }, { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }],
});
const playfairLatin = localFont({
  src: [
    { path: '../../app/fonts/shop/playfair-display/playfair-display-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/playfair-display/playfair-display-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-playfair-display',
  declarations: [{ prop: 'font-family', value: 'ShopPlayfair' }, { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const playfairExt = localFont({
  src: [
    { path: '../../app/fonts/shop/playfair-display/playfair-display-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/playfair-display/playfair-display-latin-ext-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-playfair-display-ext',
  declarations: [{ prop: 'font-family', value: 'ShopPlayfair' }, { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }],
});
const loraLatin = localFont({
  src: [
    { path: '../../app/fonts/shop/lora/lora-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/lora/lora-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-lora',
  declarations: [{ prop: 'font-family', value: 'ShopLora' }, { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const loraExt = localFont({
  src: [
    { path: '../../app/fonts/shop/lora/lora-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/lora/lora-latin-ext-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-lora-ext',
  declarations: [{ prop: 'font-family', value: 'ShopLora' }, { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }],
});
const cormorantLatin = localFont({
  src: [
    { path: '../../app/fonts/shop/cormorant-garamond/cormorant-garamond-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/cormorant-garamond/cormorant-garamond-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-cormorant-garamond',
  declarations: [{ prop: 'font-family', value: 'ShopCormorant' }, { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const cormorantExt = localFont({
  src: [
    { path: '../../app/fonts/shop/cormorant-garamond/cormorant-garamond-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/cormorant-garamond/cormorant-garamond-latin-ext-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-cormorant-garamond-ext',
  declarations: [{ prop: 'font-family', value: 'ShopCormorant' }, { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }],
});
const jetBrainsMonoLatin = localFont({
  src: [
    { path: '../../app/fonts/shop/jetbrains-mono/jetbrains-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/jetbrains-mono/jetbrains-mono-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-jetbrains-mono',
  declarations: [{ prop: 'font-family', value: 'ShopJetBrainsMono' }, { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const jetBrainsMonoExt = localFont({
  src: [
    { path: '../../app/fonts/shop/jetbrains-mono/jetbrains-mono-latin-ext-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../app/fonts/shop/jetbrains-mono/jetbrains-mono-latin-ext-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap', preload: false, adjustFontFallback: false, variable: '--shop-ff-jetbrains-mono-ext',
  declarations: [{ prop: 'font-family', value: 'ShopJetBrainsMono' }, { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }],
});

/** Class names that put every shop font's @font-face rules on the page (set on the shop frame's root). */
export const SHOP_FONT_CLASSES = [interLatin, interExt, manropeLatin, manropeExt, dmSansLatin, dmSansExt, poppinsLatin, poppinsExt, nunitoLatin, nunitoExt, spaceGroteskLatin, spaceGroteskExt, playfairLatin, playfairExt, loraLatin, loraExt, cormorantLatin, cormorantExt, jetBrainsMonoLatin, jetBrainsMonoExt].map((f) => f.variable).join(' ');
