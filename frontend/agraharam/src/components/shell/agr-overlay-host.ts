/**
 * Overlay host (§5.2, §5.4): the one place that decides which drawer, camera dialog and confirm dialog are mounted.
 * The root routes every overlay event here (open, confirm) and calls closeAll() on configuration changes and on
 * detach. Stacking: one drawer at a time (a new one replaces it), the camera dialog above the cameras drawer, and the
 * confirm dialog above everything; showModal() order puts the newest in the top layer.
 */
import { css, html, LitElement, type PropertyValues, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { frozenActionRequest } from '../../ha/actions/types.ts';
import { visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { composedParent, deepActiveElement, findDeep, focusKeyOf } from '../../util/focus.ts';
import { contained, log } from '../../util/log.ts';
import type { AgrCameraDialog } from '../cameras/agr-camera-dialog.ts';
import { CONFIRM_REFUSED_ANNOUNCEMENT, type AgrConfirmDialog } from '../primitives/agr-confirm-dialog.ts';
import type { DashboardServices } from '../services.ts';
import { DRAWER_TAGS, type ConfirmDetail, type DrawerElement, type OpenDrawerDetail } from './overlay-types.ts';

/** Where focus returns when an overlay closes (§5.4 rule 7), recorded when it opens. */
interface RestoreTarget {
  readonly trigger: HTMLElement | null;
  readonly focusKey?: string;
  readonly headingId?: string;
}

interface Mounted<E extends HTMLElement> {
  readonly element: E;
  readonly restore: RestoreTarget;
}

/** Marks the card frame, the last focus fallback (§5.4 rule 7). */
const FOCUS_FALLBACK_ATTRIBUTE = 'data-focus-fallback';

export class AgrOverlayHost extends LitElement {
  static override styles = [
    visuallyHiddenStyles,
    css`
      :host {
        display: contents;
      }
    `,
  ];

  @property({ attribute: false }) services?: DashboardServices;
  /** Overlay announcements such as "Not sent. Confirmation timed out." (polite). */
  @state() private announcement = '';

  #drawer: Mounted<DrawerElement> | undefined;
  #camera: Mounted<AgrCameraDialog> | undefined;
  #confirm: Mounted<AgrConfirmDialog> | undefined;

  /** Mounts the drawer (or camera dialog) for a request. A drawer replaces an open drawer and keeps its trigger. */
  open(detail: OpenDrawerDetail): void {
    const services = this.services;
    if (services === undefined) return;
    const request = detail.request;
    if (request.id === 'camera') {
      this.#unmount(this.#camera);
      const element = document.createElement('agr-camera-dialog');
      element.services = services;
      element.request = request;
      this.#applyDialogTheme(element, services);
      this.#camera = { element, restore: restoreTargetFor(detail.trigger) };
      this.#layer().append(element);
      return;
    }
    const restore = this.#drawer?.restore ?? restoreTargetFor(detail.trigger);
    this.#unmount(this.#drawer);
    const element = document.createElement(DRAWER_TAGS[request.id]) as DrawerElement;
    element.services = services;
    element.request = request;
    this.#drawer = { element, restore };
    this.#layer().append(element);
  }

  /**
   * Stacks a confirm dialog above any drawer; focus returns to the button that asked for it. The dialog gets a
   * frozen, validated copy of the action, so what it shows and confirms can never change under it (§5.2 rule 1). A
   * malformed action is refused here, fails closed, and is announced; nothing is mounted and nothing is sent.
   */
  confirm(detail: ConfirmDetail): void {
    const services = this.services;
    if (services === undefined) return;
    const action = frozenActionRequest(detail.action);
    if (action === undefined) {
      log.error('confirm-action-invalid');
      this.#announce(CONFIRM_REFUSED_ANNOUNCEMENT);
      return;
    }
    this.#unmount(this.#confirm);
    const element = document.createElement('agr-confirm-dialog');
    element.services = services;
    element.action = action;
    this.#applyDialogTheme(element, services);
    this.#confirm = { element, restore: restoreTargetFor(detail.trigger) };
    this.#layer().append(element);
  }

  /**
   * §5.4 rule 11: unmounts every overlay. Each dialog closes itself on disconnect, the camera dialog releases its
   * stream there, and a confirm is cancelled without sending. Restore targets are dropped: nothing reopens.
   */
  closeAll(): void {
    for (const mounted of [this.#confirm, this.#camera, this.#drawer]) this.#unmount(mounted);
    this.#confirm = undefined;
    this.#camera = undefined;
    this.#drawer = undefined;
  }

  /** Whether any overlay is mounted (diagnostics and tests). */
  get hasOpenOverlay(): boolean {
    return this.#drawer !== undefined || this.#camera !== undefined || this.#confirm !== undefined;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.closeAll();
  }

  protected override updated(changed: PropertyValues<this>): void {
    const services = this.services;
    if (!changed.has('services') || services === undefined) return;
    if (this.#drawer) this.#drawer.element.services = services;
    if (this.#camera) {
      this.#camera.element.services = services;
      this.#applyDialogTheme(this.#camera.element, services);
    }
    if (this.#confirm) {
      this.#confirm.element.services = services;
      this.#applyDialogTheme(this.#confirm.element, services);
    }
  }

  protected override render(): TemplateResult {
    return html`<div class="layer" @agr-drawer-closed=${this.#onClosed}></div>
      <div class="visually-hidden" role="status">${this.announcement}</div>`;
  }

  /** The composed path identifies which mounted overlay closed, whichever shadow root dispatched the event. */
  readonly #onClosed = contained('overlay-closed-failed', (event: Event) => {
    const path = event.composedPath();
    if (this.#confirm && path.includes(this.#confirm.element)) {
      const mounted = this.#confirm;
      this.#confirm = undefined;
      this.#announce(mounted.element.announcement ?? '');
      this.#finishClose(mounted);
    } else if (this.#camera && path.includes(this.#camera.element)) {
      const mounted = this.#camera;
      this.#camera = undefined;
      this.#finishClose(mounted);
    } else if (this.#drawer && path.includes(this.#drawer.element)) {
      const mounted = this.#drawer;
      this.#drawer = undefined;
      this.#finishClose(mounted);
    }
  });

  /** Clears the region before setting it, so a message identical to the last one is announced again. */
  #announce(text: string): void {
    this.announcement = '';
    if (text === '') return;
    void this.updateComplete
      .then(() => {
        this.announcement = text;
      })
      .catch(() => log.error('overlay-announce-failed'));
  }

  #finishClose(mounted: Mounted<HTMLElement>): void {
    mounted.element.remove();
    this.#restoreFocus(mounted.restore);
  }

  #unmount(mounted: Mounted<HTMLElement> | undefined): void {
    mounted?.element.remove();
  }

  /** The overlay host passes the theme and demo flag to every dialog element (§5.4 rule 13, §10.1). */
  #applyDialogTheme(element: AgrCameraDialog | AgrConfirmDialog, services: DashboardServices): void {
    element.theme = services.theme;
    element.demo = services.mode === 'demo';
  }

  #layer(): HTMLElement {
    const layer = this.renderRoot.querySelector<HTMLElement>('.layer');
    if (layer === null) throw new Error('agr-overlay-host rendered no layer');
    return layer;
  }

  /** §5.4 rule 7: the trigger if still connected, else the element with its focus key, else the originating
   *  section's heading, else the card frame. */
  #restoreFocus(restore: RestoreTarget): void {
    if (restore.trigger?.isConnected) {
      restore.trigger.focus();
      return;
    }
    const root = this.getRootNode();
    if (!(root instanceof ShadowRoot || root instanceof Document)) return;
    const searchRoot = root instanceof Document ? root.documentElement : root;
    const target =
      (restore.focusKey && findDeep(searchRoot, (el) => el.getAttribute('data-focus-key') === restore.focusKey)) ||
      (restore.headingId && findDeep(searchRoot, (el) => el.id === restore.headingId)) ||
      findDeep(searchRoot, (el) => el.hasAttribute(FOCUS_FALLBACK_ATTRIBUTE));
    if (target instanceof HTMLElement) target.focus();
  }
}

/** Records the trigger, its focus key and its section heading; a gone trigger falls back to the deep active
 *  element (§5.4 rule 2). */
function restoreTargetFor(trigger: HTMLElement | undefined): RestoreTarget {
  const active = deepActiveElement();
  const element = trigger?.isConnected ? trigger : active instanceof HTMLElement ? active : null;
  if (element === null) return { trigger: null };
  const focusKey = focusKeyOf(element);
  const headingId = sectionHeadingIdOf(element);
  return {
    trigger: element,
    ...(focusKey !== undefined && { focusKey }),
    ...(headingId !== undefined && { headingId }),
  };
}

/** The heading id of the agr-panel that contains `element` in the composed tree, if any. */
function sectionHeadingIdOf(element: Element): string | undefined {
  for (let node: Element | null = element; node !== null; node = composedParent(node)) {
    if (node.tagName === 'AGR-PANEL') return node.getAttribute('heading-id') ?? undefined;
  }
  return undefined;
}

defineOnce('agr-overlay-host', AgrOverlayHost);

declare global {
  interface HTMLElementTagNameMap {
    'agr-overlay-host': AgrOverlayHost;
  }
}
