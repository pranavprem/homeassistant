/**
 * Climate drawer (§5.3). Opened from a comfort tile (one device, headed by its name) or from "+N more" (every
 * comfort device). Climate devices get the current reading, a target stepper on the device's step grid and an HVAC
 * mode choice group; air purifiers get the shared fan controls; bed devices are read-only.
 *
 * Every gesture goes through this drawer's ActionController: mode and power activations are single requests, the
 * stepper and speed slider are debounced drafts. Arrow keys never act on a choice group (§7.2). One polite live
 * region reports tickets and discarded drafts, each with Dismiss where the outcome needs acknowledging.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import { ActionController } from '../../ha/actions/action-controller.ts';
import { STEPPER_COMMIT_DEBOUNCE_MS, type Availability } from '../../ha/actions/types.ts';
import { CONTROL_META, EntityController } from '../../ha/entity-controller.ts';
import { parseNumericValue, type Display } from '../../ha/normalize.ts';
import { choiceReason } from '../../model/choice.ts';
import { entityActionKey } from '../../model/controls.ts';
import { comfortActionKeys, comfortEntityIds, selectComfortTiles, type ComfortTile } from '../../model/comfort.ts';
import type { AirTileVM, BedTileVM, ClimateTileVM } from '../../model/types.ts';
import { skeletonStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { isDefined } from '../../util/defined.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-choice-group.ts';
import type { ChooseDetail } from '../primitives/agr-choice-group.ts';
import '../primitives/agr-drawer.ts';
import '../primitives/agr-empty-state.ts';
import '../primitives/agr-stepper.ts';
import { stepperSpokenText, type DraftDetail, type ReasonDisplay } from '../primitives/control-helpers.ts';
import '../primitives/agr-value.ts';
import type { ValueSize } from '../primitives/agr-value.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';
import { applyFanIntent, type FanIntent } from '../shared/agr-fan-controls.ts';
import '../shared/agr-fan-controls.ts';
import '../shared/agr-control-notes.ts';
import {
  controlNotes,
  noticeStyles,
  renderNotice,
  sharedNotice,
  type ControlNote,
  type NoteSubject,
  dismissNote,
  choiceControls,
} from '../shared/control-notes.ts';
import { selectorInput } from '../shared/selector-input.ts';

type AgrClimateDrawerRequest = Extract<DrawerRequest, { id: 'climate' }>;

const DRAWER_HEADING = 'Climate';
const FOCUS_PREFIX = 'climate';

/** A reading is set large; an absent one (a dash and its label) stays at title size so it never reads as a bar. */
function readingSize(display: Display): ValueSize {
  return display.kind === 'value' ? 'hero' : 'title';
}

