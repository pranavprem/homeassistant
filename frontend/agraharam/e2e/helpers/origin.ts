/**
 * The preview server every spec talks to (§12.2): `vite preview` of dist/preview on loopback only. The port defaults
 * to 4173; AGR_E2E_PORT moves a run to another port when 4173 is already taken (for example by `npm run preview`).
 */
const DEFAULT_PORT = 4173;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

function previewPort(): number {
  const raw = process.env['AGR_E2E_PORT'];
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `AGR_E2E_PORT must be an integer from ${MIN_PORT} to ${MAX_PORT}; unset it to use ${DEFAULT_PORT}.`,
    );
  }
  return port;
}

export const PREVIEW_PORT = previewPort();
export const PREVIEW_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`;
