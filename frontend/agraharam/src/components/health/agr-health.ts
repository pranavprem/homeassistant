/**
 * House health (§4.8, §6.2.1): a quiet panel that counts only NAMED monitored inputs. Two stat rows (the count
 * in the serif value face, "4 of 4", beside its label, "monitored entry points closed"), each with its glyph in the
 * same 36 px well as the Home rows, and the Details button beside them; then at most three named problems (open entry
 * points first). It never says everything is fine: the facts always count. While Home Assistant is disconnected the
 * header carries an "Offline" pill and the banner carries the full sentence, so the panel does not repeat it.
 *
 * Quiet panels never stretch (§6.2).
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { ENABLED } from '../../ha/actions/types.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { healthEntityIds, selectHealth, type HealthFactVM, type HealthPanelVM } from '../../model/health.ts';
import { numStyles, sectionHostStyles, skeletonStyles, toneStyles } from '../../styles/shared.ts';
import { PANEL_CQ } from '../../styles/breakpoints.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import '../primitives/agr-panel.ts';
import { PAUSED_PILL } from '../shared/paused.ts';
import type { DashboardServices } from '../services.ts';
import { requestDrawer } from '../shell/overlay-types.ts';
import { selectorInput } from '../shared/selector-input.ts';

/** 'connection' carries haState too, so "Loading" turns into counts when HA finishes starting. */
const HEALTH_META: readonly MetaKind[] = Object.freeze(['connection', 'locale']);
const FACT_ICON_PX = 20;
const PAUSED_LINE = 'Counts resume when Home Assistant reconnects.';
const HEALTH_DETAILS_FOCUS_KEY = 'health:details';

/** The loaded panel's two stat rows: entry points and devices. */
const GHOST_FACTS: readonly number[] = Object.freeze([0, 1]);

export class AgrHealth extends LitElement {
  static override styles = [
    sectionHostStyles,
    skeletonStyles,
    toneStyles,
    numStyles,
    typographyStyles,
    css`
      .summary {
        display: flex;
        align-items: center;
        gap: var(--agr-space-3);
      }
      .facts,
      .problems {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .facts {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        gap: var(--agr-space-1);
        min-inline-size: 0;
      }
      .fact {
        display: flex;
        align-items: center;
        gap: var(--agr-space-3);
        min-block-size: 36px;
        color: var(--agr-ink);
      }
      /* The quiet panel sits between the canvas and the surface, so the inset tone would vanish into it; the
         surface keeps the well visible in both themes. */
      .fact-icon {
        box-sizing: border-box;
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        inline-size: 36px;
        block-size: 36px;
        border-radius: 50%;
        background: var(--agr-surface);
      }
      /* The count and its label share a baseline where both fit on one line beside Details. */
      .fact-text {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        column-gap: var(--agr-space-2);
        min-inline-size: 0;
      }
      /* Narrower panels set every label under its count, so the two rows never break differently (one inline, one
         wrapped) and no word is left alone on a line. */
      @container panel (width < ${PANEL_CQ.healthFactsStacked}px) {
        .fact-text {
          flex-direction: column;
          align-items: flex-start;
        }
      }
      .count {
        flex: none;
        white-space: nowrap;
      }
      .label {
        min-inline-size: 0;
        text-wrap: pretty;
      }
      .summary agr-button {
        flex: none;
      }
      .paused {
        flex: 1 1 auto;
        margin: 0;
      }
      .problems {
        display: flex;
        flex-direction: column;
        gap: 1px;
        margin-block-start: var(--agr-space-3);
        border-radius: var(--agr-radius-inner);
        overflow: hidden;
      }
      .problem {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--agr-space-3);
        padding: 7px var(--agr-space-3);
        background: var(--agr-surface-inset);
      }
      .problem-name {
        min-inline-size: 0;
        font: var(--agr-type-control);
        color: var(--agr-ink);
        overflow-wrap: anywhere;
      }
      .problem-label {
        flex: none;
        font: var(--agr-type-meta-strong);
      }
      .more {
        margin: var(--agr-space-2) 0 0;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      /* The loading facts use the real fact boxes, so they take the loaded rows' height inline or stacked. */
      .fact-ghost .ghost {
        border-radius: 50%;
      }
      .fact-ghost .count-ghost {
        inline-size: 3.5em;
        block-size: 20px;
        margin-block: 3px;
      }
      .fact-ghost .label-ghost {
        inline-size: 9em;
        block-size: 10px;
        margin-block: 4px;
      }
    `,
  ];