export class AgrClimateDrawer extends LitElement implements DrawerElement<AgrClimateDrawerRequest> {
  static override styles = [
    skeletonStyles,
    typographyStyles,
    noticeStyles,
    css`
      .devices {
        display: flex;
        flex-direction: column;
      }
      .device {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-5);
        padding-block: var(--agr-space-5);
      }
      .device + .device {
        border-block-start: 1px solid var(--agr-line);
      }
      .device:first-child {
        padding-block-start: var(--agr-space-3);
      }
      h3 {
        margin: 0;
        font: var(--agr-type-strong);
        color: var(--agr-ink);
      }
      .reading {
        display: flex;
        align-items: flex-end;
        flex-wrap: wrap;
        gap: var(--agr-space-2) var(--agr-space-4);
      }
      .reading-text {
        display: flex;
        flex-direction: column;
        padding-block-end: var(--agr-space-1);
      }
      /* The caption names the number it sits under; what the equipment is doing gets its own line below. */
      .figure {
        display: flex;
        flex-direction: column;
      }
      .activity {
        margin-block-start: calc(var(--agr-space-5) * -1 + var(--agr-space-3));
        color: var(--agr-ink);
        font-weight: 600;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-2);
      }
      p {
        margin: 0;
      }
    `,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrClimateDrawerRequest;

  // Registers itself with this host: re-renders on any comfort entity or control-meta change.
  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services?.config === undefined ? [] : comfortEntityIds(this.services.config)),
      CONTROL_META,
    );
  }

  readonly #actions = new ActionController(
    this,
    () => this.services,
    () => (this.services?.config === undefined ? [] : comfortActionKeys(this.services.config)),
  );

  readonly #onDismissNote = contained('climate-dismiss-failed', (event: CustomEvent<ControlNote>) => {
    event.stopPropagation();
    dismissNote(event.detail, this.#actions);
  });

  readonly #onTarget = contained('climate-target-failed', (vm: ClimateTileVM, event: CustomEvent<DraftDetail>) => {
    event.stopPropagation();
    const entity = vm.key;
    this.#actions.draft(
      entityActionKey(entity),
      event.detail.value,
      (temperature) => ({ kind: 'climate.set_temperature', entity, temperature }),
      STEPPER_COMMIT_DEBOUNCE_MS,
      () => this.#observedAttribute(entity, 'temperature'),
    );
  });

  readonly #onMode = contained('climate-mode-failed', (vm: ClimateTileVM, event: CustomEvent<ChooseDetail>) => {
    event.stopPropagation();
    this.#actions.request({ kind: 'climate.set_hvac_mode', entity: vm.key, mode: event.detail.value });
  });

  readonly #onFanIntent = contained('climate-fan-intent-failed', (vm: AirTileVM, event: CustomEvent<FanIntent>) => {
    event.stopPropagation();
    applyFanIntent(this.#actions, event.detail, () => this.#observedAttribute(vm.key, 'percentage'));
  });

  protected override render(): TemplateResult {
    const services = this.services;
    if (services?.store === undefined || services.config === undefined) return this.#renderShell(DRAWER_HEADING);
    let tiles: readonly ComfortTile[];
    try {
      tiles = selectComfortTiles(selectorInput(services));
    } catch {
      log.error('climate-drawer-render-failed');
      return this.#renderShell(DRAWER_HEADING);
    }
    const focused = tiles.find((tile) => tile.vm.key === this.request?.entity);
    const shown = focused === undefined ? tiles : [focused];
    const subjects = shown.flatMap(noteSubject);
    const notes = controlNotes(
      subjects,
      (key) => this.#actions.status(key),
      (key) => this.#actions.draftState(key),
    );
    // One notice when every control is paused for the same reason (controls off, editing, disconnected), instead
    // of the same line under each stepper, slider and group (§16.10).
    const notice = sharedNotice(shown.flatMap(tileControls));
    const reasons: ReasonDisplay = notice === undefined ? 'visible' : 'hidden';
    return html`<agr-drawer
      heading=${focused?.vm.name ?? DRAWER_HEADING}
      .demo=${services.mode === 'demo'}
      .theme=${services.theme}
    >
      ${renderNotice(notice)}
      <agr-control-notes
        .notes=${notes}
        focus-key-prefix=${FOCUS_PREFIX}
        @agr-dismiss-note=${this.#onDismissNote}
      ></agr-control-notes>
      ${
        shown.length === 0
          ? html`<agr-empty-state
              icon="thermometer"
              heading="No climate devices here yet"
              message="Climate, air and bed devices will show up here once they're connected."
            ></agr-empty-state>`
          : html`<div class="devices">
              ${shown.map((tile) => this.#renderDevice(tile, focused === undefined, reasons))}
            </div>`
      }
    </agr-drawer>`;
  }

  #renderShell(heading: string): TemplateResult {
    return html`<agr-drawer heading=${heading} .demo=${this.services?.mode === 'demo'} .theme=${this.services?.theme}>
      <span class="skeleton" aria-hidden="true"></span>
    </agr-drawer>`;
  }

  /** A device group; in the all-devices drawer each group is headed by an <h3> with the device name. */
  #renderDevice(tile: ComfortTile, titled: boolean, reasons: ReasonDisplay): TemplateResult {
    const heading = titled ? html`<h3>${tile.vm.name}</h3>` : nothing;
    switch (tile.kind) {
      case 'climate':
        return html`<section class="device">${heading}${this.#renderClimate(tile.vm, reasons)}</section>`;
      case 'air':
        return html`<section class="device">${heading}${this.#renderAir(tile.vm, reasons)}</section>`;
      case 'bed':
        return html`<section class="device">${heading}${this.#renderBed(tile.vm)}</section>`;
    }
  }

  #renderClimate(vm: ClimateTileVM, reasons: ReasonDisplay): TemplateResult {
    const key = entityActionKey(vm.key);
    const focus = `${FOCUS_PREFIX}:${vm.key}`;
    const noTarget = vm.target !== undefined && vm.setTemperature === undefined && vm.status === 'available';
    return html`<div class="reading">
        <span class="figure">
          <agr-value field="Current temperature" size=${readingSize(vm.current)} .display=${vm.current}></agr-value>
          <span class="t-meta" aria-hidden="true">Current temperature</span>
        </span>
      </div>
      <p class="activity t-meta">${vm.actionLabel ?? vm.modeLabel}</p>
      ${
        vm.setTemperature === undefined
          ? noTarget
            ? html`<p class="t-meta">No target temperature in this mode.</p>`
            : nothing
          : html`<agr-stepper
              label="Target temperature"
              focus-key=${`${focus}:target`}
              .value=${vm.setTemperature.value}
              .min=${vm.setTemperature.min}
              .max=${vm.setTemperature.max}
              .step=${vm.setTemperature.step}
              unit=${vm.setTemperature.unit}
              .availability=${vm.setTemperature.availability}
              .draft=${this.#actions.draftState(key)}
              reason-display=${reasons}
              @agr-draft=${(event: CustomEvent<DraftDetail>) => this.#onTarget(vm, event)}
            ></agr-stepper>`
      }
      ${
        vm.hvacModes === undefined
          ? nothing
          : html`<div class="field">
              <span class="t-label" aria-hidden="true">${vm.hvacModes.label}</span>
              <agr-choice-group
                label=${`${vm.hvacModes.label} for ${vm.name}`}
                focus-key-prefix=${`${focus}:mode`}
                .options=${vm.hvacModes.options}
                @agr-choose=${(event: CustomEvent<ChooseDetail>) => this.#onMode(vm, event)}
              ></agr-choice-group>
              ${reasons === 'visible' ? this.#reasonLine(choiceReason(vm.hvacModes)) : nothing}
            </div>`
      }`;
  }

  #renderAir(vm: AirTileVM, reasons: ReasonDisplay): TemplateResult {
    // The reading names the preset when one is active, so the speed goes beside it.
    const speed = vm.percentage?.value;
    const speedText =
      vm.power === 'on' && vm.presets?.current !== undefined && speed !== undefined && speed > 0
        ? `Speed ${Math.round(speed)}%`
        : undefined;
    return html`<div class="reading">
        <agr-value field="Purifier" size="title" .display=${vm.detail}></agr-value>
        ${
          speedText === undefined
            ? nothing
            : html`<span class="reading-text"><span class="t-meta">${speedText}</span></span>`
        }
      </div>
      <agr-fan-controls
        .tile=${vm}
        .draft=${this.#actions.draftState(entityActionKey(vm.key))}
        focus-key-prefix=${`${FOCUS_PREFIX}:${vm.key}`}
        reason-display=${reasons}
        @agr-fan-intent=${(event: CustomEvent<FanIntent>) => this.#onFanIntent(vm, event)}
      ></agr-fan-controls>`;
  }

  #renderBed(vm: BedTileVM): TemplateResult {
    const target = vm.target?.kind === 'value' ? `Set to ${vm.target.text}` : undefined;
    return html`<div class="reading">
        <span class="figure">
          <agr-value field="Bed temperature" size=${readingSize(vm.current)} .display=${vm.current}></agr-value>
          <span class="t-meta" aria-hidden="true">Bed temperature</span>
        </span>
        ${target === undefined ? nothing : html`<span class="reading-text"><span class="t-strong">${target}</span></span>`}
      </div>
      <p class="t-meta">Shown for reference. This dashboard doesn't change bed settings.</p>`;
  }

  #reasonLine(reason: string | undefined): TemplateResult | typeof nothing {
    return reason === undefined ? nothing : html`<p class="t-meta">${reason}</p>`;
  }

  #observedAttribute(entity: EntityId, attribute: string): number | null {
    return parseNumericValue(this.services?.store.get(entity)?.attributes[attribute]);
  }
}

