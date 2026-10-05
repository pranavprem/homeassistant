/**
 * Native <dialog> rules shared by agr-drawer and the agr-dialog base (§5.4 rules 11 and 12).
 */

/**
 * Opens `dialog` modally. showModal() throws InvalidStateError on a dialog that is already open (non-modally, for
 * example after a detach and re-attach), so an open dialog is closed first (§5.4 rule 12).
 */
export function showModalSafely(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
  dialog.showModal();
}

/**
 * A modal dialog that is detached and re-attached stays `open` but loses modality: no inertness, no backdrop and
 * focus escapes. Such a dialog is closed rather than left half-working (§5.4 rule 11). Engines without `:modal`
 * support cannot prove modality, so the dialog is closed there too.
 */
export function closeIfNotModal(dialog: HTMLDialogElement): void {
  if (dialog.open && !matchesModal(dialog)) dialog.close();
}

function matchesModal(dialog: HTMLDialogElement): boolean {
  try {
    return dialog.matches(':modal');
  } catch {
    return false;
  }
}

/**
 * True for a click on the backdrop. The dialog's content wrapper fills the dialog box, so a click whose target is
 * the <dialog> element itself can only have landed on its ::backdrop.
 */
export function isBackdropClick(event: Event, dialog: HTMLDialogElement): boolean {
  return event.target === dialog;
}
