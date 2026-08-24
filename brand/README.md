# drapr brand assets

Drop this folder into the DrapesQuotePro repo (suggested: `public/brand/`).

## Files

| File | Use |
|---|---|
| `assets/drapr-lockup-horizontal-teal.svg` | Default. App header, documents, email signatures. |
| `assets/drapr-lockup-horizontal-white.svg` | On teal or any dark background. |
| `assets/drapr-lockup-horizontal-ink.svg` | Single-colour print, faxed or photocopied forms. |
| `assets/drapr-lockup-stacked-teal.svg` | Narrow spaces — mobile splash, square placements. |
| `assets/drapr-lockup-reversed-teal.svg` | Pre-built teal panel with correct clear space. |
| `assets/drapr-mark-*.svg` | Mark alone. Only where "drapr" already appears nearby. |
| `assets/drapr-wordmark-*.svg` | Wordmark alone. Body copy, footers, fine print. |
| `assets/drapr-app-icon.svg` | 512px app icon, iOS corner radius. |
| `assets/drapr-favicon.svg` | 64px favicon. |
| `tokens.css` | Colour, type and spacing custom properties. |

## Rules that matter

- **Never rebuild the lockup by hand.** Mark and wordmark are aligned on
  real font metrics. Use the lockup files.
- **Clear space** on all sides equals half the mark height.
- **Minimum sizes:** lockup 96px wide on screen, 24mm in print. Mark alone
  20px. Below that use the favicon.
- **Don't** recolour outside the palette, add effects, outline, rotate,
  stretch, or set the wordmark in another typeface.

## Typeface

The wordmark is Poppins Medium, tracked -2.2%, converted to outlines —
no font file needed to render it. For UI text use the system stack in
`tokens.css`; only load Poppins if you want it for headings.

## Colour

Primary is teal `#0F6E63`. It passes WCAG AA against white for text at
all sizes. `--drapr-teal-tint` is background-only — never text.
