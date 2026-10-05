/**
 * Shared component styles: focus ring, visually-hidden text, tabular numbers, tone colors, status pills, the loading
 * skeleton, section hosts and the native dialog surfaces used by agr-drawer and the agr-dialog base.
 */
import { css } from 'lit';

/** §5.4 rule 10: a 2 px focus ring on :focus-visible only. */
export const focusRingStyles = css`
  :focus {
    outline: none;
  }
  :focus-visible {
    outline: 2px solid var(--agr-focus);
    outline-offset: 2px;
  }
`;

/**
 * Hyphenation for names and labels in narrow boxes: only words of 10 or more letters, with at least 4 on each side.
 * WebKit ignores `hyphenate-limit-chars` and would hyphenate any word ("li-brary" in a room chip at 640 px), so its
 * own before and after limits (5 each, so a word needs 10 letters) keep short words whole there too. Interpolate it
 * inside a rule that also sets an `overflow-wrap`.
 */
export const hyphenationDeclarations = css`
  hyphens: auto;
  hyphenate-limit-chars: 10 4 4;
  -webkit-hyphenate-limit-before: 5;
  -webkit-hyphenate-limit-after: 5;
`;

/**
 * The declarations that hide content visually but keep it for assistive technology. Interpolate them inside a rule
 * for an element that is hidden only in some layouts: `@container (…) { .label { ${visuallyHiddenDeclarations} } }`.
 */
export const visuallyHiddenDeclarations = css`
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
`;

/** Text read by assistive technology but not shown (field names, reasons when space is short, "last known"). */
export const visuallyHiddenStyles = css`
  .visually-hidden {
    ${visuallyHiddenDeclarations}
  }
`;

/**
 * The declarations of the one disabled look every control shares (§7.2, §6.5): an outline with muted text and no
 * shadow, so a control that cannot act never reads as pressable on a panel, an inset tile or a drawer. Interpolate it
 * inside a rule: `button[aria-disabled='true'] { ${disabledControlDeclarations} }`.
 */
export const disabledControlDeclarations = css`
  color: var(--agr-muted);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--agr-line);
  cursor: not-allowed;
`;

/**
 * Pending feedback (§6.5): a 2 px brass underline sweeps across a `.sweep` control while its ticket is pending
 * (`data-phase='pending'`), beside the text "Sending". `--agr-sweep-inset` and `--agr-sweep-offset` fit it to the
 * control's shape. With reduced motion there is no sweep and the text alone remains.
 */
export const pendingSweepStyles = css`
  .sweep[data-phase='pending'] {
    position: relative;
  }
  .sweep[data-phase='pending']::after {
    content: '';
    position: absolute;
    inset-inline: var(--agr-sweep-inset, var(--agr-space-4));
    inset-block-end: var(--agr-sweep-offset, 6px);
    block-size: 2px;
    border-radius: 1px;
    background: var(--agr-brass);
    transform-origin: left;
    animation: agr-sweep 1.2s var(--agr-ease) infinite;
  }
  @keyframes agr-sweep {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sweep[data-phase='pending']::after {
      display: none;
    }
  }
`;

/** Every changing number is tabular and lining, so values never jitter as they update. */
export const numStyles = css`
  .num {
    font-variant-numeric: tabular-nums lining-nums;
  }
`;

/** Text colors per Tone. ok and attention use the -ink variants: plain olive and brass fail 4.5:1 as text. */
export const toneStyles = css`
  [data-tone='neutral'] {
    color: var(--agr-ink);
  }
  [data-tone='ok'] {
    color: var(--agr-olive-ink);
  }
  [data-tone='attention'] {
    color: var(--agr-brass-ink);
  }
  [data-tone='danger'] {
    color: var(--agr-danger);
  }
  [data-tone='muted'] {
    color: var(--agr-muted);
  }
`;

/**
 * A last-known value (§4.6) is dimmed with the muted text token, never with opacity: opacity blends the text into its
 * background and drops it below the 4.5:1 floor every text token meets (§6.5). The visually hidden "last known" text
 * stays beside it. A stale container (a media title block, a calendar group) dims every line inside it. Put this last
 * in a styles array so it wins over tone and class colors of equal specificity.
 */
export const staleStyles = css`
  .stale,
  .stale * {
    color: var(--agr-muted);
  }
`;

/** Compact status pill ("Cooling", "Demo"); its tone sets the text color and a matching tint. */
export const pillStyles = css`
  .pill {
    display: inline-flex;
    align-items: center;
    gap: var(--agr-space-1);
    padding: 3px 10px;
    border-radius: var(--agr-radius-control);
    background: var(--agr-surface-inset);
    font: var(--agr-type-label);
    white-space: nowrap;
  }
  .pill[data-tone='ok'] {
    background: var(--agr-olive-tint);
  }
  .pill[data-tone='attention'] {
    background: var(--agr-brass-tint);
  }
  .pill[data-tone='danger'] {
    background: var(--agr-danger-tint);
  }
  ${toneStyles}
`;

/**
 * Loading placeholders: loading values render as a skeleton bar with no text (§4.6), and a panel that has nothing yet
 * renders `.ghost` blocks shaped like the content it will show (tiles, chips, rows), so the first real render only
 * fills in a layout that is already standing. The fill is `--agr-ghost-fill` when a surface sets one (quiet panels,
 * where the inset tone all but disappears), else the inset tone.
 */
