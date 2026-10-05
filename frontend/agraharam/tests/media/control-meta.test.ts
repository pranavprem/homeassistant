/** The Media sections subscribe to CONTROL_META (§4.5): a services change alone (no entity change) re-renders the Media
 *  panel and the media drawer, so transport HA stops offering shows service-missing at once. */
import type { LitElement } from 'lit';
import { describe, expect, it } from 'vitest';
import '../../src/components/media/agr-media-drawer.ts';
import '../../src/components/media/agr-media.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import type { DrawerRequest } from '../../src/components/shell/overlay-types.ts';
import { MEDIA_PLAYER_FEATURE as MEDIA } from '../../src/ha/features.ts';
import { settle } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { configFrom, fakeServices } from '../helpers/services.ts';
import { deepText, mountElement, SERVICE_MISSING, servicesMetaStore } from '../comfort/support.ts';

const PLAYER = 'media_player.demo_studio';

type SectionElement = LitElement & { services: DashboardServices; request?: DrawerRequest };

const states = [
  testEntity(PLAYER, 'playing', {
    media_title: 'Evening raga',
    volume_level: 0.4,
    supported_features: MEDIA.PAUSE | MEDIA.PLAY | MEDIA.VOLUME_SET,
  }),
];

describe('media control meta subscription', () => {
  it.each(['agr-media', 'agr-media-drawer'])('%s re-renders on a services change alone', async (tag) => {
    const config = configFrom({ media: [{ entity: PLAYER, name: 'Studio' }] });
    const meta = servicesMetaStore(config, states);
    const gateway = new FakeGateway();
    const element = await mountElement<SectionElement>(tag, (section) => {
      section.services = fakeServices({ config, store: meta.store, gateway });
      if (tag === 'agr-media-drawer') section.request = { id: 'media', entity: entityId(PLAYER) };
    });
    const root = element.shadowRoot as ShadowRoot;
    expect(deepText(root)).not.toContain(SERVICE_MISSING.message);

    gateway.availability = SERVICE_MISSING;
    await settle();
    expect(deepText(root)).not.toContain(SERVICE_MISSING.message);

    meta.pushServices();
    await settle();
    expect(deepText(root)).toContain(SERVICE_MISSING.message);
    expect(gateway.calls).toEqual([]);
  });
});
