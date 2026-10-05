/**
 * Full-width shell banners above the columns (§5.1, §9.1): a LIVE triggered alarm (role="alert", with "Open
 * Security"), then at most one connection banner (disconnected, reconnecting or HA starting; a polite status).
 *
 * Both live regions are always in the DOM, so a banner appearing inside them is announced; content inserted together
 * with a brand-new live region is not reliably read. While nothing is shown the host cancels the frame's flex gap
 * with a negative margin, so an empty banner adds no space above the columns (§6.2.1 height budget).
 */
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { ENABLED } from '../../ha/actions/types.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { bannerEntityIds, selectAlertBanners, type AlertBannerVM } from '../../model/header.ts';
import type { IconName } from '../../model/types.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import type { DashboardServices } from '../services.ts';
import { requestDrawer } from './overlay-types.ts';
import { selectorInput } from '../shared/selector-input.ts';

const BANNER_META: readonly MetaKind[] = Object.freeze(['connection']);
const BANNER_ICON_PX = 20;
const BANNER_ICONS: Readonly<Record<AlertBannerVM['kind'], IconName>> = Object.freeze({
  alarm: 'shield-alert',
  disconnected: 'wifi-off',
  resyncing: 'wifi',
  starting: 'info',
});
const NO_BANNERS: readonly AlertBannerVM[] = Object.freeze([]);

export class AgrAlertBanner extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    :host([data-empty]) {
      margin-block-start: calc(-1 * var(--agr-gap));
    }
    /* Not display: contents, which drops the live-region role from the accessibility tree in some engines. */
    .region {
      display: flex;
      flex-direction: column;
      gap: var(--agr-space-2);
    }
    .region:not(:empty) ~ .region:not(:empty) {
      margin-block-start: var(--agr-space-2);
    }
    .banner {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--agr-space-2) var(--agr-space-3);
      min-block-size: 52px;
      padding: var(--agr-space-2) var(--agr-space-3) var(--agr-space-2) var(--agr-space-4);
      border-radius: var(--agr-radius-inner);
      color: var(--agr-ink);
      background: var(--agr-surface-inset);
    }
    .banner[data-tone='danger'] {
      color: var(--agr-danger);
      background: var(--agr-danger-tint);
    }
    .banner[data-tone='attention'] {
      color: var(--agr-brass-ink);
      background: var(--agr-brass-tint);
    }
    .icon {
      display: inline-flex;
      flex: none;
    }
    p {
      flex: 1 1 18rem;
      min-inline-size: 0;
      margin: 0;
      font: var(--agr-type-body);
    }
    strong {
      font-weight: 650;
    }
  `;

  @property({ attribute: false }) services?: DashboardServices;

  #banners: readonly AlertBannerVM[] = NO_BANNERS;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services?.config === undefined ? [] : bannerEntityIds(this.services.config)),
      BANNER_META,
    );
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    this.#banners = this.#select();
    this.toggleAttribute('data-empty', this.#banners.length === 0);
  }

  protected override render(): TemplateResult {
    const alarm = this.#banners.filter((banner) => banner.urgent);
    const status = this.#banners.filter((banner) => !banner.urgent);
    // Nothing but the bindings inside each region, so an empty one matches :empty.
    return html`<div class="region" role="alert">${alarm.map((banner) => this.#renderBanner(banner))}</div>
      <div class="region" role="status">${status.map((banner) => this.#renderBanner(banner))}</div>`;
  }

  #renderBanner(banner: AlertBannerVM): TemplateResult {
    return html`<div class="banner" data-kind=${banner.kind} data-tone=${banner.tone}>
      <span class="icon" aria-hidden="true">${renderIcon(BANNER_ICONS[banner.kind], BANNER_ICON_PX)}</span>
      <p><strong>${banner.title}</strong>${banner.message === '' ? nothing : ` ${banner.message}`}</p>
      ${
        banner.kind === 'alarm'
          ? html`<agr-button
              label="Open Security"
              opens-dialog
              icon="shield"
              focus-key="banner:security"
              .availability=${ENABLED}
              @agr-activate=${this.#onOpenSecurity}
            ></agr-button>`
          : nothing
      }
    </div>`;
  }

  #select(): readonly AlertBannerVM[] {
    const services = this.services;
    if (services?.store === undefined || services.reader === undefined) return NO_BANNERS;
    try {
      return selectAlertBanners(selectorInput(services));
    } catch {
      log.error('banner-select-failed');
      return NO_BANNERS;
    }
  }

  readonly #onOpenSecurity = contained('banner-security-failed', (event: Event) => {
    requestDrawer(this, { id: 'security' }, event.currentTarget as HTMLElement);
  });
}

defineOnce('agr-alert-banner', AgrAlertBanner);

declare global {
  interface HTMLElementTagNameMap {
    'agr-alert-banner': AgrAlertBanner;
  }
}
