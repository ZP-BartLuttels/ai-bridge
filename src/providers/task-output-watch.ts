/**
 * Count a background shell task's output as activity for the silence clock.
 *
 * A turn is stopped as silent after `silenceSeconds` in which the CLI writes
 * nothing. A background `local_bash` task writes nothing to the stream while it
 * runs — no `task_progress`, no heartbeat; those exist only for sub-agents — so
 * a backgrounded command that is visibly making progress looked exactly like a
 * hung CLI. The terminal rule held the turn open BECAUSE the
 * task was running, and the silence clock then killed it for waiting on that
 * same task (2026-09-29: a release watcher printing a line every 33 s, killed
 * at 900 s with all the work done).
 *
 * So: while such a task runs, poll the file its output goes to, and treat
 * GROWTH as activity. Growth only, never "a task is running": that would let a
 * hung `sleep 99999` hold a turn open until the wall clock. A task whose output
 * stops growing still lets the silence clock run out, and that ends the turn
 * exactly as before.
 *
 * Whoever started it: the main assistant, or a helper (`owned_by_subagent`). A
 * helper's command holds the turn open exactly like the main assistant's, so
 * its progress has to count the same way; leaving it out let a helper's long
 * build be stopped as silent while it was printing all along (D09379).
 *
 * Which commands run in the background is read from the same reply, not from
 * `is_backgrounded`: a command the model ran in the foreground is moved to the
 * background when it outlives its tool timeout, and its `task_started` was
 * written before that happened. Only a command running in the background gets
 * a reply naming an output file, so a foreground one is never watched.
 *
 * The path is read from the CLI's own reply to the call ("Output is being
 * written to: …"), never built here: the `/tmp/claude-<uid>/…/tasks/` layout
 * is a Claude Code internal. If the reply ever stops saying it, nothing is
 * watched and the turn behaves exactly as it did before this existed.
 */

import { stat } from 'node:fs';

/** How often to look at most, and at least. Scaled to the silence bound. */
const MAX_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 100;
/** At most one info line per task per this long, so a long task cannot flood the log. */
const LOG_EVERY_MS = 5 * 60_000;

const OUTPUT_PATH = /Output is being written to: (\S+?\.output)/;

interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
}

interface Watched {
  path: string;
  lastSize: number;
  lastLoggedAt: number;
}

export interface TaskOutputWatch {
  /** A task started. Every `local_bash` task is kept until its reply says whether it runs in the background. */
  started(frame: Record<string, unknown>): void;
  /** A tool result arrived; if it answers a kept task's call, start watching its file. */
  toolResult(toolUseId: string, text: string): void;
  /** A task ended: stop watching it. */
  ended(taskId: string): void;
  /** The turn is over: stop everything. Idempotent. */
  stop(): void;
}

/**
 * The poll interval for a silence bound: a quarter of it, so growth is seen
 * well before the bound runs out, and never more often than needed — 30 s at
 * the 900 s default.
 */
export function pollIntervalMs(silenceSeconds: number): number {
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, (silenceSeconds * 1000) / 4));
}

/** The output path the CLI names in its reply to a backgrounded command, or null. */
export function outputPathFrom(text: string): string | null {
  return OUTPUT_PATH.exec(text)?.[1] ?? null;
}

export function createTaskOutputWatch(opts: {
  /** The silence bound; a non-positive one means there is no clock to feed, so nothing is watched. */
  silenceSeconds: number;
  /** Called when a watched file grew since the last look. */
  onGrowth: () => void;
  log: Logger;
  requestId: string;
}): TaskOutputWatch {
  const enabled = Number.isFinite(opts.silenceSeconds) && opts.silenceSeconds > 0;
  const intervalMs = pollIntervalMs(opts.silenceSeconds);
  /** tool_use_id → task_id, for tasks whose reply (and so path) has not arrived yet. */
  const awaitingPath = new Map<string, string>();
  const watched = new Map<string, Watched>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const syncTimer = (): void => {
    if (watched.size > 0 && timer === null && !stopped) {
      timer = setInterval(poll, intervalMs);
      timer.unref?.();
    } else if ((watched.size === 0 || stopped) && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const poll = (): void => {
    for (const [taskId, entry] of watched) {
      stat(entry.path, (err, st) => {
        // The task may have ended, or the turn stopped, while stat ran.
        if (stopped || watched.get(taskId) !== entry) return;
        // ENOENT and the like: not yet written, or gone. Not activity.
        if (err !== null || st.size <= entry.lastSize) return;
        entry.lastSize = st.size;
        const now = Date.now();
        if (now - entry.lastLoggedAt >= LOG_EVERY_MS) {
          entry.lastLoggedAt = now;
          opts.log.info('Background task output grew — counting it as activity', {
            requestId: opts.requestId, taskId, bytes: st.size,
          });
        }
        opts.onGrowth();
      });
    }
  };

  return {
    started: (frame) => {
      if (!enabled || stopped) return;
      if (frame['task_type'] !== 'local_bash') return;
      const taskId = frame['task_id'];
      const toolUseId = frame['tool_use_id'];
      if (typeof taskId !== 'string' || typeof toolUseId !== 'string') return;
      awaitingPath.set(toolUseId, taskId);
    },
    toolResult: (toolUseId, text) => {
      const taskId = awaitingPath.get(toolUseId);
      if (taskId === undefined || stopped) return;
      awaitingPath.delete(toolUseId);
      const path = outputPathFrom(text);
      if (path === null) {
        opts.log.debug('Task reply names no output file (it ran in the foreground) — not watching it', {
          requestId: opts.requestId, taskId,
        });

        return;
      }
      watched.set(taskId, { path, lastSize: 0, lastLoggedAt: 0 });
      opts.log.debug('Watching background task output for activity', {
        requestId: opts.requestId, taskId, path, intervalMs,
      });
      syncTimer();
    },
    ended: (taskId) => {
      for (const [toolUseId, id] of awaitingPath) {
        if (id === taskId) awaitingPath.delete(toolUseId);
      }
      if (watched.delete(taskId)) syncTimer();
    },
    stop: () => {
      stopped = true;
      awaitingPath.clear();
      watched.clear();
      syncTimer();
    },
  };
}
