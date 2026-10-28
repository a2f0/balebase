# @balebase/ui

The design system shared by the marketing site (`packages/website`) and the
app (`packages/app`). It owns the visual language (tokens, type, and
component styles) so both apps look like one product.

## Entry points

| Import                     | Contents                                              |
| -------------------------- | ----------------------------------------------------- |
| `@balebase/ui/styles.css`  | Self-hosted fonts, tokens, base styles, component CSS |
| `@balebase/ui/react`       | Typed React primitives for the app                    |
| `@balebase/ui/icons`       | The shared icon vocabulary (Lucide geometry)          |
| `@balebase/ui/brand`       | Product name, pricing plans, and legal links          |

Import `styles.css` once, before any app stylesheet. The website uses the
same class names directly in Astro markup; the app prefers the React
primitives, which render those classes.

## Rules

- Use tokens (`var(--color-*)`, `var(--space-*)`, `var(--text-*)`,
  `var(--radius-*)`) instead of raw values. App stylesheets should not
  introduce hex colors or pixel font sizes.
- The smallest text is `--text-xs` (12px). Body copy in the app is
  `--text-base` (14px); inputs are `--text-md` (15px, 16px on phones).
- Spacing follows the 4px scale (`--space-1` = 4px … `--space-32` = 128px).
- One button vocabulary everywhere: `.button` plus a variant and size.
- Status is communicated with `Badge`/`.badge` tones. Use `Toast` for action
  feedback so it stays at the bottom without shifting content, and `Banner`
  for persistent page guidance. Keep field validation beside its input.
- Class names are camelCase to match the rest of the repository.

## Tokens

Neutrals are warm paper and ink: `--color-paper` (canvas),
`--color-surface` (cards and inputs), `--color-surface-sunken` (wells,
table headers, card footers), `--color-ink` (dark surfaces and primary
buttons). Text uses `--color-text`, `--color-text-muted` (secondary), and
`--color-text-subtle` (metadata). Borders use `--color-border`,
`--color-border-subtle` (row dividers), and `--color-border-strong`
(controls).

The brand accents are `--color-lime` (on dark surfaces and for focus
rings), `--color-lime-soft`/`--color-lime-wash` (highlight surfaces), and
`--color-green`/`--color-green-strong` (links and accents on light
surfaces). Status tones each have `-bg`, `-border`, and `-fg` tokens:
`success`, `warning`, `danger`, `info`, and `neutral`.

`--color-emphasis`, `--color-emphasis-hover`, and `--color-on-emphasis`
fill primary buttons and mark selected states; use them rather than
`--color-ink` for anything that should invert in dark regions or the dark
theme.

Wrap dark regions in `.onDark` so buttons, inputs, eyebrows, and focus
rings switch to their inverse treatment.

## Themes

Colors and shadows have a light and a dark theme. Light is the default; the
app sets `data-theme="light"` or `"dark"` on `<html>` from the viewer's
choice (System, Light, or Dark), and the website never sets it. Any element
can set `data-theme="light"` to stay light inside the dark theme, as PDF
pages, the signature pad, and QR codes do. Ink stays the darkest surface in
both themes, so `.onDark` regions need no theme-specific styles.

## CSS vocabulary

- **Buttons:** `button` + `buttonPrimary`, `buttonAccent`, `buttonGhost`,
  `buttonDanger`, `buttonLink`; `buttonSm`, `buttonLg`, `buttonBlock`,
  `buttonIconOnly`
- **Forms:** `field`, `fieldLabel`, `fieldHint`, `fieldError`,
  `fieldOptional`, `input`, `select`, `textarea`, `inputSm`, `check`,
  `fieldset`, `formGrid`, `formRow`, `formActions`
- **Surfaces:** `card`, `cardHeader`, `cardHeading`, `cardTitle`,
  `cardDescription`, `cardActions`, `cardBody`, `cardFlush`, `cardFooter`,
  `cardInteractive`, `cardSelected`, `cardAccent`, `cardDanger`
- **Rows:** `rowList`, `row`, `rowMain`, `rowTitle`, `rowMeta`, `rowActions`
  (a `button.row` or `a.row` is clickable)