/**
 * The device the live region reports for a tile; bed devices have no controls. A climate device's pending target is
 * announced with its scale, as the stepper itself reads it ("Target 73°F"), because tapping a stepper changes a value
 * nothing else reads out (§7.2).
 */
function noteSubject(tile: ComfortTile): NoteSubject[] {
  if (tile.kind === 'bed') return [];
  const subject = { key: entityActionKey(tile.vm.key), name: tile.vm.name };
  const unit = tile.kind === 'climate' ? tile.vm.setTemperature?.unit : undefined;
  if (unit === undefined) return [subject];
  return [{ ...subject, draftText: (value: number) => `Target ${stepperSpokenText(value, unit)}` }];
}

/** Every control a device renders here, for the drawer's shared notice; bed devices have none. */
function tileControls(tile: ComfortTile): readonly Availability[] {
  switch (tile.kind) {
    case 'climate':
      return [tile.vm.setTemperature?.availability, ...choiceControls(tile.vm.hvacModes)].filter(isDefined);
    case 'air':
      return [tile.vm.toggle, tile.vm.percentage?.availability, ...choiceControls(tile.vm.presets)].filter(isDefined);
    case 'bed':
      return [];
  }
}

defineOnce('agr-climate-drawer', AgrClimateDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-climate-drawer': AgrClimateDrawer;
  }
}
