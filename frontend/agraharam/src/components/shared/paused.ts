/**
 * While Home Assistant is disconnected or resyncing, the alert banner carries the one full sentence (§9.1). Panels
 * then show a muted "Offline" pill with a wifi-off glyph in their header instead of repeating it: their controls keep
 * the full reason in aria-describedby, and last-known values keep their "Last known" marks. The pill says what is
 * wrong (the connection), not "Paused", which beside Media's pause button read as playback paused (§16.14).
 */
import type { StoreView } from '../../ha/entity-store.ts';
import type { PanelPill } from '../primitives/agr-panel.ts';

export const PAUSED_PILL: PanelPill = Object.freeze({ label: 'Offline', tone: 'muted', icon: 'wifi-off' });

/** States are known but not current: the connection is down or the post-reconnect snapshot has not arrived. */
export function pausedByConnection(store: StoreView | undefined): boolean {
  return store?.isReady() === true && !store.isConnected();
}

/** The panel's header pill: "Offline" while the connection is down, else the panel's own pill. */
export function panelPill(store: StoreView | undefined, own?: PanelPill): PanelPill | undefined {
  return pausedByConnection(store) ? PAUSED_PILL : own;
}
