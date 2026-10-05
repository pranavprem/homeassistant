import { describe, expect, it } from 'vitest';
import { AgrValue } from '../../src/components/primitives/agr-value.ts';
import type { Display } from '../../src/ha/normalize.ts';

async function mountValue(display: Display): Promise<ShadowRoot> {
  const value = document.createElement('agr-value') as AgrValue;
  value.field = 'Range';
  value.display = display;
  document.body.append(value);
  await value.updateComplete;
  return value.shadowRoot as ShadowRoot;
}

function spokenText(root: ShadowRoot): string {
  return [...root.querySelectorAll(':not([aria-hidden="true"])')]
    .filter((element) => element.children.length === 0)
    .map((element) => element.textContent?.trim())
    .filter(Boolean)
    .join(' ');
}

describe('agr-value (§4.6, §16.10)', () => {
  it('renders a value with its field named by visually hidden text, not aria-label', async () => {
    const root = await mountValue({ kind: 'value', text: '210 mi', stale: false });
    expect(root.querySelector('.visually-hidden')?.textContent).toBe('Range');
    expect(root.querySelector('[aria-label]')).toBeNull();
    expect(spokenText(root)).toBe('Range 210 mi');
  });

  it('dims a stale value and says "last known"', async () => {
    const root = await mountValue({ kind: 'value', text: '210 mi', stale: true });
    expect(root.querySelector('.stale')?.textContent).toBe('210 mi');
    expect(spokenText(root)).toBe('Range 210 mi last known');
  });

  it('renders absent values as a hidden dash glyph plus the label, never 0', async () => {
    const root = await mountValue({ kind: 'absent', reason: 'unavailable', label: 'Unavailable' });
    expect(root.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
    expect(spokenText(root)).toBe('Range Unavailable');
    expect(root.textContent).not.toContain('0');
  });

  it('renders loading as a skeleton bar with assistive text only', async () => {
    const root = await mountValue({ kind: 'absent', reason: 'loading', label: 'Loading' });
    expect(root.querySelector('.skeleton[aria-hidden="true"]')).not.toBeNull();
    expect(spokenText(root)).toBe('Range Loading');
  });
});
