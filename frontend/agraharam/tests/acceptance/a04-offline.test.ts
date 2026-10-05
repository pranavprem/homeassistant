/**
 * ACCEPTANCE check 4 (§12.1 row 4): offline and unauthorized controls are disabled, and no queued action replays on
 * reconnect.
 *
 * Every button on the card is pressed while disconnected. A button that opens something (a drawer or dialog) is
 * navigation and stays usable; every other button must be aria-disabled (so it stays focusable and announces why)
 * and press without effect. Nothing may be sent then, during the post-reconnect resync barrier, or afterwards.
 * Real Enter and Space on a disabled button are covered by e2e/keyboard.spec.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgrOverlayHost } from '../../src/components/shell/agr-overlay-host.ts';
import { deepActive } from '../helpers/dom.ts';
import {
  advance,
  buttons,
  control,
  deepQueryAll,
  describedBy,
  mountLive,
  renderedText,
  section,
  serviceCalls,
  settle,
  shadowOf,
  topOverlay,
  useAcceptanceTimers,
  writeCalls,
  type LiveCard,
} from './support.ts';

const PAUSED = 'Paused while Home Assistant is disconnected.';
const RESYNCING = 'Paused until Home Assistant sends current states.';
const COLUMN_SECTIONS = [
  'agr-today',
  'agr-comfort',
  'agr-home',
  'agr-cameras',
  'agr-garage',
  'agr-media',
  'agr-health',
];
const SNAPSHOT_DELAY_MS = 10_000;
const SLIDER_DEBOUNCE_MS = 400;
const STEPPER_DEBOUNCE_MS = 800;

beforeEach(() => {
  useAcceptanceTimers();
});

function closeOverlays(card: LiveCard): void {
  (card.root.querySelector('agr-overlay-host') as AgrOverlayHost).closeAll();
  card.root.querySelector<HTMLElement>('.frame')?.focus();
}

function label(button: HTMLButtonElement): string {
  return renderedText(button) || (button.getAttribute('data-focus-key') ?? 'unnamed button');
}

interface PressReport {
  readonly disabled: string[];
  readonly navigation: string[];
}

/**
 * Presses every button under `root` (re-querying after each press, because a press may re-render). A press that
 * mounts an overlay is navigation; anything else must be aria-disabled with `reason`, focusable, and inert.
 */
async function pressEverything(card: LiveCard, root: ParentNode, reason: string): Promise<PressReport> {
  const report: PressReport = { disabled: [], navigation: [] };
  for (const button of buttons(root)) {
    if (!button.isConnected) continue;
    const name = label(button);
    const disabled = button.getAttribute('aria-disabled') === 'true';
    button.focus();
    button.click();
    await settle();
    const opened = topOverlay(card) !== undefined;
    if (opened) {
      report.navigation.push(name);
      closeOverlays(card);
      await settle();
      continue;
    }
    expect(disabled, `"${name}" acted while disconnected`).toBe(true);
    expect(describedBy(button), `"${name}" has no reason`).toContain(reason);
    expect(button.disabled, `"${name}" uses native disabled and leaves the tab order`).toBe(false);
    expect(button.tabIndex, `"${name}" is not focusable`).toBeGreaterThanOrEqual(0);
    expect(deepActive(), `"${name}" did not take focus`).toBe(button);
    report.disabled.push(name);
  }
  return report;
}

/** Opens a drawer through its real trigger, then presses everything inside except Close and local view controls. */
async function pressInDrawer(card: LiveCard, trigger: HTMLElement, reason: string): Promise<string[]> {
  trigger.click();
  await settle();
  const drawer = topOverlay(card);
  if (drawer === undefined) throw new Error('the trigger opened no drawer');
  const disabled: string[] = [];
  for (const button of buttons(shadowOf(drawer))) {
    // Close and the media drawer's player picker are view controls, not actions (§5.3).
    if (button.classList.contains('close') || button.dataset['focusKey']?.startsWith('media-drawer:pick:')) continue;
    const name = label(button);
    expect(button.getAttribute('aria-disabled'), `"${name}" in the drawer is enabled while disconnected`).toBe('true');
    // The observed current option of a choice group keeps its own reason ("Current mode"): it never sends anyway.
    const expected = button.getAttribute('aria-pressed') === 'true' ? new RegExp(`${reason}|^Current `) : reason;
    expect(describedBy(button), `"${name}" in the drawer has no reason`).toMatch(expected);
    button.click();
    await settle();
    disabled.push(name);
  }
  for (const range of deepQueryAll<HTMLInputElement>(shadowOf(drawer), 'input[type="range"]')) {
    expect(range.disabled).toBe(true);
  }
  closeOverlays(card);
  await settle();
  return disabled;
}

