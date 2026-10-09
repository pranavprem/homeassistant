/** Config → full card → drawer and art, against fictional data. No collection ever becomes a control. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  control,
  deepQuery,
  expectNoMutation,
  liveInput,
  mountLive,
  press,
  renderedText,
  section,
  shadowOf,
  topOverlay,
  useAcceptanceTimers,
} from './support.ts';

beforeEach(useAcceptanceTimers);

describe('household readings end to end', () => {
  it.each([false, true])(
    'stays read-only with controls %s and carries the selected vehicle model',
    async (controls) => {
      const card = await mountLive({ scenario: 'dense', input: liveInput('dense', { controls }) });
      expect(deepQuery(card.root, 'svg[data-model="tesla-model-3"]')).not.toBeNull();
      await press(control(shadowOf(section(card, 'agr-health')), 'health:readings'));
      const drawer = topOverlay(card);
      expect(drawer?.tagName.toLowerCase()).toBe('agr-readings-drawer');
      expect(renderedText(drawer as Element)).toContain('House readings');
      const root = shadowOf(drawer);
      const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
      search.value = 'washer';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await (drawer as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
      const rows = [...root.querySelectorAll<HTMLElement>('.reading')];
      expect(rows).toHaveLength(2);
      expect(renderedText(drawer as Element)).toContain('1 h 25 min');
      for (const row of rows) {
        expect(row.querySelector('button, input, a, [tabindex]')).toBeNull();
        row.click();
      }
      expectNoMutation(card.fake);
    },
  );
});
