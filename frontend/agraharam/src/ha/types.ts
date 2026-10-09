/**
 * Narrow host types (§4.3). Local interfaces only: nothing is imported from HA's unpublished frontend
 * sources or from custom-card-helpers.
 */

export interface HassEntityLike {
  readonly entity_id: string;
  readonly state: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly last_changed: string;
  readonly last_updated: string;
  readonly context: {
    readonly id: string;
    readonly parent_id: string | null;
    readonly user_id: string | null;
  };
}
export interface RegistryEntryLike {
  readonly entity_id: string;
  readonly device_id?: string | null;
  readonly area_id?: string | null;
  readonly name?: string | null;
  readonly hidden?: boolean;
  readonly display_precision?: number;
  /** Integrations usually set it for settings and diagnostic entities (a plug's child lock, an LED switch); absent for
   *  a primary entity. The gateway never switches a `config` or `diagnostic` switch from the dashboard (§18). */
  readonly entity_category?: 'config' | 'diagnostic' | null;
}
export interface LocaleLike {
  readonly language: string;
  readonly number_format:
    'language' | 'system' | 'comma_decimal' | 'decimal_comma' | 'quote_decimal' | 'space_comma' | 'none';
  readonly time_format: 'language' | 'system' | '12' | '24';
  readonly time_zone: 'local' | 'server';
}
/** Deliberately omits latitude/longitude/location_name: code cannot reference them. */
export interface ConfigLike {
  readonly unit_system: { readonly temperature: string; readonly length: string };
  readonly time_zone: string;
  readonly state?: 'NOT_RUNNING' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FINAL_WRITE';
  readonly version?: string;
}
export interface ConnectionLike {
  /** hajs live getter: socket exists and readyState is OPEN. Read at call time, never cached. It is false while
   *  the frontend has suspended a hidden tab, when hajs queues messages and would send them on reconnect. */
  readonly connected: boolean;
  subscribeMessage<T>(
    cb: (msg: T) => void,
    msg: Readonly<Record<string, unknown>>,
    options?: { resubscribe?: boolean },
  ): Promise<() => Promise<void>>;
  /** hajs public event API. Local listener registration only: sends nothing. 'ready' fires for every new socket,
   *  'disconnected' when a socket closes (including the hidden-tab suspend). Feature-detected. */
  addEventListener?(type: 'ready' | 'disconnected', cb: () => void): void;
  removeEventListener?(type: 'ready' | 'disconnected', cb: () => void): void;
}
export interface HassLike {
  readonly states: Readonly<Record<string, HassEntityLike>>;
  /** null until the frontend receives its first entity registry message (frontend 20260826.7 connection-mixin). */
  readonly entities?: Readonly<Record<string, RegistryEntryLike>> | null;
  readonly services: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly connected: boolean;
  readonly connection: ConnectionLike;
  readonly locale?: LocaleLike;
  readonly config: ConfigLike;
  readonly themes?: { readonly darkMode?: boolean };
  readonly user?: { readonly id: string; readonly is_admin: boolean };
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: { entity_id: string | string[] },
    notifyOnError?: boolean,
    returnResponse?: boolean,
  ): Promise<{ context: { id: string } }>;
  callApi<T>(method: 'GET', path: string): Promise<T>; // GET only, by type
  fetchWithAuth(path: string, init?: RequestInit): Promise<Response>;
  formatEntityState?(stateObj: HassEntityLike, state?: string): string;
  formatEntityAttributeValue?(stateObj: HassEntityLike, attribute: string, value?: unknown): string;
}