function columnRoots(card: LiveCard): ShadowRoot[] {
  return COLUMN_SECTIONS.flatMap((tag) => {
    const element = card.root.querySelector(tag);
    return element === null ? [] : [shadowOf(element)];
  });
}

describe('while disconnected every action control is disabled with its reason, and nothing is sent', () => {
  it('every button in every panel: aria-disabled with the reason, focusable, inert; navigation still opens', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await advance(0);
    const disabled: string[] = [];
    const navigation: string[] = [];
    for (const root of columnRoots(card)) {
      const report = await pressEverything(card, root, PAUSED);
      disabled.push(...report.disabled);
      navigation.push(...report.navigation);
    }
    expect(disabled).toEqual(
      expect.arrayContaining(['Turn on Reading room lights', 'Open garage', 'Start Pebble', 'Pause', 'Next track']),
    );
    expect(navigation.length).toBeGreaterThan(0);
    await advance(60_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });

  it('inside the room, climate, media and security drawers every action is disabled with the reason', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await advance(0);
    const home = shadowOf(section(card, 'agr-home'));
    const room = await pressInDrawer(card, control(home, 'room:1:open'), PAUSED);
    const climate = await pressInDrawer(
      card,
      control(shadowOf(section(card, 'agr-comfort')), 'comfort:climate.demo_bedroom:open'),
      PAUSED,
    );
    const media = await pressInDrawer(card, control(shadowOf(section(card, 'agr-media')), 'media:players'), PAUSED);
    const header = shadowOf(section(card, 'agr-header'));
    const security = await pressInDrawer(card, control(header, 'header:security'), PAUSED);
    expect(room).toEqual(expect.arrayContaining(['All on', 'Turn on Reading lamp', 'Open']));
    expect(climate).toEqual(expect.arrayContaining(['Heat', 'Increase Target temperature']));
    expect(media).toEqual(expect.arrayContaining(['Demo Radio']));
    expect(security).toEqual(expect.arrayContaining(['Disarm & hold', 'Silence sound', 'Prepare garage departure']));
    await advance(60_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });
});

describe('the banner says it once: each panel shows an "Offline" pill instead of repeating the sentence', () => {
  it('while disconnected every column panel carries the pill and no visible paused notice', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await advance(0);
    for (const tag of [...COLUMN_SECTIONS, 'agr-upcoming']) {
      const root = shadowOf(section(card, tag));
      const panel = root.querySelector('agr-panel') as (HTMLElement & { pill?: unknown }) | null;
      expect(panel?.pill, `${tag} pill`).toEqual({ label: 'Offline', tone: 'muted', icon: 'wifi-off' });
      const notices = [...root.querySelectorAll('.notice, .reason, .paused')].map((element) => renderedText(element));
      expect(
        notices.filter((text) => text.includes(PAUSED)),
        `${tag} repeats the banner`,
      ).toEqual([]);
    }
    // The controls still carry the full sentence for assistive technology (checked button by button above).
    expect(describedBy(control(shadowOf(section(card, 'agr-garage')), 'garage:open'))).toContain(PAUSED);
  });
});

