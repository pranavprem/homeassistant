/**
 * Bundle entry (§3, §11.3): registers every element through its module's defineOnce side effect, then lists the
 * card in HA's card picker.
 */
import './agraharam-dashboard.ts';
import './components/primitives/agr-button.ts';
import './components/primitives/agr-choice-group.ts';
import './components/primitives/agr-confirm-dialog.ts';
import './components/primitives/agr-drawer.ts';
import './components/primitives/agr-empty-state.ts';
import './components/primitives/agr-icon-button.ts';
import './components/primitives/agr-panel.ts';
import './components/primitives/agr-slider.ts';
import './components/primitives/agr-stepper.ts';
import './components/primitives/agr-value.ts';
import './components/shell/agr-alert-banner.ts';
import './components/shell/agr-config-error.ts';
import './components/shell/agr-demo-ribbon.ts';
import './components/shell/agr-overlay-host.ts';
import './components/shared/agr-fan-controls.ts';
import './components/header/agr-header.ts';
import './components/header/agr-household-drawer.ts';
import './components/today/agr-today.ts';
import './components/today/agr-weather-drawer.ts';
import './components/comfort/agr-comfort.ts';
import './components/comfort/agr-climate-drawer.ts';
import './components/home/agr-home.ts';
import './components/home/agr-room-drawer.ts';
import './components/home/agr-home-drawer.ts';
import './components/cameras/agr-cameras.ts';
import './components/cameras/agr-cameras-drawer.ts';
import './components/cameras/agr-camera-dialog.ts';
import './components/garage/agr-garage.ts';
import './components/media/agr-media.ts';
import './components/media/agr-media-drawer.ts';
import './components/upcoming/agr-upcoming.ts';
import './components/security/agr-security-drawer.ts';
import './components/health/agr-health.ts';
import './components/health/agr-health-drawer.ts';
import './components/readings/agr-readings-drawer.ts';
import './components/sky/agr-sky.ts';
import './components/sky/agr-sky-drawer.ts';
import './components/diagnostics/agr-diagnostics-drawer.ts';

const CARD_ENTRY: CustomCardEntry = Object.freeze({
  type: 'agraharam-dashboard',
  name: 'Agraharam',
  description: 'A composed household dashboard for a full-width panel view.',
  // A full live preview in HA's card picker would start the whole dashboard; the picker shows the name only.
  preview: false,
});

// HA owns this list: create it only if absent and never replace it (other cards may already be listed).
const customCards = (window.customCards ??= []);
if (!customCards.some((card) => card.type === CARD_ENTRY.type)) customCards.push(CARD_ENTRY);
