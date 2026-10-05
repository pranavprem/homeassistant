import { describe, expect, it, vi } from 'vitest';
import { AgrSlider } from '../../src/components/primitives/agr-slider.ts';
import type { Availability } from '../../src/ha/actions/types.ts';

const ENABLED: Availability = { enabled: true, confirm: false };

async function mountSlider(configure: (slider: AgrSlider) => void = () => undefined) {
  const slider = document.createElement('agr-slider') as AgrSlider;
  slider.label = 'Volume';
  slider.focusKey = 'media:volume';
  slider.value = 35;
  slider.valueText = (value) => `Volume ${value} percent`;
  slider.availability = ENABLED;
  configure(slider);
  document.body.append(slider);
  await slider.updateComplete;
  const root = slider.shadowRoot as ShadowRoot;
  const input = root.querySelector('input') as HTMLInputElement;
  const drafts = vi.fn();
  slider.addEventListener('agr-draft', drafts);
  return { slider, root, input, drafts };
}

describe('agr-slider (§5.5, §7.2)', () => {
  it('is a labelled native range input with aria-valuetext in units', async () => {
    const { root, input } = await mountSlider();
    expect(input.type).toBe('range');
    expect(root.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('Volume');
    expect(input.getAttribute('aria-valuetext')).toBe('Volume 35 percent');
    expect(input.dataset['focusKey']).toBe('media:volume');
  });

  it('hides its label, status and reason only visually when asked, keeping every aria-describedby target', async () => {
    const paused: Availability = { enabled: false, reason: 'controls-off', message: 'Controls are off.' };
    const { root, input } = await mountSlider((slider) => {
      slider.availability = paused;
      slider.draft = { phase: 'not-sent', value: 40, reason: 'config' };
      slider.labelDisplay = 'hidden';
      slider.statusDisplay = 'hidden';
      slider.reasonDisplay = 'hidden';
    });
    for (const selector of ['label', '#status', '#reason']) {
      expect(root.querySelector(selector)?.classList.contains('visually-hidden'), selector).toBe(true);
    }
    expect(input.getAttribute('aria-describedby')).toBe('status reason');
    expect(root.getElementById('reason')?.textContent).toBe('Controls are off.');
  });

  it('shows the reason as visible meta text by default', async () => {
    const paused: Availability = { enabled: false, reason: 'controls-off', message: 'Controls are off.' };
    const { root } = await mountSlider((slider) => {
      slider.availability = paused;
    });
    expect(root.getElementById('reason')?.className).toBe('t-meta');
    expect(root.querySelector('label')?.className).toBe('t-meta');
  });

  it('emits agr-draft on change only, never on input', async () => {
    const { slider, input, drafts } = await mountSlider();
    input.value = '50';
    input.dispatchEvent(new Event('input'));
    await slider.updateComplete;
    expect(input.getAttribute('aria-valuetext')).toBe('Volume 50 percent');
    expect(drafts).not.toHaveBeenCalled();
    input.dispatchEvent(new Event('change'));
    expect(drafts).toHaveBeenCalledTimes(1);
    expect((drafts.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ value: 50 });
  });

  it('shows the draft value while drafting and "Not sent" with the observed value after a discard', async () => {
    const drafting = await mountSlider((slider) => {
      slider.draft = { phase: 'drafting', value: 60 };
    });
    expect(drafting.input.value).toBe('60');
    expect(drafting.root.getElementById('status')?.textContent).toBe('Setting Volume 60 percent');
    const discarded = await mountSlider((slider) => {
      slider.draft = { phase: 'not-sent', value: 60, reason: 'preview' };
    });
    expect(discarded.input.value).toBe('35');
    expect(discarded.root.getElementById('status')?.textContent).toBe('Not sent');
  });

  it('disables the range input natively with the reason next to it, and never emits', async () => {
    const disabled: Availability = { enabled: false, reason: 'controls-off', message: 'Controls are turned off.' };
    const { root, input, drafts } = await mountSlider((slider) => {
      slider.availability = disabled;
    });
    expect(input.disabled).toBe(true);
    expect(root.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toBe(disabled.message);
    input.dispatchEvent(new Event('change'));
    expect(drafts).not.toHaveBeenCalled();
  });

  it('renders a null value as no data, never as 0 percent', async () => {
    const { input } = await mountSlider((slider) => {
      slider.value = null;
    });
    expect(input.getAttribute('aria-valuetext')).toBe('No data');
    expect(input.hasAttribute('data-empty')).toBe(true);
  });

  it('reflects its tone so color keeps its meaning: olive by default, plum only for media, brass for light', async () => {
    const plain = await mountSlider();
    expect(plain.slider.getAttribute('tone')).toBe('device');
    const media = await mountSlider((slider) => {
      slider.tone = 'media';
    });
    expect(media.slider.getAttribute('tone')).toBe('media');
    const light = await mountSlider((slider) => {
      slider.tone = 'light';
    });
    expect(light.slider.getAttribute('tone')).toBe('light');
  });
});