- **Tables:** `tableWrap`, `table`
- **Status:** `badge` + `badgeSuccess`, `badgeWarning`, `badgeDanger`,
  `badgeInfo`, `badgeAccent`, `badgeDot`; `banner` + `bannerSuccess`,
  `bannerWarning`, `bannerDanger`, `bannerNeutral`
- **States:** `emptyState`, `emptyStateCompact`, `emptyStatePlain`, `spinner`
- **Navigation:** `tabs` + `tab` (`aria-current="page"`), `segmented`
  (children use `aria-pressed`/`aria-checked`/`aria-current`;
  `data-tone="success"` or `"danger"` tints a pressed answer; `segmentedFill`
  makes equal-width options), `popover`, `menuItem`, `menuLabel`,
  `menuSeparator`
- **Page:** `page`, `pageNarrow`, `pageHeader`, `pageBody`, `pageSection`,
  `sectionHeader`, `sectionTitle`, `sectionDescription`, `sectionCount`
- **Layout:** `stack` (+ `stackSm`…`stackLg`), `cluster` (+ `clusterBetween`),
  `gridAuto` (`--grid-min`)
- **Type:** `display`, `headline`, `title`, `lead`, `eyebrow`, `eyebrowDot`,
  `serifAccent`, `prose`, `textMuted`, `textSubtle`, `textXs`, `textSm`,
  `textStrong`, `mono`, `tabular`, `truncate`
- **Identity:** `brand`, `brandMark`, `avatar` (+ `avatarSm`,
  `avatarLg`), `keyValue`, `codeChip`, `icon`, `iconTile` (an icon on a
  lime-wash square, beside a row or card's title)

## React primitives

- `Page` (`narrow` for forms and settings), `PageHeader` (`eyebrow`,
  `title`, `description`, `actions`, `back`, `tabs`), `PageBody`, and
  `PageSection` (`title`, `description`, `actions`).
- `Card` (`title`, `description`, `actions`, `footer`, `flush` for row
  lists and tables, `onSubmit` to render the card as a form). Its title is
  an `h2`, or an `h3` inside a `PageSection`; a lone footer action sits at
  the end.
- `Button` and `ButtonLink` (`variant`, `size`, `icon`, `iconEnd`,
  `iconOnly`, `block`; `Button` also takes `busy`), plus `buttonClass()`
  for other elements.
- `Badge` (`tone`, `dot`), `Banner` (`tone`, `title`, `actions`,
  `announce`), and `Toast` (the same props as `Banner`). Wrap the app in
  `ToastProvider` so notifications share a fixed bottom viewport, stack without
  overlapping, and stay visible while scrolling. `Toast` also works alone.
- `EmptyState` (`icon`, `title`, `actions`, `compact`, `plain`) and `LoadingState`.
- `Field` wraps a control with its label, hint, and an `optional` marker.
- `Icon` renders a name from `@balebase/ui/icons`; `Avatar` and `Logo`
  render identity.

## Images

`assets/brand/logo.svg` is the pixel B logo, drawn only with whole-unit
`<rect>` elements; the app shells and the website import this one copy. The
`images` section of `agent-tool.json` declares every image generated from it,
and the pinned `agent-tool images build` renders them, with `pixelSnap`
scaling the logo by whole numbers.

- The web app and website write the `favicons` target to their `public/` in
  dev and build. The website also writes the `social` target, the 1200×630
  Open Graph image that both its pages and the app shell name.
- `bun run images` writes the `native` target to `dist/images`: the iOS and
  Android icons and splash screens in Capacitor's project layout, and the
  1024×1024 Plaid icon at `plaid/icon-1024.png`. It writes the favicons to
  `dist/images/web`.

The lime and ink fills match `--color-lime` and `--color-ink` in
`src/styles/tokens.css`. The touch and App Store icons are opaque, because iOS
blackens transparent home-screen pixels and the App Store rejects
transparency. The 60% Android adaptive foreground stays inside the 66dp that
launchers may leave unmasked, and the Plaid icon's margin keeps the B whole
under a circular crop. Generated images are ignored; keep binary files out of
commits.
