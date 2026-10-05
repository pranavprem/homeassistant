import { describe, expect, it } from 'vitest';
import { AgrPanel } from '../../src/components/primitives/agr-panel.ts';

async function mountPanel(configure: (panel: AgrPanel) => void): Promise<ShadowRoot> {
  const panel = document.createElement('agr-panel');
  configure(panel);
  document.body.append(panel);
  await panel.updateComplete;
  if (panel.shadowRoot === null) throw new Error('agr-panel has no shadow root');
  return panel.shadowRoot;
}

describe('agr-panel', () => {
  it('labels its section by an h2 inside the same shadow root', async () => {
    const root = await mountPanel((panel) => {
      panel.heading = 'Today';
      panel.headingId = 'agr-today-heading';
    });
    const section = root.querySelector('section');
    const labelId = section?.getAttribute('aria-labelledby');
    expect(labelId).toBe('agr-today-heading');
    const heading = root.getElementById(labelId ?? '');
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent).toBe('Today');
    expect(heading?.getAttribute('tabindex')).toBe('-1');
  });

  it('renders the optional icon as decorative SVG and the pill as text', async () => {
    const root = await mountPanel((panel) => {
      panel.heading = 'Climate';
      panel.headingId = 'agr-comfort-heading';
      panel.icon = 'thermometer';
      panel.pill = { label: 'Cooling', tone: 'ok' };
    });
    expect(root.querySelector('header svg')?.getAttribute('aria-hidden')).toBe('true');
    const pill = root.querySelector('.pill');
    expect(pill?.textContent).toBe('Cooling');
    expect(pill?.getAttribute('data-tone')).toBe('ok');
  });

  it('draws a pill glyph as decorative SVG before the pill text', async () => {
    const root = await mountPanel((panel) => {
      panel.pill = { label: 'Offline', tone: 'muted', icon: 'wifi-off' };
    });
    const pill = root.querySelector('.pill');
    expect(pill?.textContent?.trim()).toBe('Offline');
    expect(pill?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the slotted content in one stack, the natural size the root measures (§16.14)', async () => {
    const root = await mountPanel(() => undefined);
    expect(root.querySelector('.content > .stack > slot:not([name])')).not.toBeNull();
  });

  it('reflects its surface for styling', async () => {
    const root = await mountPanel((panel) => {
      panel.surface = 'hero';
    });
    expect((root.host as AgrPanel).getAttribute('surface')).toBe('hero');
  });
});
