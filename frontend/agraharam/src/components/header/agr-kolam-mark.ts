/**
 * The identity mark beside the wordmark (§6.5): a 3 × 3 pulli lattice with one continuous looped stroke, in brass,
 * 28 px, decorative. Brass is applied to the SVG paint (stroke and dot fill), never as a text color, because plain
 * brass does not reach 4.5:1 as text. It appears nowhere else in the dashboard; the header marks it aria-hidden.
 */
import { css, LitElement, type TemplateResult } from 'lit';
import { renderIcon } from '../../icons/render-icon.ts';
import { defineOnce } from '../../util/define.ts';

const KOLAM_SIZE_PX = 28;

class AgrKolamMark extends LitElement {
  static override styles = css`
    :host {
      display: inline-flex;
      flex: none;
      line-height: 0;
    }
    svg {
      stroke: var(--agr-brass);
    }
    /* The lattice dots carry stroke="none" and a fill; only their fill changes to brass. */
    svg circle {
      fill: var(--agr-brass);
    }
  `;

  protected override render(): TemplateResult {
    return renderIcon('kolam', KOLAM_SIZE_PX);
  }
}

defineOnce('agr-kolam-mark', AgrKolamMark);

declare global {
  interface HTMLElementTagNameMap {
    'agr-kolam-mark': AgrKolamMark;
  }
}
