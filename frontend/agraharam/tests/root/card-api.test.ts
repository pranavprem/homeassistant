import { describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { AgraharamDashboard } from '../../src/agraharam-dashboard.ts';
import '../../src/agraharam.ts';

const CARD_TYPE = 'agraharam-dashboard';

function agraharamEntries(): readonly CustomCardEntry[] {
  return (window.customCards ?? []).filter((card) => card.type === CARD_TYPE);
}

describe('agraharam-dashboard card API (§14 acceptance)', () => {
  it('registers the card with the bundle version', () => {
    expect(customElements.get(CARD_TYPE)).toBe(AgraharamDashboard);
    expect(AgraharamDashboard.version).toBe(packageJson.version);
  });

  it('offers demo mode as the stub config and fills a panel', () => {
    const card = new AgraharamDashboard();
    expect(AgraharamDashboard.getStubConfig()).toEqual({ demo: true });
    expect(card.getCardSize()).toBe(12);
    expect(card.getGridOptions()).toEqual({ columns: 'full' });
  });

  it.each([null, undefined, 'demo', 42, ['demo']])('throws only for a non-mapping config (%j)', (config) => {
    expect(() => new AgraharamDashboard().setConfig(config)).toThrow(
      'Agraharam: card configuration must be a mapping.',
    );
  });

  it('accepts a mapping without throwing (issues render in the card, D4)', () => {
    expect(() => new AgraharamDashboard().setConfig({ type: 'custom:agraharam-dashboard' })).not.toThrow();
  });

  it('lists the card in the picker once, without a live preview', () => {
    expect(agraharamEntries()).toEqual([expect.objectContaining({ name: 'Agraharam', preview: false })]);
  });

  it('tolerates the same bundle being loaded twice', async () => {
    vi.resetModules();
    await import('../../src/agraharam.ts');
    expect(customElements.get(CARD_TYPE)).toBe(AgraharamDashboard);
    expect(agraharamEntries()).toHaveLength(1);
  });
});
