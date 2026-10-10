/**
 * Design tokens (§6.5), applied on the card host and inherited by every element and dialog inside it. Text colors
 * come only from --agr-ink, --agr-muted, --agr-olive-ink, --agr-brass-ink, --agr-danger and --agr-plum; plain olive
 * and brass are for fills, hairlines and icons (a fitness test rejects them as text colors).
 */
import { css } from 'lit';

/**
 * The Model 3 drawing's paint (vehicle-art-model-3.ts, §18). The car is black in both themes; decorative, so these are
 * not text colours. The dark theme's edge is a rim light that keeps the silhouette against the dark surface.
 */
const lightVehicleTokens = css`
  --agr-vehicle-paint: #1b1d19;
  --agr-vehicle-edge: #1b1d19;
  --agr-vehicle-glass: #3d4442;
  --agr-vehicle-sheen: rgb(255 255 255 / 0.22);
  --agr-vehicle-seam: rgb(255 255 255 / 0.1);
  --agr-vehicle-tyre: #121310;
  --agr-vehicle-rim: #8e9389;
  --agr-vehicle-lamp: #e9e6da;
  --agr-vehicle-tail: #4a3f3d;
  --agr-vehicle-shadow: rgb(44 48 41 / 0.2);
`;
const darkVehicleTokens = css`
  --agr-vehicle-paint: #0c0d0b;
  --agr-vehicle-edge: #7f8375;
  --agr-vehicle-glass: #2a302f;
  --agr-vehicle-sheen: rgb(255 255 255 / 0.16);
  --agr-vehicle-seam: rgb(255 255 255 / 0.08);
  --agr-vehicle-tyre: #070806;
  --agr-vehicle-rim: #6f7469;
  --agr-vehicle-lamp: #d9d6c8;
  --agr-vehicle-tail: #5a4c49;
  --agr-vehicle-shadow: rgb(0 0 0 / 0.45);
`;

/** The dark theme's values, shared by the explicit dark theme and the pre-hass system fallback. */
const darkTokens = css`
  color-scheme: dark;
  --agr-canvas: #171915;
  --agr-surface: #21241e;
  --agr-surface-inset: #2a2e26;
  --agr-surface-hero: #242820;
  --agr-ink: #eceadf;
  --agr-muted: #aeb2a3;
  --agr-olive: #8ea47e;
  --agr-olive-ink: #a9bf98;
  --agr-olive-tint: #2f3a2a;
  --agr-brass: #c9b072;
  --agr-brass-ink: #d8c48e;
  --agr-brass-tint: #463b1f; /* brass-ink on it 6.40:1; #3a3323 read as a brown stain, not warm light */
  --agr-lit-ring: rgb(201 176 114 / 0.25);
  --agr-plum: #c3abc9;
  --agr-plum-tint: #352b38;
  --agr-danger: #e8897c;
  --agr-danger-tint: #43231f;
  --agr-line: #363a31;
  --agr-radar-ring: #4b5143;
  --agr-surface-quiet: rgb(33 36 30 / 0.45);
  --agr-focus: #cfe0bd;
  --agr-shadow-panel: 0 1px 0 rgb(255 255 255 / 0.04) inset, 0 12px 32px -20px rgb(0 0 0 / 0.6);
  --agr-shadow-raised: 0 1px 0 rgb(255 255 255 / 0.05) inset, 0 1px 1px rgb(0 0 0 / 0.35);
  --agr-shadow-pressed: inset 0 1px 2px rgb(0 0 0 / 0.45);
  --agr-shadow-overlay: 0 24px 64px -24px rgb(0 0 0 / 0.7);
  --agr-backdrop: rgb(0 0 0 / 0.55);
  --agr-ghost-quiet: var(--agr-surface-inset); /* already 1.4:1 against the dark quiet surface */
  /* A modest dimming for real camera feeds; the demo stills bring their own night palette (simulate.ts). */
  --agr-media-filter: brightness(0.82) saturate(0.85);
  --agr-letterbox: var(--agr-canvas);
  ${darkVehicleTokens}
`;

