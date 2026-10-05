/** Comfort subscribes to CONTROL_META (§4.5): a services change alone (no entity change) re-renders the Climate panel and
 *  the climate drawer, so a control HA stops offering shows service-missing without waiting for a state update. */
import type { LitElement } from 'lit';
import { describe, expect, it } from 'vitest';
import '../../src/components/comfort/agr-climate-drawer.ts';
import '../../src/components/comfort/agr-comfort.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import type { DrawerRequest } from '../../src/components/shell/overlay-types.ts';
import { CLIMATE_FEATURE, FAN_FEATURE } from '../../src/ha/features.ts';
import { settle } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { testEntity } from '../helpers/fake-store.ts';
import { configFrom, fakeServices } from '../helpers/services.ts';
import { deepText, mountElement, SERVICE_MISSING, servicesMetaStore } from './support.ts';

const CLIMATE = 'climate.demo_bedroom';
const FAN = 'fan.demo_purifier';

type SectionElement = LitElement & { services: DashboardServices; request?: DrawerRequest };

const states = [
  testEntity(CLIMATE, 'cool', {
    current_temperature: 74,
    temperature: 72,
    min_temp: 60,
    max_temp: 86,
    hvac_modes: ['off', 'cool'],
    supported_features: CLIMATE_FEATURE.TARGET_TEMPERATURE,
  }),
  testEntity(FAN, 'on', { supported_features: FAN_FEATURE.TURN_ON | FAN_FEATURE.TURN_OFF }),
];

describe('comfort control meta subscription', () => {
  it.each(['agr-comfort', 'agr-climate-drawer'])('%s re-renders on a services change alone', async (tag) => {
    const config = configFrom({ climate: [CLIMATE], air: [FAN] });
    const meta = servicesMetaStore(config, states);
    const gateway = new FakeGateway();
    const element = await mountElement<SectionElement>(tag, (section) => {
      section.services = fakeServices({ config, store: meta.store, gateway });
      if (tag === 'agr-climate-drawer') section.request = { id: 'climate' };
    });
    const root = element.shadowRoot as ShadowRoot;
    expect(deepText(root)).not.toContain(SERVICE_MISSING.message);

    gateway.availability = SERVICE_MISSING;
    await settle();
    // Nothing has notified the section yet, so it still shows what it last evaluated.
    expect(deepText(root)).not.toContain(SERVICE_MISSING.message);

    meta.pushServices();
    await settle();
    expect(deepText(root)).toContain(SERVICE_MISSING.message);
    expect(gateway.calls).toEqual([]);
  });
});
