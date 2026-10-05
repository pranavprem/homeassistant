/**
 * Control helpers shared by every section selector that renders controls (Comfort, Home, Media): the action key a
 * device's tickets live under, and availability gated by the device's own feature bits on top of the gateway's
 * verdict. Pure: they evaluate through the gateway and never request anything.
 */
import type { EntityId } from '../config/schema.ts';
import {
  actionKeyFor,
  type ActionGateway,
  type ActionKey,
  type ActionRequest,
  type Availability,
} from '../ha/actions/types.ts';

/** Every entity-targeted action kind is ticketed under `entity:<id>` (actionKeyFor), so one key covers a device. */
export function entityActionKey(entity: EntityId): ActionKey {
  return actionKeyFor({ kind: 'fan.turn_on', entity });
}

/** The control is enabled by the gateway but the device lacks the feature: the gateway's precedence is kept. */
function unsupportedAvailability(name: string): Availability {
  return { enabled: false, reason: 'unsupported', message: `${name} doesn't support this control.` };
}

/** Every option of a choice group while a ticket on its key is in flight (§7.2 rule 4). */
export function busyAvailability(name: string): Availability {
  return { enabled: false, reason: 'busy', message: `Waiting for ${name} to respond to the last request.` };
}

/** Evaluates through the gateway first, then applies the device's own capability (§7.1 "Capability"). */
export function gatedAvailability(
  gateway: ActionGateway,
  req: ActionRequest,
  supported: boolean,
  name: string,
): Availability {
  const availability = gateway.evaluate(req);
  return availability.enabled && !supported ? unsupportedAvailability(name) : availability;
}
