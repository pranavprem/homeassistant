import { describe, expect, it, vi } from 'vitest';
import { closeIfNotModal, isBackdropClick, showModalSafely } from '../../src/util/modal.ts';

function dialog(): HTMLDialogElement {
  const element = document.createElement('dialog');
  element.append(document.createElement('div'));
  document.body.append(element);
  return element;
}

describe('dialog rules (§5.4 rules 11 and 12)', () => {
  it('closes an already-open dialog before showModal, so it never throws InvalidStateError', () => {
    const element = dialog();
    element.show();
    const close = vi.spyOn(element, 'close');
    const showModal = vi.spyOn(element, 'showModal');
    showModalSafely(element);
    expect(close).toHaveBeenCalledTimes(1);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(showModal.mock.invocationCallOrder[0] ?? 0);
    expect(element.open).toBe(true);
  });

  it('just opens a closed dialog', () => {
    const element = dialog();
    const close = vi.spyOn(element, 'close');
    showModalSafely(element);
    expect(close).not.toHaveBeenCalled();
    expect(element.open).toBe(true);
  });

  it('closes an open dialog that cannot prove it is still modal', () => {
    const element = dialog();
    element.show();
    closeIfNotModal(element);
    expect(element.open).toBe(false);
  });

  it('treats only clicks on the dialog box itself as backdrop clicks', () => {
    const element = dialog();
    const onBox = new MouseEvent('click');
    element.dispatchEvent(onBox);
    expect(isBackdropClick(onBox, element)).toBe(true);
    const inner = element.firstElementChild as HTMLElement;
    const onContent = new MouseEvent('click', { bubbles: true });
    inner.dispatchEvent(onContent);
    expect(isBackdropClick(onContent, element)).toBe(false);
  });
});
