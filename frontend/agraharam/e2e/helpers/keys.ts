/**
 * Tab keys per engine (§12.2). Safari's default Tab moves only between text fields; buttons need Option+Tab, and
 * Playwright's WebKit on macOS follows that setting (microsoft/playwright#32269). The card's focus trap treats
 * Alt+Tab exactly like Tab (§5.4 rule 4), so the same assertions hold in both engines.
 */
export function tabKey(browserName: string): string {
  return usesOptionTab(browserName) ? 'Alt+Tab' : 'Tab';
}

export function shiftTabKey(browserName: string): string {
  return usesOptionTab(browserName) ? 'Alt+Shift+Tab' : 'Shift+Tab';
}

function usesOptionTab(browserName: string): boolean {
  return browserName === 'webkit' && process.platform === 'darwin';
}
