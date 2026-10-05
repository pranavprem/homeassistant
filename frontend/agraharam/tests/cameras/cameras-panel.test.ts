/**
 * The Cameras section and the "All cameras" drawer (§5.3, §6.2.1, §12.1 row 2): budgeted tiles, the private pill,
 * the overflow entry, render isolation from unrelated entities, and text-only rendering of names.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/cameras/agr-cameras.ts';
import '../../src/components/cameras/agr-cameras-drawer.ts';
import type { AgrCameraTile } from '../../src/components/cameras/agr-camera-tile.ts';
import type { AgrCameras } from '../../src/components/cameras/agr-cameras.ts';
import type { AgrCamerasDrawer } from '../../src/components/cameras/agr-cameras-drawer.ts';
import type { AgrPanel } from '../../src/components/primitives/agr-panel.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import type { OpenDrawerDetail } from '../../src/components/shell/overlay-types.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import { deepQueryAll, settle } from '../helpers/dom.ts';
import { setIntersecting } from '../helpers/observers.ts';
import { FakeHass, fetchWithAuthCalls, hassRuntime, type HassRuntime } from './camera-harness.ts';

let runtime: HassRuntime | undefined;

afterEach(() => {
  runtime?.stop();
  runtime?.fake.dispose();
  runtime = undefined;
});

function startRuntime(scenario: 'normal' | 'dense' | 'degraded', input = demoCardInput(scenario)): HassRuntime {
  runtime = hassRuntime(new FakeHass(scenario, { latencyMs: [0, 0] }), input);
  return runtime;
}

async function mountSection(services: DashboardServices): Promise<AgrCameras> {
  const section = document.createElement('agr-cameras');
  section.services = services;
  document.body.append(section);
  await settle();
  return section;
}

function tiles(root: ParentNode | null | undefined): AgrCameraTile[] {
  return [...(root?.querySelectorAll('agr-camera-tile') ?? [])];
}

function panel(section: AgrCameras): AgrPanel {
  return section.shadowRoot?.querySelector('agr-panel') as AgrPanel;
}

describe('agr-cameras (§6.2.1, §9.3)', () => {
  it('renders the four configured cameras with stable focus keys and the private pill', async () => {
    const section = await mountSection(startRuntime('normal').services);
    expect(panel(section).heading).toBe('Cameras');
    expect(panel(section).icon).toBe('video');
    expect(panel(section).pill).toEqual({ label: '1 private', tone: 'neutral' });
    const rendered = tiles(section.shadowRoot);
    expect(rendered.map((tile) => tile.vm?.name)).toEqual(['Front gate', 'Side path', 'Courtyard', 'Hall']);
    expect(rendered.map((tile) => tile.focusKey)).toEqual([0, 1, 2, 3].map((index) => `camera:${index}:live`));
    expect(section.shadowRoot?.querySelector('.all')).toBeNull();
  });

  it('beyond four cameras offers "All cameras (n)", which opens the cameras drawer', async () => {
    const section = await mountSection(startRuntime('dense').services);
    expect(tiles(section.shadowRoot)).toHaveLength(4);
    const button = section.shadowRoot?.querySelector<HTMLButtonElement>('button.all');
    expect(button?.textContent?.trim()).toBe('All cameras (8)');
    expect(button?.getAttribute('slot')).toBe('actions');
    expect(button?.getAttribute('data-focus-key')).toBe('cameras:all');
    const opened = vi.fn();
    document.body.addEventListener('agr-open-drawer', (event) =>
      opened((event as CustomEvent<OpenDrawerDetail>).detail),
    );
    button?.click();
    expect(opened).toHaveBeenCalledWith({ request: { id: 'cameras' }, trigger: button });
  });

  it('re-renders for its cameras but not for unrelated entities (§12.1 row 2)', async () => {
    const { fake, services } = startRuntime('normal');
    const section = await mountSection(services);
    const render = vi.spyOn(section as unknown as { render(): unknown }, 'render');
    fake.setState('light.demo_kitchen', 'on');
    fake.setState('weather.demo_home', 'rainy');
    await settle();
    expect(render).not.toHaveBeenCalled();
    fake.setState('camera.demo_front_gate', 'unavailable');
    await settle();
    expect(render).toHaveBeenCalledTimes(1);
    expect(tiles(section.shadowRoot)[0]?.vm?.gate).toEqual({ kind: 'offline', label: 'Offline' });
  });

  it('renders camera names as text, never markup (§12.1 row 11)', async () => {
    const input = demoCardInput('normal');
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const cameras = (input.cameras ?? []).map((camera, index) => (index === 0 ? { ...camera, name: payload } : camera));
    const section = await mountSection(startRuntime('normal', { ...input, cameras }).services);
    const first = tiles(section.shadowRoot)[0];
    await settle();
    expect(first?.shadowRoot?.textContent).toContain(payload);
    expect(deepQueryAll(section, 'img[onerror], script')).toEqual([]);
  });

  it('shows the loading frame before services arrive: a hidden 2×2 grid of 4:3 placeholder tiles', async () => {
    const section = document.createElement('agr-cameras');
    document.body.append(section);
    await section.updateComplete;
    expect(section.shadowRoot?.querySelectorAll('agr-panel .grid[aria-hidden="true"] .tile-ghost')).toHaveLength(4);
  });
});

describe('agr-cameras-drawer (§5.3)', () => {
  async function mountDrawer(services: DashboardServices): Promise<AgrCamerasDrawer> {
    const drawer = document.createElement('agr-cameras-drawer');
    drawer.services = services;
    drawer.request = { id: 'cameras' };
    document.body.append(drawer);
    await settle();
    return drawer;
  }

  it('lists every configured camera with a summary, inside agr-drawer', async () => {
    const drawer = await mountDrawer({ ...startRuntime('dense').services, mode: 'demo', theme: 'dark' });
    const shell = drawer.shadowRoot?.querySelector('agr-drawer');
    expect(shell?.heading).toBe('All cameras');
    expect(shell?.demo).toBe(true);
    expect(shell?.theme).toBe('dark');
    expect(tiles(drawer.shadowRoot)).toHaveLength(8);
    expect(drawer.shadowRoot?.querySelector('.summary')?.textContent).toBe('8 cameras, 1 private');
    expect(tiles(drawer.shadowRoot).map((tile) => tile.focusKey)[7]).toBe('cameras-drawer:7:live');
  });

  it('fetches only the tiles that are visible in the drawer', async () => {
    vi.useFakeTimers();
    const { fake, services } = startRuntime('dense');
    const drawer = await mountDrawer(services);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchWithAuthCalls(fake)).toEqual([]);
    const kitchen = tiles(drawer.shadowRoot).find((tile) => tile.vm?.name === 'Kitchen yard');
    if (kitchen === undefined) throw new Error('no tile');
    setIntersecting(kitchen, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchWithAuthCalls(fake)).toEqual(['/api/camera_proxy/camera.demo_kitchen_yard?width=160&height=120']);
  });

  it('survives incomplete services by listing nothing', async () => {
    const drawer = await mountDrawer({ mode: 'demo', theme: 'light' } as DashboardServices);
    expect(tiles(drawer.shadowRoot)).toEqual([]);
    expect(drawer.shadowRoot?.querySelector('agr-drawer')?.heading).toBe('All cameras');
  });
});
