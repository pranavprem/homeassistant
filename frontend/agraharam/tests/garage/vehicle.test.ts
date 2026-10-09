import { describe, expect, it } from 'vitest';
import '../../src/components/garage/agr-vehicle.ts';
import type { AgrVehicle } from '../../src/components/garage/agr-vehicle.ts';
import { absentDisplay, valueDisplay } from '../../src/model/display.ts';
import type { VehicleVM } from '../../src/model/types.ts';

const CHARGING: VehicleVM = {
  name: 'Demo sedan',
  battery: valueDisplay('62%'),
  batteryPct: 62,
  range: valueDisplay('210 mi'),
  chargeLimitPct: 80,
  charger: {
    status: valueDisplay('Charging'),
    charging: true,
    power: valueDisplay('7.2 kW'),
    session: valueDisplay('12.4 kWh'),
  },
};

async function mountVehicle(vm: VehicleVM): Promise<ShadowRoot> {
  const vehicle = document.createElement('agr-vehicle') as AgrVehicle;
  vehicle.vm = vm;
  document.body.append(vehicle);
  await vehicle.updateComplete;
  return vehicle.shadowRoot as ShadowRoot;
}

function text(root: ShadowRoot): string {
  return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('agr-vehicle (read-only telemetry)', () => {
  it('renders the selected Model 3 artwork while keeping the generic default', async () => {
    const selected = await mountVehicle({ ...CHARGING, model: 'tesla-model-3' });
    expect(selected.querySelector('svg[data-model="tesla-model-3"]')).not.toBeNull();
    const legacy = await mountVehicle(CHARGING);
    expect(legacy.querySelector('svg')?.hasAttribute('data-model')).toBe(false);
  });

  it('shows name, battery, range, the charge limit and the charger line', async () => {
    const root = await mountVehicle(CHARGING);
    const content = text(root);
    for (const part of ['Demo sedan', '62%', '210 mi', 'Limit 80%', 'Charging', '7.2 kW', '12.4 kWh this session']) {
      expect(content).toContain(part);
    }
  });

  it('draws the fill at the battery level and the limit as a tick', async () => {
    const root = await mountVehicle(CHARGING);
    const fill = root.querySelector('.fill') as HTMLElement;
    const tick = root.querySelector('.tick') as HTMLElement;
    expect(fill.style.inlineSize).toBe('62%');
    expect(tick.style.insetInlineStart).toBe('80%');
    expect(root.querySelector('.track')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws an empty hatched track, never a 0% fill, when the battery is absent', async () => {
    const root = await mountVehicle({ ...CHARGING, battery: absentDisplay('no-data'), batteryPct: null });
    expect(root.querySelector('.track')?.hasAttribute('data-absent')).toBe(true);
    expect(root.querySelector('.fill')).toBeNull();
    expect(text(root)).toContain('Battery unknown');
    expect(text(root)).not.toMatch(/(?:^|\D)0%/);
  });

  it('names absent readings for assistive technology and marks stale ones', async () => {
    const root = await mountVehicle({
      ...CHARGING,
      battery: valueDisplay('62%', true),
      range: absentDisplay('unavailable'),
    });
    expect(text(root)).toContain('Battery 62% last known');
    // An absent level is one short muted phrase, not a dash beside a bare status word (§16.14).
    expect(text(root)).toContain('Range unavailable');
    expect(text(root)).not.toContain('—');
  });

  it('words each absent level in its own terms, so the states stay distinct', async () => {
    for (const [reason, phrase] of [
      ['unavailable', 'Range unavailable'],
      ['missing-binding', 'Range not found'],
      ['disconnected', 'Range offline'],
      ['unknown', 'Range unknown'],
    ] as const) {
      const root = await mountVehicle({ ...CHARGING, range: absentDisplay(reason) });
      expect(text(root), reason).toContain(phrase);
    }
  });

  it('labels an absent charger status as the charger, not the car', async () => {
    const root = await mountVehicle({
      ...CHARGING,
      charger: { status: absentDisplay('unavailable'), charging: false },
    });
    expect(text(root)).toContain('Charger Unavailable');
  });

  it('omits the tick and limit without a configured limit, and the charger line without a charger', async () => {
    const { chargeLimitPct: _limit, charger: _charger, ...bare } = CHARGING;
    const root = await mountVehicle(bare);
    expect(root.querySelector('.tick')).toBeNull();
    expect(text(root)).not.toContain('Limit');
    expect(root.querySelector('.charger')).toBeNull();
  });

  it('is read-only: it renders no controls, and the art is decorative line art', async () => {
    const root = await mountVehicle(CHARGING);
    expect(root.querySelectorAll('button, input, a, [tabindex]')).toHaveLength(0);
    const art = root.querySelector('svg.vehicle-art');
    expect(art?.getAttribute('aria-hidden')).toBe('true');
    expect(art?.querySelector('image')).toBeNull();
  });

  it('escapes the vehicle name', async () => {
    const root = await mountVehicle({ ...CHARGING, name: '<script>alert(1)</script>' });
    expect(text(root)).toContain('<script>alert(1)</script>');
    expect(root.querySelector('script')).toBeNull();
  });
});
