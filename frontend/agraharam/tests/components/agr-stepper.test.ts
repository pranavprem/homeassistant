import { describe, expect, it, vi } from 'vitest';
import { AgrStepper } from '../../src/components/primitives/agr-stepper.ts';
import type { DraftState } from '../../src/ha/actions/action-controller.ts';
import type { Availability } from '../../src/ha/actions/types.ts';

const ENABLED: Availability = { enabled: true, confirm: false };

async function mountStepper(configure: (stepper: AgrStepper) => void = () => undefined) {
  const stepper = document.createElement('agr-stepper') as AgrStepper;
  stepper.label = 'Target temperature';
  stepper.focusKey = 'climate:0:target';
  stepper.value = 22.3;
  stepper.min = 7.2;
  stepper.max = 30;
  stepper.step = 0.5;
  stepper.unit = '°';
  stepper.availability = ENABLED;
  configure(stepper);
  document.body.append(stepper);
  await stepper.updateComplete;
  const root = stepper.shadowRoot as ShadowRoot;
  const drafts = vi.fn();
  stepper.addEventListener('agr-draft', drafts);
  const [down, up] = [...root.querySelectorAll('button')];
  if (!down || !up) throw new Error('missing buttons');
  return { stepper, root, drafts, down, up };
}

function draftValues(drafts: ReturnType<typeof vi.fn>): number[] {
  return drafts.mock.calls.map(([event]) => (event as CustomEvent<{ value: number }>).detail.value);
}

describe('agr-stepper (§5.5, §7.2)', () => {
  it('emits one agr-draft per tap with stepValue from the observed value, snapping off-grid values', async () => {
    const { up, down, drafts } = await mountStepper();
    up.click();
    down.click();
    expect(draftValues(drafts)).toEqual([22.5, 22]);
  });

  it('steps from the draft value while drafting or held', async () => {
    const draft: DraftState = { phase: 'drafting', value: 24 };
    const { up, drafts } = await mountStepper((stepper) => {
      stepper.draft = draft;
    });
    up.click();
    expect(draftValues(drafts)).toEqual([24.5]);
  });

  it('owns no timers', async () => {
    vi.useFakeTimers();
    const { up } = await mountStepper();
    up.click();
    up.click();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders "Not sent" with the observed value', async () => {
    const { root } = await mountStepper((stepper) => {
      stepper.draft = { phase: 'not-sent', value: 25, reason: 'disconnected' };
    });
    expect(root.querySelector('.value')?.textContent).toBe('22.3°');
    expect(root.getElementById('status')?.textContent).toBe('Not sent');
  });

  it('uses aria-disabled (never native disabled) with the reason in its own shadow root', async () => {
    const disabled: Availability = { enabled: false, reason: 'state-unknown', message: 'Bedroom has not reported.' };
    const { root, up, down, drafts } = await mountStepper((stepper) => {
      stepper.availability = disabled;
    });
    for (const button of [up, down]) {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.hasAttribute('disabled')).toBe(false);
      expect(root.getElementById(button.getAttribute('aria-describedby')?.split(' ')[0] ?? '')?.textContent).toBe(
        disabled.message,
      );
      button.click();
    }
    expect(drafts).not.toHaveBeenCalled();
  });

  it('hides the reason only visually with reason-display="hidden"; both buttons still describe it', async () => {
    const paused: Availability = { enabled: false, reason: 'disconnected', message: 'Paused while disconnected.' };
    const { root, down, up } = await mountStepper((stepper) => {
      stepper.availability = paused;
      stepper.reasonDisplay = 'hidden';
    });
    const reason = root.getElementById('reason');
    expect(reason?.classList.contains('visually-hidden')).toBe(true);
    expect(reason?.textContent).toBe('Paused while disconnected.');
    for (const button of [down, up]) expect(button.getAttribute('aria-describedby')).toContain('reason');
  });

  it('does nothing for an unknown observed value, and disables the direction at a bound', async () => {
    const unknown = await mountStepper((stepper) => {
      stepper.value = null;
    });
    unknown.up.click();
    expect(unknown.drafts).not.toHaveBeenCalled();
    expect(unknown.root.querySelector('.value')?.textContent).toBe('—');
    const atMax = await mountStepper((stepper) => {
      stepper.value = 30;
    });
    atMax.up.click();
    expect(atMax.drafts).not.toHaveBeenCalled();
    expect(atMax.up.getAttribute('aria-disabled')).toBe('true');
    expect(atMax.root.getElementById('up-bound')?.textContent).toBe('Already at the highest setting.');
    atMax.down.click();
    expect(draftValues(atMax.drafts)).toEqual([29.5]);
  });

  it('names each button and labels the group in its own shadow root', async () => {
    const { root, up } = await mountStepper();
    const group = root.querySelector('[role="group"]');
    expect(root.getElementById(group?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Target temperature');
    expect(up.textContent?.replace(/\s+/g, ' ').trim()).toBe('Increase Target temperature');
    expect(up.dataset['focusKey']).toBe('climate:0:target:up');
  });
});