export const skeletonStyles = css`
  .skeleton {
    display: block;
    block-size: 12px;
    margin-block: var(--agr-space-2);
    border-radius: var(--agr-radius-control);
    background: var(--agr-ghost-fill, var(--agr-surface-inset));
  }
  .ghost {
    box-sizing: border-box;
    display: block;
    border-radius: var(--agr-radius-inner);
    background: var(--agr-ghost-fill, var(--agr-surface-inset));
  }
  .ghost-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--agr-space-2);
  }
`;

/**
 * Section element hosts: a flex column whose agr-panel fills it, so when the root stretches the last raised panel
 * of a column (§6.2, `data-stretch` on the section host) the panel's surface reaches the column bottom, unless the
 * section marks its panel `fit` because it has nothing to show.
 *
 * The panel already declares itself the `panel` container. The name is declared again here because container names
 * are tree-scoped: WebKit matches `@container panel` in this tree (and in leaf components nested inside the panel)
 * only against a name declared in this tree or an ancestor one, never in agr-panel's own shadow tree.
 */
export const sectionHostStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  }
  agr-panel {
    container: panel / inline-size;
    flex: 1 1 auto;
  }
  /* A panel with nothing to show at runtime (a configured device Home Assistant doesn't have) keeps its content
     height even when its column stretches it: a stretched blank box would only enlarge the gap. */
  agr-panel[fit] {
    flex: 0 0 auto;
  }
`;

/**
 * Native <dialog> surfaces (§5.4 rules 9 and 13). Sizing uses viewport media queries because top-layer content must
 * not depend on the card's container. ::backdrop gets literal colors, because custom properties only recently
 * started inheriting into it; the theme reaches the dialog through its data-theme attribute.
 */
export const dialogStyles = css`
  dialog {
    box-sizing: border-box;
    padding: 0;
    border: none;
    margin: 0;
    max-inline-size: none;
    max-block-size: none;
    color: var(--agr-ink);
    background: var(--agr-surface);
    box-shadow: var(--agr-shadow-overlay);
    color-scheme: light;
    overscroll-behavior: contain;
    opacity: 1;
    transform: none;
    transition:
      opacity var(--agr-dur-2) var(--agr-ease),
      transform var(--agr-dur-2) var(--agr-ease);
  }
  dialog[data-theme='dark'] {
    color-scheme: dark;
  }
  dialog::backdrop {
    background: var(--agr-backdrop, rgb(32 34 29 / 0.38));
  }
  dialog[data-theme='dark']::backdrop {
    background: rgb(0 0 0 / 0.55);
  }
  .surface {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    min-block-size: 100%;
    max-block-size: inherit;
  }
  .dialog-header {
    display: flex;
    align-items: center;
    gap: var(--agr-space-3);
    padding: var(--agr-space-4) var(--agr-space-4) var(--agr-space-2) var(--agr-space-6);
  }
  .dialog-header h2 {
    flex: 1 1 auto;
    margin: 0;
    font: var(--agr-type-value);
  }
  .dialog-body {
    flex: 1 1 auto;
    overflow: auto;
    overscroll-behavior: contain;
    padding: var(--agr-space-2) var(--agr-space-6) var(--agr-space-6);
  }
  /* The body spans the dialog's full width, so an outset ring would be clipped by the dialog's own edge. */
  .dialog-body:focus-visible {
    outline-offset: -2px;
  }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: var(--agr-target);
    block-size: var(--agr-target);
    padding: 0;
    border: none;
    border-radius: var(--agr-radius-control);
    color: var(--agr-ink);
    background: var(--agr-surface-inset);
    cursor: pointer;
  }
  /* Bottom sheet below 720 px (and always for data-sheet='bottom'). */
  dialog.sheet {
    position: fixed;
    inset: auto 0 0 0;
    inline-size: 100%;
    max-block-size: 92dvh;
    border-radius: var(--agr-radius-panel) var(--agr-radius-panel) 0 0;
    padding-block-end: env(safe-area-inset-bottom);
  }
  @starting-style {
    dialog.sheet[open] {
      opacity: 0;
      transform: translateY(24px);
    }
  }
  /* Side sheet on the inline end at 720 px and wider. */
  @media (width >= 720px) {
    dialog.sheet:not([data-sheet='bottom']) {
      inset: 0 0 0 auto;
      inline-size: min(440px, 92vw);
      block-size: 100dvh;
      max-block-size: 100dvh;
      border-radius: var(--agr-radius-panel) 0 0 var(--agr-radius-panel);
      padding-block-end: 0;
    }
    @starting-style {
      dialog.sheet:not([data-sheet='bottom'])[open] {
        opacity: 0;
        transform: translateX(24px);
      }
    }
  }
  dialog.centered {
    position: fixed;
    inset: 0;
    margin: auto;
    inline-size: var(--agr-dialog-width, min(420px, 94vw));
    max-block-size: 92dvh;
    block-size: fit-content;
    border-radius: var(--agr-radius-panel);
  }
  @starting-style {
    dialog.centered[open] {
      opacity: 0;
      transform: translateY(12px);
    }
  }
`;
