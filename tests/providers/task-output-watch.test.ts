/**
 * A background shell task's growing output counts as activity for the silence
 * clock.
 *
 * The incident (2026-09-29): a release watcher ran in the background printing a
 * line every ~33 s. The CLI writes nothing to the stream while a `local_bash`
 * task runs, so after 900 s the bridge stopped the turn as silent — while the
 * terminal rule was holding it open for that very task. The person got an error
 * card instead of the report, with all the work done.
 *
 * Unit tests drive the watcher directly; the adapter tests run a whole input
 * turn against a stand-in CLI whose task output file the test itself grows.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTaskOutputWatch,
  outputPathFrom,
  pollIntervalMs,
} from '../../src/providers/task-output-watch.js';
import { runInputTurn, of, type Step } from './support/input-turn.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quietLog = { debug: () => {}, info: () => {} };

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-output-'));
  scratchDirs.push(dir);

  return dir;
}
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What the CLI actually replies to a backgrounded Bash call (Claude Code, 2026-09). */
const reply = (path: string) =>
  `Command running in background with ID: b1. Output is being written to: ${path}. `
  + 'You will be notified when it completes. To check interim output, use Read on that file.';

const startedFrame = (overrides: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1',
  description: 'watch the release', is_backgrounded: true, task_type: 'local_bash',
  ...overrides,
});

describe('outputPathFrom() and pollIntervalMs()', () => {
  it('reads the path from the reply the CLI really writes', () => {
    expect(outputPathFrom(reply('/tmp/claude-1000/-home-x/abc/tasks/b1.output')))
      .toBe('/tmp/claude-1000/-home-x/abc/tasks/b1.output');
  });

  it('finds nothing in a reply that does not name an output file', () => {
    expect(outputPathFrom('Command running in background with ID: b1.')).toBeNull();
  });

  it('polls every 30 s at the 900 s default, and a quarter of a short bound', () => {
    expect(pollIntervalMs(900)).toBe(30_000);
    expect(pollIntervalMs(1)).toBe(250);
  });
});

describe('createTaskOutputWatch()', () => {
  it('reports growth, and only growth', async () => {
    const path = join(scratch(), 'b1.output');
    writeFileSync(path, 'line 1\n');
    let growths = 0;
    const watch = createTaskOutputWatch({ silenceSeconds: 0.4, onGrowth: () => { growths++; }, log: quietLog, requestId: 'r' });
    watch.started(startedFrame());
    watch.toolResult('toolu_1', reply(path));

    await sleep(350);
    expect(growths).toBe(1); // the first line, seen once
    await sleep(350);
    expect(growths).toBe(1); // nothing new: not activity
    appendFileSync(path, 'line 2\n');
    await sleep(350);
    expect(growths).toBe(2);
    watch.stop();
  });

  it('stops looking when the task ends, and when the turn stops', async () => {
    const path = join(scratch(), 'b1.output');
    let growths = 0;
    const watch = createTaskOutputWatch({ silenceSeconds: 0.4, onGrowth: () => { growths++; }, log: quietLog, requestId: 'r' });
    watch.started(startedFrame());
    watch.toolResult('toolu_1', reply(path));
    watch.ended('b1');
    appendFileSync(path, 'after the end\n');
    await sleep(350);
    expect(growths).toBe(0);
    watch.stop();
    watch.stop(); // idempotent
  });

  it('watches nothing for a reply without a path, or another task type', async () => {
    const path = join(scratch(), 'b1.output');
    writeFileSync(path, 'output\n');
    let growths = 0;
    const make = () => createTaskOutputWatch({ silenceSeconds: 0.4, onGrowth: () => { growths++; }, log: quietLog, requestId: 'r' });

    const noPath = make();
    noPath.started(startedFrame());
    noPath.toolResult('toolu_1', 'Command running in background with ID: b1.');
    const agentTask = make();
    agentTask.started(startedFrame({ task_type: 'local_agent' }));
    agentTask.toolResult('toolu_1', reply(path));
    // A command that ran in the foreground: its reply is its output, no file.
    const foreground = make();
    foreground.started(startedFrame({ is_backgrounded: false }));
    foreground.toolResult('toolu_1', 'v1.4.2\n');

    await sleep(350);
    expect(growths).toBe(0);
    for (const w of [noPath, agentTask, foreground]) w.stop();
  });

  it('watches a helper\'s command, and one moved to the background after it started, the same way', async () => {
    // A helper's command holds the turn open like the main assistant's, so its
    // progress counts the same (D09379). And a command the model ran in the
    // foreground is moved to the background when it outlives its tool timeout:
    // its task_started still says is_backgrounded false, and only the reply
    // naming an output file says it now runs in the background.
    const make = (frame: Record<string, unknown>, text: (path: string) => string) => {
      const path = join(scratch(), 'b1.output');
      writeFileSync(path, 'output\n');
      let growths = 0;
      const watch = createTaskOutputWatch({ silenceSeconds: 0.4, onGrowth: () => { growths++; }, log: quietLog, requestId: 'r' });
      watch.started(startedFrame(frame));
      watch.toolResult('toolu_1', text(path));

      return { watch, growths: () => growths };
    };
    const helper = make({ owned_by_subagent: true }, reply);
    const moved = make({ is_backgrounded: false }, (path) =>
      'Command did not complete within its 600s timeout and was moved to the background (ID: b1). '
      + `Output is being written to: ${path}. You will be notified when it completes.`);

    await sleep(350);
    expect(helper.growths()).toBe(1);
    expect(moved.growths()).toBe(1);
    helper.watch.stop();
    moved.watch.stop();
  });

  it('survives an output file that never appears', async () => {
    let growths = 0;
    const watch = createTaskOutputWatch({ silenceSeconds: 0.4, onGrowth: () => { growths++; }, log: quietLog, requestId: 'r' });
    watch.started(startedFrame());
    watch.toolResult('toolu_1', reply(join(scratch(), 'missing', 'b1.output')));
    await sleep(350);
    expect(growths).toBe(0);
    watch.stop();
  });

  it('watches nothing when there is no silence bound to feed', async () => {
    const path = join(scratch(), 'b1.output');
    writeFileSync(path, 'output\n');
    let growths = 0;
    const watch = createTaskOutputWatch({ silenceSeconds: 0, onGrowth: () => { growths++; }, log: quietLog, requestId: 'r' });
    watch.started(startedFrame());
    watch.toolResult('toolu_1', reply(path));
    await sleep(250);
    expect(growths).toBe(0);
    watch.stop();
  });
});

