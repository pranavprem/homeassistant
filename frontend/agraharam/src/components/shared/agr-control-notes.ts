/**
 * A section's single polite live region (§7.2, §16.10), the one implementation every section and drawer with
 * controls renders. The region element is always present, even when quiet, so assistive technology tracks it before
 * a message arrives; while nothing in it is visible it takes no space. Uncertain and failed outcomes and discarded
 * drafts stay visible with a Dismiss button until acknowledged; announce-only notes are read but not shown.
 *
 * Emits 'agr-dismiss-note' (detail: the ControlNote, { bubbles: true, composed: false }) for the section to clear
 * what the note stands for.
 */
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { ENABLED } from '../../ha/actions/types.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { toneStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import '../primitives/agr-button.ts';
import type { ControlNote } from './control-notes.ts';

const NOTE_ICON_SIZE = 16;

class AgrControlNotes extends LitElement {
  static override styles = [
    toneStyles,
    visuallyHiddenStyles,
    css`
      :host {
        display: block;
      }
      .notes {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-2);
      }
      /* Inside the shadow root, so a section that cancels its own gap around the host keeps this spacing. */
      :host(:not([quiet])) .notes {
        margin-block-start: var(--agr-space-3);
      }
      .note {
        display: flex;
        align-items: center;
        gap: var(--agr-space-2);
        font: var(--agr-type-meta);
      }
      .note svg {
        flex: none;
      }
      .text {
        flex: 1 1 auto;
        min-inline-size: 0;
      }
      .name {
        font-weight: 650;
        color: var(--agr-ink);
      }
      /* The button keeps its 44 px target; the text wraps instead. */
      agr-button {
        flex: none;
      }
    `,
  ];

  @property({ attribute: false }) notes: readonly ControlNote[] = [];
  /** Prefix of each Dismiss button's stable data-focus-key (§5.1). */
  @property({ attribute: 'focus-key-prefix' }) focusKeyPrefix = '';

  /** `quiet` on the host while nothing is visible, so the region adds no space around the section's content. */
  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    this.toggleAttribute(
      'quiet',
      this.notes.every((note) => note.announceOnly),
    );
  }

  protected override render(): TemplateResult {
    // role="status" implies aria-atomic="true", which would re-read every note when one changes; each note is
    // announced on its own instead (additions and text changes only, never removals).
    return html`<div class="notes" role="status" aria-atomic="false" aria-relevant="additions text">
      ${repeat(
        this.notes,
        (note) => note.id,
        (note) => this.#renderNote(note),
      )}
    </div>`;
  }

  #renderNote(note: ControlNote): TemplateResult {
    return html`<div class=${note.announceOnly ? 'visually-hidden' : 'note'} data-tone=${note.tone}>
      ${note.icon === undefined ? nothing : renderIcon(note.icon, NOTE_ICON_SIZE)}
      <span class="text"
        >${note.name === undefined ? nothing : html`<span class="name">${note.name}</span> `}${note.text}</span
      >
      ${
        note.dismissible
          ? html`<agr-button
              label="Dismiss"
              focus-key=${`${this.focusKeyPrefix}:dismiss:${note.key}:${note.source}`}
              .availability=${ENABLED}
              @agr-activate=${() => this.#dismiss(note)}
            ></agr-button>`
          : nothing
      }
    </div>`;
  }

  #dismiss(note: ControlNote): void {
    this.dispatchEvent(new CustomEvent('agr-dismiss-note', { bubbles: true, composed: false, detail: note }));
  }
}

defineOnce('agr-control-notes', AgrControlNotes);

declare global {
  interface HTMLElementTagNameMap {
    'agr-control-notes': AgrControlNotes;
  }
  interface HTMLElementEventMap {
    'agr-dismiss-note': CustomEvent<ControlNote>;
  }
}
