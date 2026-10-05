/**
 * The forecast's single retry after invalid_entity_id (§9.2): the RUNNING or registry signal is latched until a slot
 * that failed on the entity uses it, so a failure that arrives after HA became RUNNING still gets its one attempt.
 */
import { describe, expect, it, vi } from 'vitest';
import { WEATHER_FEATURE } from '../../src/ha/features.ts';
import { ForecastController, type ForecastSource } from '../../src/ha/forecast-controller.ts';
import type { ForecastHandlers, HostReader } from '../../src/ha/host.ts';
import { createStatusBoard } from '../../src/ha/status-board.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { fakeReader } from '../helpers/services.ts';
import { ManualStore, TestHost } from '../today/controller-host.ts';

const WEATHER = entityId('weather.demo_home');
const INVALID_ENTITY = Object.freeze({ code: 'unknown', haCode: 'invalid_entity_id' } as const);

function setup() {
  const manual = new ManualStore(
    [WEATHER],
    [testEntity(WEATHER, 'sunny', { supported_features: WEATHER_FEATURE.FORECAST_DAILY })],
  );
  const subscriptions: { handlers: ForecastHandlers; unsubscribe: ReturnType<typeof vi.fn> }[] = [];
  const reader: HostReader = {
    ...fakeReader(manual.view, () => manual.phase()),
    subscribeForecast: (_id, _type, handlers) => {
      const unsubscribe = vi.fn();
      subscriptions.push({ handlers, unsubscribe });
      return unsubscribe;
    },
  };
  const source: ForecastSource = { reader, status: createStatusBoard(), weather: WEATHER };
  const host = new TestHost();
  const controller = new ForecastController(host, () => source);
  return { manual, subscriptions, host, controller };
}

describe('forecast retry latch (§9.2)', () => {
  it('an invalid_entity_id that arrives after HA became RUNNING still gets one new attempt', () => {
    const t = setup();
    t.manual.setHaState('STARTING');
    t.host.connect();
    expect(t.subscriptions).toHaveLength(1);
    t.manual.setHaState('RUNNING'); // the subscribe is still in flight: nothing has failed yet
    expect(t.subscriptions).toHaveLength(1);
    t.subscriptions[0]?.handlers.error(INVALID_ENTITY);
    expect(t.host.updateRequests).toBeGreaterThan(0);
    t.host.update(); // the render the error asked for
    expect(t.subscriptions).toHaveLength(2);
    expect(t.subscriptions[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(t.controller.snapshot().daily).toEqual({ kind: 'subscribing' });
  });

  it('the latch is spent by that attempt: a second failure is not retried without a new signal', () => {
    const t = setup();
    t.manual.setHaState('STARTING');
    t.host.connect();
    t.manual.setHaState('RUNNING');
    t.subscriptions[0]?.handlers.error(INVALID_ENTITY);
    t.host.update();
    t.subscriptions[1]?.handlers.error(INVALID_ENTITY);
    t.host.update();
    t.host.update();
    expect(t.subscriptions).toHaveLength(2);
    expect(t.controller.snapshot().daily).toEqual({ kind: 'error', reason: 'entity', haCode: 'invalid_entity_id' });
    t.manual.touchRegistry();
    expect(t.subscriptions).toHaveLength(3);
  });

  it('a latched signal is never spent on other errors', () => {
    const t = setup();
    t.manual.setHaState('STARTING');
    t.host.connect();
    t.manual.setHaState('RUNNING');
    t.subscriptions[0]?.handlers.error({ code: 'unknown', haCode: 'home_assistant_error' });
    t.host.update();
    expect(t.subscriptions).toHaveLength(1);
  });
});