describe('the resync barrier keeps controls paused until current states arrive', () => {
  it('two-step reconnect: still paused (resync reason) and "Last known" before the snapshot; live after, 0 calls', async () => {
    const card = await mountLive();
    const home = shadowOf(section(card, 'agr-home'));
    const garage = shadowOf(section(card, 'agr-garage'));
    card.fake.disconnect();
    await advance(0);
    card.fake.reconnect({ snapshotDelayMs: SNAPSHOT_DELAY_MS });
    await advance(0);

    for (const focusKey of ['room:1:toggle', 'garage:open']) {
      const button = control(focusKey === 'garage:open' ? garage : home, focusKey);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(describedBy(button)).toContain(RESYNCING);
    }
    for (const root of columnRoots(card)) await pressEverything(card, root, RESYNCING);
    expect(renderedText(shadowOf(section(card, 'agr-header')))).toMatch(/Last known/);
    expect(renderedText(shadowOf(section(card, 'agr-header')))).toContain('Reconnecting');

    await advance(SNAPSHOT_DELAY_MS);
    expect(control(home, 'room:1:toggle').getAttribute('aria-disabled')).toBeNull();
    expect(control(garage, 'garage:open').getAttribute('aria-disabled')).toBeNull();
    expect(renderedText(shadowOf(section(card, 'agr-header')))).not.toMatch(/Last known/);
    await advance(60_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });
});

describe('nothing queued is replayed on reconnect', () => {
  it('a volume slider commit still debouncing when the connection drops is never sent, and shows "Not sent"', async () => {
    const card = await mountLive();
    const media = shadowOf(section(card, 'agr-media'));
    const slider = deepQueryAll<HTMLInputElement>(media, 'input[type="range"]')[0] as HTMLInputElement;
    slider.value = '60';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await advance(SLIDER_DEBOUNCE_MS / 2);
    card.fake.disconnect();
    await advance(SLIDER_DEBOUNCE_MS * 4);
    card.fake.reconnect({ snapshotDelayMs: 400 });
    await advance(5_000);
    expect(writeCalls(card.fake)).toEqual([]);
    expect(renderedText(media)).toContain('Not sent');
  });

  it('a stepper draft interrupted by a disconnect is never sent after reconnecting', async () => {
    const card = await mountLive();
    control(shadowOf(section(card, 'agr-comfort')), 'comfort:climate.demo_bedroom:open').click();
    await settle();
    const drawer = topOverlay(card) as Element;
    control(shadowOf(drawer), 'climate:climate.demo_bedroom:target:up').click();
    await advance(STEPPER_DEBOUNCE_MS / 2);
    card.fake.disconnect();
    await advance(STEPPER_DEBOUNCE_MS * 2);
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await advance(5_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });

  it('a press while disconnected sends nothing then or after reconnecting', async () => {
    const card = await mountLive();
    card.fake.disconnect();
    await advance(0);
    control(shadowOf(section(card, 'agr-home')), 'room:1:toggle').click();
    control(shadowOf(section(card, 'agr-garage')), 'garage:open').click();
    await advance(1_000);
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await advance(60_000);
    expect(writeCalls(card.fake)).toEqual([]);
  });

  it('a call in flight when the connection drops is not repeated after the reconnect', async () => {
    const card = await mountLive();
    control(shadowOf(section(card, 'agr-home')), 'room:1:toggle').click();
    await settle();
    expect(serviceCalls(card.fake)).toHaveLength(1);
    card.fake.disconnect();
    await advance(100);
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await advance(60_000);
    expect(serviceCalls(card.fake)).toHaveLength(1);
  });
});

describe('an unauthorized user sees the permission message and the control stays disabled', () => {
  it('restricted: the first tap is rejected as Unauthorized, the button then refuses further taps', async () => {
    const card = await mountLive({ scenario: 'restricted' });
    const home = shadowOf(section(card, 'agr-home'));
    control(home, 'room:1:toggle').click();
    await advance(1_000);
    expect(serviceCalls(card.fake)).toHaveLength(1);
    const toggle = control(home, 'room:1:toggle');
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(renderedText(home)).toMatch(/can't control .+\. Ask an administrator for access\./);
    toggle.click();
    await advance(1_000);
    expect(serviceCalls(card.fake)).toHaveLength(1);
  });
});
