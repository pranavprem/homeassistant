import { describe, expect, it } from 'vitest';
import '../../src/agraharam.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import { DRAWER_TAGS, type DrawerElement } from '../../src/components/shell/overlay-types.ts';

const SECTION_TAGS = [
  'agr-today',
  'agr-comfort',
  'agr-home',
  'agr-cameras',
  'agr-garage',
  'agr-media',
  'agr-upcoming',
  'agr-health',
  'agr-sky',
];

function demoServices(theme: DashboardServices['theme']): DashboardServices {
  return { mode: 'demo', theme } as DashboardServices;
}

describe('the registered elements and their loading frames', () => {
  it('registers every drawer the overlay host can mount, plus the camera dialog', () => {
    for (const tag of [...Object.values(DRAWER_TAGS), 'agr-camera-dialog']) {
      expect(customElements.get(tag), tag).toBeDefined();
    }
  });

  it.each(SECTION_TAGS)('%s renders a labelled panel with a hidden loading placeholder', async (tag) => {
    const section = document.createElement(tag) as HTMLElement & { updateComplete: Promise<boolean> };
    document.body.append(section);
    await section.updateComplete;
    const panel = section.shadowRoot?.querySelector('agr-panel');
    expect(panel?.getAttribute('heading-id')).toBe(`${tag}-heading`);
    // A skeleton bar, or ghost blocks shaped like the panel's content inside a hidden wrapper.
    const placeholder = section.shadowRoot?.querySelector('.skeleton, .ghost');
    expect(placeholder?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('agr-header renders the card wordmark as the h1, with the decorative kolam mark', async () => {
    const header = document.createElement('agr-header');
    header.services = { config: { title: 'Preview home' } } as DashboardServices;
    document.body.append(header);
    await header.updateComplete;
    expect(header.shadowRoot?.querySelector('h1')?.textContent).toBe('Preview home');
    expect(header.shadowRoot?.querySelector('.mark')?.getAttribute('aria-hidden')).toBe('true');
  });

  it.each(SECTION_TAGS)('%s stretches its panel to fill a stretched column slot', async (tag) => {
    const section = document.createElement(tag) as HTMLElement & { updateComplete: Promise<boolean> };
    document.body.append(section);
    await section.updateComplete;
    const styles = (section.constructor as unknown as { elementStyles: { cssText: string }[] }).elementStyles;
    expect(styles.some((style) => style.cssText.includes('flex: 1 1 auto'))).toBe(true);
  });

  it('the household drawer is always a bottom sheet', async () => {
    const drawer = document.createElement('agr-household-drawer') as DrawerElement & {
      updateComplete: Promise<boolean>;
    };
    drawer.services = demoServices('light');
    document.body.append(drawer);
    await drawer.updateComplete;
    expect(drawer.shadowRoot?.querySelector('agr-drawer')?.sheet).toBe('bottom');
  });

  it.each(Object.values(DRAWER_TAGS))('%s renders inside agr-drawer with the demo flag and theme', async (tag) => {
    const drawer = document.createElement(tag) as DrawerElement & { updateComplete: Promise<boolean> };
    drawer.services = demoServices('dark');
    document.body.append(drawer);
    await drawer.updateComplete;
    const shell = drawer.shadowRoot?.querySelector('agr-drawer');
    expect(shell?.heading).not.toBe('');
    expect(shell?.demo).toBe(true);
    expect(shell?.theme).toBe('dark');
  });
});
