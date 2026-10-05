/**
 * ACCEPTANCE check 2 (§12.1 row 2): configured entity updates propagate; unrelated changes do not re-render other
 * sections and never rebuild a camera stream.
 *
 * Re-renders are observed with a spy on each mounted section's render method; the stream check stubs HA's card
 * helpers, because FakeHass has none (live view would otherwise use the snapshot fallback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advance,
  control,
  fetchesFor,
  mountLive,
  overlays,
  renderedText,
  revealAll,
  section,
  settle,
  shadowOf,
  useAcceptanceTimers,
  type LiveCard,
} from './support.ts';

const WEATHER = 'weather.demo_home';
const READING_LAMP = 'light.demo_reading_lamp';
const COURTYARD_LANTERN = 'light.demo_courtyard_lantern';
const FRONT_GATE = 'camera.demo_front_gate';
const UNBOUND_SENSOR = 'sensor.demo_not_on_this_dashboard';
const UNRELATED_UPDATES = 50;

type Renderable = { render(): unknown };

function renderSpy(card: LiveCard, tag: string) {
  return vi.spyOn(section(card, tag) as unknown as Renderable, 'render');
}

beforeEach(() => {
  useAcceptanceTimers();
});

afterEach(() => {
  delete window.loadCardHelpers;
});

describe('configured updates propagate to the section that shows them', () => {
  it('a weather temperature change re-renders Today with the new value', async () => {
    const card = await mountLive();
    const today = renderSpy(card, 'agr-today');
    card.fake.setState(WEATHER, 'sunny', { temperature: 81 });
    await settle();
    expect(today).toHaveBeenCalled();
    expect(renderedText(shadowOf(section(card, 'agr-today')))).toContain('81');
  });

  it('a room light turning on updates that room chip', async () => {
    const card = await mountLive();
    const home = shadowOf(section(card, 'agr-home'));
    expect(renderedText(control(home, 'room:1:open'))).toContain('Off');
    card.fake.setState(READING_LAMP, 'on', { brightness: 200 });
    await settle();
    expect(renderedText(control(home, 'room:1:open'))).not.toContain('Off');
    expect(renderedText(control(home, 'room:1:toggle'))).toContain('Turn off Reading room lights');
  });
});

describe('unrelated changes stay where they belong', () => {
  it('a light change does not re-render Cameras, Today or Garage', async () => {
    const card = await mountLive();
    const cameras = renderSpy(card, 'agr-cameras');
    const today = renderSpy(card, 'agr-today');
    const garage = renderSpy(card, 'agr-garage');
    card.fake.setState(COURTYARD_LANTERN, 'off');
    await settle();
    expect(cameras).not.toHaveBeenCalled();
    expect(today).not.toHaveBeenCalled();
    expect(garage).not.toHaveBeenCalled();
  });

  it('a change to an entity no section binds, and identity-only hass pushes, re-render nothing', async () => {
    const card = await mountLive();
    const tags = ['agr-header', 'agr-today', 'agr-comfort', 'agr-home', 'agr-cameras', 'agr-garage', 'agr-media'];
    const spies = tags.map((tag) => renderSpy(card, tag));
    for (let push = 0; push < 10; push += 1) card.fake.pushIdentityOnly();
    card.fake.setState(UNBOUND_SENSOR, 'anything'); // not in the scenario: FakeHass ignores it, no push at all
    await settle();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('50 light changes neither refetch camera stills nor replace the shown picture', async () => {
    const card = await mountLive();
    revealAll();
    await advance(500); // first stills land
    const fetchesBefore = fetchesFor(card.fake, FRONT_GATE).length;
    const tile = control(shadowOf(section(card, 'agr-cameras')), 'camera:0:live');
    const picture = tile.querySelector('img');
    expect(picture).not.toBeNull();
    for (let push = 0; push < UNRELATED_UPDATES; push += 1) {
      card.fake.setState(COURTYARD_LANTERN, push % 2 === 0 ? 'off' : 'on');
    }
    await settle();
    expect(fetchesFor(card.fake, FRONT_GATE)).toHaveLength(fetchesBefore);
    expect(control(shadowOf(section(card, 'agr-cameras')), 'camera:0:live').querySelector('img')).toBe(picture);
  });

  it("a camera's rotating access_token alone neither refetches nor resets its tile", async () => {
    const card = await mountLive();
    revealAll();
    await advance(500);
    const fetchesBefore = fetchesFor(card.fake, FRONT_GATE).length;
    for (let rotation = 0; rotation < 5; rotation += 1) {
      card.fake.setState(FRONT_GATE, 'idle', { access_token: `rotated-${rotation}` });
    }
    await settle();
    expect(fetchesFor(card.fake, FRONT_GATE)).toHaveLength(fetchesBefore);
  });
});

describe('an open live stream is never rebuilt by unrelated updates', () => {
  it('50 unrelated updates keep the same embedded card, connected, receiving the latest hass', async () => {
    const created: (HTMLElement & { hass?: unknown })[] = [];
    const createCardElement = vi.fn(() => {
      const element = document.createElement('div') as HTMLElement & { hass?: unknown };
      created.push(element);
      return element;
    });
    window.loadCardHelpers = vi.fn(() => Promise.resolve({ createCardElement }));
    const card = await mountLive();
    revealAll();
    await advance(500);
    control(shadowOf(section(card, 'agr-cameras')), 'camera:0:live').click();
    await advance(100);
    expect(overlays(card).querySelector('agr-camera-dialog')).not.toBeNull();
    expect(createCardElement).toHaveBeenCalledTimes(1);

    for (let push = 0; push < UNRELATED_UPDATES; push += 1) {
      card.fake.setState(COURTYARD_LANTERN, push % 2 === 0 ? 'off' : 'on');
      card.fake.setState(WEATHER, 'sunny', { temperature: 60 + (push % 9) });
    }
    await advance(1_000);

    expect(createCardElement).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0]?.isConnected).toBe(true);
    expect(created[0]?.hass).toBe(card.fake.hass);
  });
});
