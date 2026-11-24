/**
 * The server's side of machine secrets (decision 0020): the `secret_*` frames
 * answered from the built-in store (src/secrets/store.ts), each bounded by a
 * timeout so a store on a hung disk cannot hold a frame unanswered.
 *
 * A value only goes in (`secret_put`); nothing here reads one.
 */

import {
  MACHINE_SECRETS_REVISION,
  MAX_FRAME_VALUE_BYTES,
  SecretRefusal,
  MachineSecretStore,
  type EndedRecord,
  type SecretRow,
} from './store.js';

export { MACHINE_SECRETS_REVISION, SecretRefusal };

/** How long one store operation may take before the server is told `timeout`. */
export const SECRET_OP_TIMEOUT_MS = 15_000;

/** Replace every occurrence of `secret` in `text`. */
export function scrub(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

export interface MachineSecretsOptions {
  store?: MachineSecretStore;
  /** Per operation; default SECRET_OP_TIMEOUT_MS. */
  timeoutMs?: number;
}

export class MachineSecrets {
  readonly store: MachineSecretStore;
  private readonly timeoutMs: number;

  constructor(options: MachineSecretsOptions = {}) {
    this.store = options.store ?? new MachineSecretStore();
    this.timeoutMs = options.timeoutMs ?? SECRET_OP_TIMEOUT_MS;
  }

  list(): Promise<{ secrets: SecretRow[]; ended: EndedRecord[] }> {
    return this.bounded(() => this.store.listWithEnded());
  }

  /** Handle the ends that have passed (at start and on the bridge's timer). */
  sweep(): Promise<EndedRecord[]> {
    return this.bounded(() => this.store.sweep());
  }

  put(
    name: unknown,
    value: unknown,
    options: { replace?: unknown; description?: unknown; endsAt?: unknown; endKind?: unknown } = {},
  ): Promise<{ replaced: boolean }> {
    if (options.description !== undefined && options.description !== null && typeof options.description !== 'string') {
      return Promise.reject(new SecretRefusal('invalid_request', 'The description must be text.'));
    }
    return this.bounded(() => this.store.put(name, value, {
      replace: options.replace === true,
      description: options.description as string | null | undefined,
      maxBytes: MAX_FRAME_VALUE_BYTES,
      endsAt: options.endsAt,
      endKind: options.endKind,
    }), typeof value === 'string' ? value : undefined);
  }

  setEnd(name: unknown, endsAt: unknown, endKind?: unknown): Promise<void> {
    return this.bounded(() => this.store.setEnd(name, endsAt, endKind));
  }

  describe(name: unknown, description: unknown): Promise<void> {
    return this.bounded(() => this.store.describe(name, description));
  }

  remove(name: unknown): Promise<void> {
    return this.bounded(() => this.store.remove(name));
  }

  /**
   * The operation, or `timeout` when it has not finished in time: it may still
   * finish, so the result is unknown. Any error that is not a SecretRefusal
   * becomes `failed` without its message, and a refusal's text is scrubbed of
   * the value in case one ever carried it.
   */
  private bounded<T>(op: () => Promise<T>, value?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SecretRefusal(
          'timeout',
          `The secret store did not finish within ${Math.round(this.timeoutMs / 1000)} s; the result is unknown, list again before retrying.`,
        ));
      }, this.timeoutMs);
      op().then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof SecretRefusal
            ? new SecretRefusal(err.code, scrub(err.message, value))
            : new SecretRefusal('failed', 'The secret store could not do that.'));
        },
      );
    });
  }
}