  @property({ attribute: false }) services?: DashboardServices;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services?.config === undefined ? [] : healthEntityIds(this.services.config)),
      HEALTH_META,
    );
  }

  protected override render(): TemplateResult {
    const vm = this.#viewModel();
    const pill = vm?.state === 'paused' ? PAUSED_PILL : undefined;
    return html`<agr-panel heading="House" heading-id="agr-health-heading" icon="house" surface="quiet" .pill=${pill}>
      ${vm === undefined || vm.state === 'loading' ? this.#renderLoading() : this.#renderHealth(vm)}
    </agr-panel>`;
  }

  /** The two stat rows of the loaded panel, as placeholders (§6.2.1). */
  #renderLoading(): TemplateResult {
    return html`<div class="summary" aria-hidden="true">
      <ul class="facts">
        ${GHOST_FACTS.map(
          () =>
            html`<li class="fact fact-ghost">
              <span class="fact-icon ghost"></span>
              <span class="fact-text"
                ><span class="skeleton count-ghost"></span><span class="skeleton label-ghost"></span
              ></span>
            </li>`,
        )}
      </ul>
    </div>`;
  }

  #renderHealth(vm: HealthPanelVM): TemplateResult {
    return html`<div class="summary">
        ${
          vm.state === 'paused'
            ? html`<p class="paused t-meta">${PAUSED_LINE}</p>`
            : html`<ul class="facts">
                ${vm.facts.map((fact) => this.#renderFact(fact))}
              </ul>`
        }
        <agr-button
          label="Details"
          opens-dialog
          focus-key=${HEALTH_DETAILS_FOCUS_KEY}
          .availability=${ENABLED}
          @agr-activate=${this.#onDetails}
        ></agr-button>
      </div>
      ${
        vm.problems.length === 0
          ? nothing
          : html`<ul class="problems" aria-label="Needs attention">
              ${vm.problems.map(
                (problem) =>
                  html`<li class="problem">
                    <span class="problem-name">${problem.name}</span
                    ><span class="problem-label" data-tone="attention">${problem.label}</span>
                  </li>`,
              )}
            </ul>`
      }
      ${vm.problemsOverflow > 0 ? html`<p class="more">${vm.problemsOverflow} more in Details</p>` : nothing}`;
  }

  /** A stat row: the count in the value face beside its label. */
  #renderFact(fact: HealthFactVM): TemplateResult {
    return html`<li class="fact" data-key=${fact.key}>
      <span class="fact-icon" data-tone=${fact.tone} aria-hidden="true">${renderIcon(fact.icon, FACT_ICON_PX)}</span>
      <span class="fact-text"
        >${fact.count === '' ? nothing : html`<span class="count t-value num">${fact.count}</span> `}<span
          class="label t-meta"
          >${fact.text}</span
        ></span
      >
    </li>`;
  }

  #viewModel(): HealthPanelVM | undefined {
    const services = this.services;
    if (services?.store === undefined || services.reader === undefined) return undefined;
    try {
      return selectHealth(selectorInput(services));
    } catch {
      log.error('health-select-failed');
      return undefined;
    }
  }

  readonly #onDetails = contained('health-details-failed', (event: Event) => {
    requestDrawer(this, { id: 'health' }, event.currentTarget as HTMLElement);
  });
}

defineOnce('agr-health', AgrHealth);

declare global {
  interface HTMLElementTagNameMap {
    'agr-health': AgrHealth;
  }
}