describe('an input turn waiting on a background command', () => {
  const SILENCE_S = 1;

  /**
   * The CLI starts a background command, finishes its reply, then says nothing
   * for `quietMs`. With `byHelper`, a background helper still at work started
   * the command, and ends once the command has.
   */
  function script(toolResultText: string, quietMs: number, byHelper = false): Step[] {
    const line = (frame: unknown): Step => ({ line: JSON.stringify(frame) });
    const helper = byHelper
      ? [line({
        type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'toolu_agent',
        description: 'release helper', is_backgrounded: true, task_type: 'local_agent', session_id: 's1',
      })]
      : [];
    const helperEnds = byHelper
      ? [line({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_agent', status: 'completed', session_id: 's1' })]
      : [];

    return [
      line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-test' }),
      ...helper,
      line(startedFrame({ session_id: 's1', ...(byHelper ? { owned_by_subagent: true } : {}) })),
      line({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: toolResultText }] },
        parent_tool_use_id: byHelper ? 'toolu_agent' : null,
        session_id: 's1',
      }),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'Started.', session_id: 's1' }),
      { sleep: quietMs },
      line({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed' }, session_id: 's1' }),
      ...helperEnds,
      line({ type: 'result', subtype: 'success', is_error: false, result: 'Released.', session_id: 's1' }),
      { exit: 0 },
    ];
  }

  /** Append a line to `path` every 200 ms for `forMs`. */
  function grow(path: string, forMs: number): () => void {
    writeFileSync(path, '');
    const timer = setInterval(() => appendFileSync(path, `still going ${Date.now()}\n`), 200);
    const stopAt = setTimeout(() => clearInterval(timer), forMs);

    return () => { clearInterval(timer); clearTimeout(stopAt); };
  }

  const silenceErrors = (events: Awaited<ReturnType<typeof runInputTurn>>['events']) =>
    of(events, 'error').filter((e) => (e.data as { code: string }).code === 'silence_timeout_exceeded');

  it('is not stopped while the command keeps writing output, for well past the silence bound', async () => {
    const path = join(scratch(), 'b1.output');
    const stop = grow(path, 10_000);
    try {
      const { events } = await runInputTurn({
        steps: script(reply(path), 3000),
        message: 'release it',
        silenceTimeoutSeconds: SILENCE_S,
      });
      expect(silenceErrors(events)).toEqual([]);
      expect(of(events, 'done')).toHaveLength(1);
    } finally {
      stop();
    }
  }, 15_000);

  it('is not stopped while a helper\'s command keeps writing output either (D09379)', async () => {
    const path = join(scratch(), 'b1.output');
    const stop = grow(path, 10_000);
    try {
      const { events } = await runInputTurn({
        steps: script(reply(path), 3000, true),
        message: 'release it',
        silenceTimeoutSeconds: SILENCE_S,
      });
      expect(silenceErrors(events)).toEqual([]);
      expect(of(events, 'done')).toHaveLength(1);
    } finally {
      stop();
    }
  }, 15_000);

  it('is stopped as silent once the command stops writing', async () => {
    const path = join(scratch(), 'b1.output');
    const stop = grow(path, 500);
    try {
      const startedAt = Date.now();
      const { events } = await runInputTurn({
        steps: script(reply(path), 5000),
        message: 'release it',
        silenceTimeoutSeconds: SILENCE_S,
      });
      expect(silenceErrors(events)).toHaveLength(1);
      // Kept alive by the growth, then stopped a bound after it ended — well
      // before the stand-in would have finished on its own.
      expect(Date.now() - startedAt).toBeLessThan(4000);
    } finally {
      stop();
    }
  }, 15_000);

  it('is stopped as silent, as before, when the reply names no output file', async () => {
    const path = join(scratch(), 'b1.output');
    const stop = grow(path, 10_000);
    try {
      const { events } = await runInputTurn({
        steps: script('Command running in background with ID: b1.', 3000),
        message: 'release it',
        silenceTimeoutSeconds: SILENCE_S,
      });
      expect(silenceErrors(events)).toHaveLength(1);
    } finally {
      stop();
    }
  }, 15_000);
});