export const tokenStyles = css`
  :host {
    /* light: primary acceptance reference */
    --agr-canvas: #e7e5d9;
    --agr-surface: #f5f3e9;
    --agr-surface-inset: #ebeade;
    --agr-surface-hero: #f7f5ec;
    --agr-ink: #2c3029;
    --agr-muted: #5c6155;
    --agr-olive: #62745c;
    --agr-olive-ink: #4f6249;
    --agr-olive-tint: #dfe5d3;
    --agr-brass: #a18b50;
    --agr-brass-ink: #6f5c2b;
    --agr-brass-tint: #efe6cc;
    --agr-lit-ring: rgb(161 139 80 / 0.25); /* brass at 25 %: the edge of a lit room chip */
    --agr-plum: #69536f;
    --agr-plum-tint: #e9e1ea;
    --agr-danger: #a4453d;
    --agr-danger-tint: #f3dcd7;
    --agr-line: #d6d3c3;
    /* The sky radar's range rings (ARCHITECTURE.md §19): a decorative hairline on the inset disc, a step firmer than
       the line token so the rings read at 1 px. Meaning is carried by the marks and the brass-ink overhead ring. */
    --agr-radar-ring: #c8c4ae;
    /* Quiet panels: the surface at 45 % over the canvas, a footnote tone instead of a 1.19:1 wireframe border.
       A literal, because color-mix() is below the browser floor (§1.2 item 11). */
    --agr-surface-quiet: rgb(245 243 233 / 0.45);
    /* Loading placeholders on the quiet surface: the inset tone is 1.01:1 against it, this one about 1.2:1. */
    --agr-ghost-quiet: #dbd9ca;
    --agr-focus: #3d4f37;
    --agr-shadow-panel:
      0 1px 0 rgb(255 255 255 / 0.55) inset, 0 1px 2px rgb(44 48 41 / 0.05), 0 10px 28px -18px rgb(44 48 41 / 0.22);
    --agr-shadow-raised: 0 1px 0 rgb(255 255 255 / 0.7) inset, 0 1px 1px rgb(44 48 41 / 0.1);
    --agr-shadow-pressed: inset 0 1px 2px rgb(44 48 41 / 0.14);
    --agr-shadow-overlay: 0 24px 64px -24px rgb(28 30 26 / 0.45);
    --agr-backdrop: rgb(32 34 29 / 0.38);
    /* Camera pictures as they arrive; the dark theme dims them so they never outweigh the weather anchor. */
    --agr-media-filter: none;
    /* Bars around a picture whose aspect differs from its frame (snapshot fallback, demo still). */
    --agr-letterbox: var(--agr-surface-inset);
    color-scheme: light; /* native range inputs, scrollbars, dialog defaults */
    /* Olive is the household accent; plum is reserved for media (agr-slider tone="media"). */
    accent-color: var(--agr-olive);
    ${lightVehicleTokens}
  }
  :host([data-theme='dark']) {
    /* follows hass.themes.darkMode */
    ${darkTokens}
  }
  /* Before the first hass (the loading frame), follow the system scheme, as HA's default theme does, so a dark wall
     tablet never flashes the light canvas; once hass arrives the data-theme attribute decides. */
  @media (prefers-color-scheme: dark) {
    :host(:not([data-theme])) {
      ${darkTokens}
    }
  }
  :host {
    --agr-font-display: 'Agraharam Serif', 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
    --agr-font-ui: 'Agraharam Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
    /* The type scale (§6.5) as font shorthand values. The shorthand resets font-variant-numeric, so a rule that
       needs tabular digits declares them after it. */
    --agr-type-label: 650 12px/16px var(--agr-font-ui);
    --agr-type-meta: 500 13px/18px var(--agr-font-ui);
    --agr-type-meta-strong: 600 13px/18px var(--agr-font-ui);
    --agr-type-control: 600 14px/20px var(--agr-font-ui);
    --agr-type-body: 450 15px/22px var(--agr-font-ui);
    --agr-type-strong: 620 15px/22px var(--agr-font-ui);
    --agr-type-value: 450 22px/26px var(--agr-font-display);
    --agr-type-title: 450 24px/30px var(--agr-font-display);
    --agr-radius-panel: 24px;
    --agr-radius-inner: 15px;
    --agr-radius-control: 999px;
    --agr-space-1: 4px;
    --agr-space-2: 8px;
    --agr-space-3: 12px;
    --agr-space-4: 16px;
    --agr-space-5: 20px;
    --agr-space-6: 24px;
    --agr-space-8: 32px;
    --agr-gap: 16px;
    --agr-frame-pad: 24px;
    --agr-panel-pad: 20px; /* medium 16/20/18, narrow 12/12/16 (gap/frame/panel), set per layout in layout.ts */
    --agr-ease: cubic-bezier(0.2, 0.7, 0.2, 1);
    --agr-dur-1: 120ms;
    --agr-dur-2: 200ms;
    --agr-dur-3: 320ms;
    --agr-target: 44px;
  }
  @media (prefers-reduced-motion: reduce) {
    :host {
      --agr-dur-1: 0ms;
      --agr-dur-2: 0ms;
      --agr-dur-3: 0ms;
    }
  }
  :host {
    /* reset what HA's body and hui-card would otherwise leak in */
    font: var(--agr-type-body);
    color: var(--agr-ink);
    letter-spacing: normal;
    text-transform: none;
    text-align: start;
    font-style: normal;
    -webkit-font-smoothing: antialiased;
  }
`;
