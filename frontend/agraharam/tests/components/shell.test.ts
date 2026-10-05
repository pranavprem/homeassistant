import { describe, expect, it } from 'vitest';
import '../../src/components/shell/agr-config-error.ts';
import '../../src/components/shell/agr-demo-ribbon.ts';
import type { AgrConfigError } from '../../src/components/shell/agr-config-error.ts';
import type { ConfigIssue } from '../../src/config/validate.ts';

const ISSUES: readonly ConfigIssue[] = [
  {
    path: 'cameras[0].privacy_entity',
    code: 'wrong-domain',
    message:
      'cameras[0].privacy_entity: expected a switch, binary_sensor or input_boolean entity, got "light.demo_lamp".',
  },
];

async function mountConfigError(detailed: boolean): Promise<ShadowRoot> {
  const panel = document.createElement('agr-config-error') as AgrConfigError;
  panel.issues = ISSUES;
  panel.detailed = detailed;
  document.body.append(panel);
  await panel.updateComplete;
  return panel.shadowRoot as ShadowRoot;
}

describe('agr-config-error (D4)', () => {
  it('shows admins the path, code and full message', async () => {
    const root = await mountConfigError(true);
    expect(root.querySelector('h2')?.textContent).toBe('Configuration needs attention');
    expect(root.textContent).toContain('cameras[0].privacy_entity');
    expect(root.textContent).toContain('wrong-domain');
    expect(root.textContent).toContain('light.demo_lamp');
  });

  it('shows everyone else only the path and code, never the message that quotes entity IDs', async () => {
    const root = await mountConfigError(false);
    expect(root.textContent).toContain('cameras[0].privacy_entity');
    expect(root.textContent).toContain('wrong-domain');
    expect(root.textContent).not.toContain('light.demo_lamp');
    expect(root.textContent).toContain('Ask an administrator to check the dashboard configuration.');
  });
});

describe('agr-demo-ribbon (§10.1, D5)', () => {
  it('is a non-dismissible status with the exact demo label', async () => {
    const ribbon = document.createElement('agr-demo-ribbon');
    document.body.append(ribbon);
    await ribbon.updateComplete;
    const status = ribbon.shadowRoot?.querySelector('[role="status"]');
    expect(status?.textContent?.trim()).toBe('Demo mode: fictional data. Nothing here controls a real home.');
    expect(ribbon.shadowRoot?.querySelector('button')).toBeNull();
  });
});
