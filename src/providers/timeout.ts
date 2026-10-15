/**
 * Per-request timeout helper for provider adapters.
 *
 * The server sends `request_timeout` (seconds) in the welcome config; each
 * adapter arms a timer for the duration of its CLI subprocess and kills the
 * process if the timer fires. Before this helper existed (ai-bridge#2) the
 * value was stored but never enforced, so a stuck CLI would run forever.
 */

/** Handle returned by startRequestTimeout. */
export interface RequestTimeoutHandle {
  /** Cancel the timer if it has not yet fired. Idempotent. */
  cancel(): void;
}

/**
 * Arm a timer that fires `onTimeout` after `seconds` real-world seconds. A
 * non-positive `seconds` value disables the timer entirely (returns a no-op
 * handle), so adapters do not need to special-case "no timeout".
 *
 * The seconds value is clamped at the source (clampRequestTimeout) so this
 * function trusts what it gets.
 */
export function startRequestTimeout(
  seconds: number,
  onTimeout: () => void,
): RequestTimeoutHandle {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { cancel: () => undefined };
  }
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    onTimeout();
  }, seconds * 1000);
  // Unref so a fired-and-forgotten timer can never keep the Node process
  // alive past the rest of the bridge shutting down.
  timer.unref?.();
  return {
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Alias kept for readability at call sites. */
export function clearRequestTimeout(handle: RequestTimeoutHandle): void {
  handle.cancel();
}

/**
 * The reason a turn's clock killed the CLI, or null if neither fired.
 *
 * Reported as an error code rather than left to surface as "exited with code
 * 143" — which is true, describes the signal, and says nothing about the
 * decision. A consumer cannot render "stopped after 5 minutes" from a signal
 * number.
 */
export type TimeoutReason = 'silence_timeout_exceeded' | 'request_timeout_exceeded';

/** Both clocks that bound a turn, and which of them fired. */
export interface TurnTimeouts {
  /** Called on every event the adapter emits; resets the silence clock. */
  notice(): void;
  /** Stop both clocks. Idempotent. */
  cancel(): void;
  /** Why the CLI was killed, or null if this was not a timeout. */
  reason(): TimeoutReason | null;
  /** The limit that fired, in seconds. */
  limit(): number | null;
}

/**
 * Bound a turn by SILENCE, and optionally by wall clock as well.
 *
 * The wall clock alone cannot tell a stuck CLI from a busy one: an assistant
 * reading a codebase, waiting on a build or running a test suite emits nothing
 * for minutes and is working the whole time, and a turn streaming tool results
 * continuously for five minutes is in the healthiest state a long turn has. It
 * was killed anyway, punctually, mid-work.
 *
 * Silence is the measure that separates stuck from busy, so it is the one that
 * kills by default. The wall clock stays available for a server that wants a
 * hard ceiling, and is disabled by a non-positive value.
 */
export function startTurnTimeouts(opts: {
  silenceSeconds: number;
  requestSeconds: number;
  onFire: (reason: TimeoutReason, limitSeconds: number) => void;
  /**
   * Asked first when the silence bound runs out. Returning true means the
   * adapter ended the turn gently itself; the bound does not fire, and the
   * silence clock starts over, so a turn that still does not end is stopped
   * at the next run-out (onSilence is not asked again).
   */
  onSilence?: () => boolean;
}): TurnTimeouts {
  let fired: TimeoutReason | null = null;
  let firedLimit: number | null = null;
  // Set by cancel(). notice() must respect it: adapters cancel on child close
  // and THEN finalize, and the finalizer's own `error`/`done` pass back through
  // the wrapper that calls notice() — which re-armed a fresh clock on a turn
  // already over, and later logged a false timeout and signalled a dead child.
  let cancelled = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let softTried = false;

  const fire = (reason: TimeoutReason, limitSeconds: number) => {
    // First one wins. Both clocks can be close together, and killing twice
    // would report the second reason for the first decision.
    if (fired !== null) return;
    fired = reason;
    firedLimit = limitSeconds;
    opts.onFire(reason, limitSeconds);
  };

  const armSilence = () => {
    if (!Number.isFinite(opts.silenceSeconds) || opts.silenceSeconds <= 0) return;
    silenceTimer = setTimeout(() => {
      if (!softTried && opts.onSilence !== undefined) {
        softTried = true;
        if (opts.onSilence()) {
          armSilence();

          return;
        }
      }
      fire('silence_timeout_exceeded', opts.silenceSeconds);
    }, opts.silenceSeconds * 1000);
    silenceTimer.unref?.();
  };

  // Silence is armed FIRST so that when the two clocks coincide it is the one
  // that reports. That is not a coin toss: if silence fired, the turn produced
  // nothing for its whole duration, so "the CLI was wedged" is the accurate
  // diagnosis and "it ran too long" is merely also true.
  armSilence();

  const wall = startRequestTimeout(
    opts.requestSeconds,
    () => fire('request_timeout_exceeded', opts.requestSeconds),
  );

  return {
    notice: () => {
      if (fired !== null || cancelled) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      armSilence();
    },
    cancel: () => {
      cancelled = true;
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      wall.cancel();
    },
    reason: () => fired,
    limit: () => firedLimit,
  };
}
