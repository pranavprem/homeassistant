/** Mounts the real card, optionally driven by FakeHass (§12.1), and exposes its shadow tree. */
import { AgraharamDashboard } from '../../src/agraharam-dashboard.ts';
import '../../src/agraharam.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import { FakeHass } from '../../src/dev/fake-hass.ts';
import { settle, stubWidth } from './dom.ts';

export interface MountOptions {
  readonly config: Record<string, unknown>;
  /** Drives the card like HA: every FakeHass push is assigned to card.hass. */
  readonly fake?: FakeHass;
  /** Host width from getBoundingClientRect at connect (0 means not laid out yet). */
  readonly width?: number;
}

export interface MountedCard {
  readonly card: AgraharamDashboard;
  readonly root: ShadowRoot;
  /** The published DashboardServices, read the way a section receives them. */
  services(): DashboardServices | undefined;
  stopPushes(): void;
}

export const WIDE_WIDTH = 1384;

export async function mountCard(options: MountOptions): Promise<MountedCard> {
  const card = document.createElement('agraharam-dashboard');
  stubWidth(card, options.width ?? WIDE_WIDTH);
  card.setConfig({ type: 'custom:agraharam-dashboard', ...options.config });
  const fake = options.fake;
  let stop = (): void => undefined;
  if (fake !== undefined) {
    card.hass = fake.hass;
    stop = fake.onPush((hass) => {
      card.hass = hass;
    });
  }
  document.body.append(card);
  await settle();
  const root = card.shadowRoot;
  if (root === null) throw new Error('card has no shadow root');
  return {
    card,
    root,
    services: () => root.querySelector('agr-header')?.services,
    stopPushes: stop,
  };
}

export { AgraharamDashboard, FakeHass };
