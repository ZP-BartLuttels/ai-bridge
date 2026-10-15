/**
 * A turn that keeps its input open (`options.accepts_input`): messages reach
 * the assistant while the turn runs, and the turn ends by a rule rather than at
 * the first `result`.
 *
 * The fixtures are whole turns captured from Claude Code 2.1.280 in stream-json
 * input mode (`-p --output-format stream-json --verbose
 * --include-partial-messages --input-format stream-json
 * --replay-user-messages`, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS unset), byte for
 * byte, each with one message injected 15 s in:
 *
 *  - claude-input-background-bash-turn: a background `sleep 40` command. The
 *    reply ends at ~5 s with an UNSTAMPED result while the command runs; the
 *    injected message is answered at once ("Paris"); the command ends at ~44 s
 *    and the CLI answers that in a turn of its own (stamped result).
 *  - claude-input-background-helper-turn: the same with a background helper,
 *    which runs a foreground shell task of its own.
 *  - claude-input-redirect-foreground-bash-turn: "stop and answer 6×7 instead"
 *    sent 15 s into a 40 s FOREGROUND command: read when the command returned.
 *  - claude-input-redirect-foreground-helper-turn: the same message sent while
 *    the main assistant waited on a FOREGROUND helper (captured with
 *    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1): read when the helper returned.
 *
 * And one captured without input, reused for its frames:
 *
 *  - claude-queued-notification-turn: a resumed session whose previous turn
 *    was stopped with a background command running. The CLI first answers
 *    that leftover notification — a STAMPED result, num_turns 0, 71 ms — and
 *    only then the prompt.
 *
 * The stand-in CLI (support/input-turn.ts) replays them and holds each echo back
 * until the adapter has actually written the message, as the real CLI does.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURES, stepsFromFixture, runInputTurn, of, mainStates, lineIndex, type Step,
} from './support/input-turn.js';
import { TurnInputPort, userMessageFrame } from '../../src/providers/turn-input.js';
import type { DoneData } from '../../src/protocol/types.js';

vi.mock('../../src/providers/claude-capabilities.js', () => ({
  supportsPartialMessages: () => Promise.resolve(true),
  resetPartialMessageSupportCache: () => {},
  noteCliRejectedPartialFlag: () => false,
}));

const BACKGROUND_BASH = 'claude-input-background-bash-turn.ndjson';
const BACKGROUND_HELPER = 'claude-input-background-helper-turn.ndjson';
const FOREGROUND_BASH = 'claude-input-redirect-foreground-bash-turn.ndjson';
const FOREGROUND_HELPER = 'claude-input-redirect-foreground-helper-turn.ndjson';
const QUEUED_NOTIFICATION = 'claude-queued-notification-turn.ndjson';

/**
 * Offer every injected message once, as soon as the turn takes them: at the
 * first event after the CLI's first init, which is when input opens.
 */
function offerAtStart(injected: string[], results: Array<{ status: string }>) {
  let offered = false;

  return (_event: { event: string }, port: TurnInputPort): void => {
    if (offered || !port.isOpen()) return;
    offered = true;
    injected.forEach((content, i) => results.push(port.offer(`m${i + 1}`, content)));
  };
}

const line = (value: unknown): Step => ({ line: JSON.stringify(value) });
const readFixture = (name: string): string[] =>
  readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim() !== '');
const init = line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5' });
const echo = (content: string): Step => line({
  type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: 's1', isReplay: true,
});
const text = (value: string, stop: string | null = 'end_turn'): Step => line({
  type: 'assistant', parent_tool_use_id: null,
  message: { id: `msg_${value}`, role: 'assistant', content: [{ type: 'text', text: value }], stop_reason: stop },
});
const result = (extra: Record<string, unknown> = {}): Step => line({
  type: 'result', subtype: 'success', is_error: false, session_id: 's1', num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
  ...extra,
});
const taskStarted = (id: string, type: string, background: boolean): Step => line({
  type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `toolu_${id}`,
  task_type: type, is_backgrounded: background, description: id,
});
const taskFinished = (id: string): Step => line({
  type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: `toolu_${id}`, status: 'completed',
});

describe('spawning a turn with its input open', () => {
  it('asks the CLI for stream-json input and echoes, and hands over the opening message as a frame', async () => {
    const turn = await runInputTurn({
      message: 'hello there',
      steps: [echo('hello there'), init, text('hi'), result(), { waitEof: true }],
    });

    expect(turn.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--replay-user-messages']));
    expect(turn.spawnOptions).toEqual({ keepStdinOpen: true });
    // The shape verified against 2.1.280, and nothing else on the line.
    expect(turn.record.frames).toEqual(['{"type":"user","message":{"role":"user","content":"hello there"}}']);
    expect(turn.stdinInput).toBe(userMessageFrame('hello there'));
  });

  it('changes nothing about a turn that did not ask', async () => {
    const turn = await runInputTurn({
      message: 'hello there',
      withPort: false,
      steps: [init, text('hi'), result()],
    });

    expect(turn.args).not.toContain('--input-format');
    expect(turn.args).not.toContain('--replay-user-messages');
    expect(turn.spawnOptions).toBeUndefined();
    expect(turn.stdinInput).toBe('hello there');
    expect(of(turn.events, 'main_state')).toHaveLength(0);
    expect(of(turn.events, 'done')).toHaveLength(1);
  });
});

describe('messages for a running turn', () => {
  it('accepts a message while the CLI runs, writes it as a frame, and reports when it is read', async () => {
    const { steps, opening, injected } = stepsFromFixture(BACKGROUND_BASH);
    expect(injected).toEqual(['Meanwhile: what is the capital of France? One word.']);
    const outcomes: Array<{ status: string }> = [];

    const turn = await runInputTurn({ steps, message: opening, onEvent: offerAtStart(injected, outcomes) });

    expect(outcomes).toEqual([{ status: 'accepted' }]);
    expect(turn.record.frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'user', message: { role: 'user', content: opening } },
      { type: 'user', message: { role: 'user', content: injected[0] } },
    ]);
    // Once, for the injected message: the opening's echo is not reported.
    expect(of(turn.events, 'user_input').map((e) => e.data)).toEqual([{ message_id: 'm1' }]);

    // In the stream where the CLI read it: after the first reply, before "Paris".
    const names = turn.events.map((e) => e.event);
    const read = names.indexOf('user_input');
    const parisAt = turn.events.findIndex((e) => e.event === 'block_delta'
      && (e.data as { content?: string }).content === 'Paris');
    expect(read).toBeGreaterThan(0);
    expect(parisAt).toBeGreaterThan(read);
  });

  it('does not close stdin at an early result while a background command runs', async () => {
    const { steps, lines, opening, injected } = stepsFromFixture(BACKGROUND_BASH);

    const turn = await runInputTurn({ steps, message: opening, onEvent: offerAtStart(injected, []) });

    // The unstamped result that ends the first reply, with the command running.
    const early = lineIndex(lines, (f) => f['type'] === 'result');
    const commandEnded = lineIndex(lines, (f) => f['subtype'] === 'task_updated');
    // The CLI's own turn answering the command's end starts with an init.
    const answerStarts = lineIndex(lines, (f) => f['subtype'] === 'init', true);
    expect(early).toBeLessThan(commandEnded);
    expect(commandEnded).toBeLessThan(answerStarts);
    expect(turn.record.eofAt).not.toBeNull();
    expect(turn.record.eofAt!).toBeGreaterThan(commandEnded);
    // And it waited for that turn, rather than closing the moment the
    // command ended: a message sent meanwhile still reaches the assistant.
    expect(turn.record.eofAt!).toBeGreaterThan(answerStarts + 1);
  });

  it('does not close stdin while a helper, or a shell task of that helper, runs', async () => {
    const { steps, lines, opening, injected } = stepsFromFixture(BACKGROUND_HELPER);
    const outcomes: Array<{ status: string }> = [];

    const turn = await runInputTurn({ steps, message: opening, onEvent: offerAtStart(injected, outcomes) });

    expect(outcomes).toEqual([{ status: 'accepted' }]);
    expect(of(turn.events, 'user_input')).toHaveLength(1);
    const helperEnded = lineIndex(lines, (f) => f['subtype'] === 'task_notification', true);
    expect(turn.record.eofAt!).toBeGreaterThan(helperEnded);
  });

  it('keeps stdin open for a local_bash task, and closes it when the task ends', async () => {
    const turn = await runInputTurn({
      message: 'go',
      steps: [
        echo('go'), init,
        taskStarted('b1', 'local_bash', true),
        text('Started.'), result(), { sleep: 150 },
        // Nothing may have closed stdin yet: the command still runs.
        taskFinished('b1'), { sleep: 150 },
        init, text('It printed done.'), result({ origin: { kind: 'task-notification' } }),
        { waitEof: true },
      ],
    });

    // Lines: echo, init, started, text, result (5) | finished (6) | init,
    // text (8), result. Closed once the CLI's own turn for the finished task
    // has ended, and at no point before it.
    expect(turn.record.eofAt).toBeGreaterThanOrEqual(8);
    expect(of(turn.events, 'done')).toHaveLength(1);
  });

  describe('commands a finished helper left behind', () => {
    /** A shell command a helper started: the CLI marks it `owned_by_subagent`. */
    const helperCommand = (id: string): Step => line({
      type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `toolu_${id}`,
      task_type: 'local_bash', is_backgrounded: true, owned_by_subagent: true, description: id,
    });
    /** What the CLI writes for such a command once stdin is closed (captured, 2.1.280). */
    const killedOnClose = (id: string): Step[] => [
      line({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status: 'killed' } }),
      line({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: `toolu_${id}`, status: 'stopped' }),
    ];

    it('still hold the turn open after the helper finished: the CLI wakes it with their result', async () => {
      // A finished helper is not gone. When its background command ends, the
      // CLI hands it the notification and it carries on (2.1.283, 2026-10-15:
      // a helper woken four times this way to read its test runs and merge).
      // Closing stdin early would make the CLI kill the command mid-run.
      const turn = await runInputTurn({
        message: 'go',
        steps: [
          echo('go'), init,
          taskStarted('a1', 'local_agent', true),
          text('Launched.'), result(),
          helperCommand('b1'),
          taskFinished('a1'),
          init, text('The helper is waiting on its check.'), result({ origin: { kind: 'task-notification' } }),
          { sleep: 300 },
          taskFinished('b1'),
          { waitEof: true },
        ],
      });

      // Lines: echo, init, helper, text, result (5) | command (6) | helper
      // ends (7) | init, text, result (10) | command ends (11). Not before.
      expect(turn.record.eofAt).toBe(11);
      expect(of(turn.events, 'input_closed').map((e) => e.data)).toEqual([{ reason: 'idle' }]);
      expect(of(turn.events, 'error')).toEqual([]);
    });

    it('end the turn gently, not as an error, when only they are left and the bound runs out', async () => {
      // The incident: a "wait until ready" loop that would never end, printing
      // nothing, left by a finished helper after the answer was complete.
      const turn = await runInputTurn({
        message: 'go',
        silenceTimeoutSeconds: 1,
        steps: [
          echo('go'), init,
          taskStarted('a1', 'local_agent', true),
          text('Launched.'), result(),
          helperCommand('b1'),
          taskFinished('a1'),
          init, text('The review is done.'), result({ origin: { kind: 'task-notification' } }),
          { waitEof: true },
          ...killedOnClose('b1'),
        ],
      });

      expect(turn.record.eofAt).toBe(10);
      expect(of(turn.events, 'input_closed').map((e) => e.data))
        .toEqual([{ reason: 'leftovers_silent', stopped_tasks: 1 }]);
      expect(of(turn.events, 'error')).toEqual([]);
      expect(of(turn.events, 'done')).toHaveLength(1);
    });

    it('are stopped as silent, as before, when the main assistant\'s own command is running too', async () => {
      const turn = await runInputTurn({
        message: 'go',
        silenceTimeoutSeconds: 1,
        steps: [
          echo('go'), init,
          taskStarted('m1', 'local_bash', true),
          taskStarted('a1', 'local_agent', true),
          text('Launched.'), result(),
          helperCommand('b1'),
          taskFinished('a1'),
          init, text('Waiting.'), result({ origin: { kind: 'task-notification' } }),
          { sleep: 5000 },
        ],
      });

      expect(of(turn.events, 'input_closed')).toEqual([]);
      expect(of(turn.events, 'error')[0].data).toMatchObject({ code: 'silence_timeout_exceeded' });
    });

    it('still hold it while the helper that started them is at work', async () => {
      const turn = await runInputTurn({
        message: 'go',
        steps: [
          echo('go'), init,
          taskStarted('a1', 'local_agent', true),
          text('Launched.'), result(),
          helperCommand('b1'), { sleep: 150 },
          // Nothing may have closed stdin yet: the helper still works.
          taskFinished('b1'), taskFinished('a1'),
          init, text('The review is done.'), result({ origin: { kind: 'task-notification' } }),
          { waitEof: true },
        ],
      });

      // Closed only after the helper ended (line 8) and its answer (line 11).
      expect(turn.record.eofAt).toBe(11);
      expect(of(turn.events, 'done')).toHaveLength(1);
    });

    it('change nothing for a command the main assistant left running', async () => {
      const turn = await runInputTurn({
        message: 'go',
        steps: [
          echo('go'), init,
          taskStarted('b1', 'local_bash', true),
          text('Started.'), result(), { sleep: 150 },
          taskFinished('b1'), { sleep: 150 },
          init, text('It printed done.'), result({ origin: { kind: 'task-notification' } }),
          { waitEof: true },
        ],
      });

      // As in 'keeps stdin open for a local_bash task': not before its end.
      expect(turn.record.eofAt).toBeGreaterThanOrEqual(8);
    });

    it('wait for the main assistant\'s answer to its own command moved to the background late', async () => {
      // Started in the foreground (no is_backgrounded), moved to the background
      // when it outlived its tool timeout. The reply says so; the CLI then owes
      // the main assistant a turn with the result, and the close must wait it.
      const turn = await runInputTurn({
        message: 'go',
        steps: [
          echo('go'), init,
          taskStarted('m1', 'local_bash', false),
          line({ type: 'user', message: { role: 'user', content: [{
            type: 'tool_result', tool_use_id: 'toolu_m1',
            content: 'Command did not complete within its 120s timeout and was moved to the background (ID: m1). '
              + 'Output is being written to: /tmp/does-not-exist/m1.output. You will be notified when it completes.',
          }] } }),
          text('It is still running in the background.'), result(),
          taskFinished('m1'), { sleep: 300 },
          init, text('The build finished.'), result({ origin: { kind: 'task-notification' } }),
          { waitEof: true },
        ],
      });

      // Lines: echo, init, task, reply, text, result (6) | ends (7) | init,
      // text, result (10). Closing at 7 would drop the answer to the result.
      expect(turn.record.eofAt).toBe(10);
      expect(of(turn.events, 'error')).toEqual([]);
    });
  });

  it('does not close stdin while an accepted message is still unread, then closes when drained', async () => {
    let offered = false;
    const turn = await runInputTurn({
      message: 'go',
      steps: [
        echo('go'), init, text('first'), result(), { sleep: 100 },
        { waitInput: 2 }, echo('second question'), init, text('second'), result(), { waitEof: true },
      ],
      onEvent: (e, port) => {
        // Offered at the first idle, which is exactly when a close is due.
        if (!offered && e.event === 'main_state' && (e.data as { state: string }).state === 'idle') {
          offered = true;
          expect(port.offer('q2', 'second question')).toEqual({ status: 'accepted' });
        }
      },
    });

    // Not closed after the first reply (lines 3-4): the message was pending.
    // Closed once its answer ended (line 7).
    expect(turn.record.eofAt).toBeGreaterThanOrEqual(7);
    expect(of(turn.events, 'user_input').map((e) => e.data)).toEqual([{ message_id: 'q2' }]);
    expect(turn.port.pending()).toEqual([]);
  });

  it('takes only a replayed frame with the message\'s text as its echo', async () => {
    // The CLI writes user frames of its own (after a compaction, say). Taken
    // for the head message's echo, one would report a message read that the
    // assistant never saw, and credit the real echo to the next message.
    let offered = false;
    const own = (content: string, replay?: boolean): Step => line({
      type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: 's1',
      ...(replay === undefined ? {} : { isReplay: replay }),
    });
    const turn = await runInputTurn({
      message: 'go',
      steps: [
        echo('go'), init, text('first', null),
        { waitInput: 3 },
        own('This session is being continued from a previous conversation…'),
        own('[compacted summary]', true),
        text('meanwhile', null),
        echo('one'), echo('two'), init, text('answered'), result(), { waitEof: true },
      ],
      onEvent: (e, port) => {
        if (!offered && e.event === 'block_start') {
          offered = true;
          port.offer('m1', 'one');
          port.offer('m2', 'two');
        }
      },
    });

    // Only the two real echoes, in order, each credited to its own message,
    // and user_input for m1 only once its own echo arrived.
    expect(of(turn.events, 'user_input').map((e) => e.data)).toEqual([{ message_id: 'm1' }, { message_id: 'm2' }]);
    const names = turn.events.map((e) => e.event);
    const meanwhile = turn.events.findIndex((e) => e.event === 'block_delta'
      && (e.data as { content?: string }).content === 'meanwhile');
    expect(meanwhile).toBeGreaterThan(-1);
    expect(names.indexOf('user_input')).toBeGreaterThan(meanwhile);
  });

  it('accounts for two messages the CLI folds into one echo', async () => {
    let offered = false;
    const turn = await runInputTurn({
      message: 'go',
      steps: [
        echo('go'), init, text('first', null), { waitInput: 3 },
        echo('one\n\ntwo'), init, text('answered'), result(), { waitEof: true },
      ],
      onEvent: (e, port) => {
        if (!offered && e.event === 'block_start') {
          offered = true;
          port.offer('m1', 'one');
          port.offer('m2', 'two');
        }
      },
    });

    expect(of(turn.events, 'user_input').map((e) => e.data)).toEqual([{ message_id: 'm1' }, { message_id: 'm2' }]);
    expect(turn.port.pending()).toEqual([]);
  });

  it('reads a message sent during a foreground step after that step (captured redirect)', async () => {
    const { steps, lines, opening, injected } = stepsFromFixture(FOREGROUND_BASH);
    expect(injected).toEqual(['stop and answer 6×7 instead']);

    const turn = await runInputTurn({ steps, message: opening, onEvent: offerAtStart(injected, []) });

    // The echo came after the command's own result, so user_input follows
    // the tool_result, and the assistant then answered it.
    const names = turn.events.map((e) => e.event);
    expect(names.indexOf('user_input')).toBeGreaterThan(names.indexOf('tool_result'));
    const answer = of(turn.events, 'block_delta')
      .map((e) => (e.data as { content?: string }).content ?? '')
      .join('');
    expect(answer).toContain('42');
    expect(turn.record.eofAt!).toBeGreaterThan(lineIndex(lines, (f) => f['type'] === 'user' && f['isReplay'] === true, true));
  });

  it('accepts a message while the main assistant waits on a foreground helper, read when it returns (captured)', async () => {
    const { steps, opening, injected } = stepsFromFixture(FOREGROUND_HELPER);
    expect(injected).toEqual(['stop and answer 6×7 instead']);
    const outcomes: Array<{ status: string }> = [];
    let stateWhenOffered: string | undefined;
    let lastState: string | undefined;

    const turn = await runInputTurn({
      steps,
      message: opening,
      onEvent: (e, port) => {
        if (e.event === 'main_state') lastState = (e.data as { state: string }).state;
        // Offered the moment the helper starts: the main assistant is blocked
        // on its Agent call from here until the helper hands back.
        if (outcomes.length === 0 && e.event === 'task' && (e.data as { phase: string }).phase === 'started') {
          stateWhenOffered = lastState;
          outcomes.push(port.offer('m1', injected[0]));
        }
      },
    });

    // Input open and the main assistant working: accepted, and written at once.
    expect(outcomes).toEqual([{ status: 'accepted' }]);
    expect(stateWhenOffered).toBe('working');
    expect(turn.record.frames).toHaveLength(2);
    // Read only once the helper's call returned: user_input comes after the
    // helper's last task event and after the Agent call's own tool_result.
    const started = of(turn.events, 'task')[0].data as { tool_use_id?: string; is_backgrounded?: boolean };
    expect(started.is_backgrounded).toBe(false);
    const callId = started.tool_use_id;
    expect(callId).toBeDefined();
    const names = turn.events.map((e) => e.event);
    const handBack = turn.events.findIndex((e) => e.event === 'tool_result'
      && (e.data as { tool_call_id?: string }).tool_call_id === callId);
    expect(handBack).toBeGreaterThan(-1);
    expect(names.indexOf('user_input')).toBeGreaterThan(handBack);
    expect(names.indexOf('user_input')).toBeGreaterThan(names.lastIndexOf('task'));
    const answer = of(turn.events.slice(names.indexOf('user_input')), 'block_delta')
      .map((e) => (e.data as { content?: string }).content ?? '')
      .join('');
    expect(answer).toContain('42');
  });

  it('builds one done from every result: the last one, with usage and num_turns summed', async () => {
    const { steps, lines, opening, injected } = stepsFromFixture(BACKGROUND_BASH);

    const turn = await runInputTurn({ steps, message: opening, onEvent: offerAtStart(injected, []) });

    const results = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((f) => f['type'] === 'result');
    expect(results).toHaveLength(3);
    const sum = (key: string) => results.reduce((n, r) => n + ((r['usage'] as Record<string, number>)[key]), 0);
    const done = of(turn.events, 'done');
    expect(done).toHaveLength(1);
    expect(turn.events[turn.events.length - 1].event).toBe('done');
    const data = done[0].data as DoneData;
    expect(data.num_turns).toBe(results.reduce((n, r) => n + (r['num_turns'] as number), 0));
    expect(data.usage).toEqual({
      input_tokens: sum('input_tokens'),
      output_tokens: sum('output_tokens'),
      cache_creation_input_tokens: sum('cache_creation_input_tokens'),
      cache_read_input_tokens: sum('cache_read_input_tokens'),
    });
    // The last result's own fields: it is the latest answer.
    expect(data.cost_usd).toBe(results[2]['total_cost_usd']);
    expect((data as Record<string, unknown>)['subtype']).toBe('success');
    expect(of(turn.events, 'error')).toHaveLength(0);
  });

  it('reports a failed last result as an error ahead of done', async () => {
    const turn = await runInputTurn({
      message: 'go',
      steps: [
        echo('go'), init, text('x'),
        line({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['overloaded'], session_id: 's1' }),
        // The real CLI exits 1 after an error result (2.1.283). A stand-in
        // that exited 0 here is what hid the exit-code branch reporting a
        // bare provider_error and an empty done in its place.
        { exit: 1 },
      ],
    });

    const names = turn.events.map((e) => e.event);
    expect(names.slice(-2)).toEqual(['error', 'done']);
    expect(of(turn.events, 'error')).toHaveLength(1);
    expect(of(turn.events, 'error')[0].data).toMatchObject({ code: 'provider_error', message: 'overloaded' });
    expect((of(turn.events, 'done')[0].data as DoneData)['subtype' as keyof DoneData]).toBe('error_during_execution');
  });

  it('reports a missing resumed session as session_lost, with usage, though the CLI exits 1', async () => {
    // The server re-issues a `session_lost` turn fresh, silently; as a
    // provider_error the person would see an error instead.
    const turn = await runInputTurn({
      message: 'go',
      cliSessionId: 'sess_gone',
      steps: [
        line({
          type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1', num_turns: 0,
          errors: ['No conversation found with session ID: sess_gone'],
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
        { exit: 1 },
      ],
    });

    expect(of(turn.events, 'error').map((e) => e.data)).toEqual([
      { code: 'session_lost', message: 'No conversation found with session ID: sess_gone' },
    ]);
    const done = of(turn.events, 'done');
    expect(done).toHaveLength(1);
    expect((done[0].data as DoneData).usage).toEqual({
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    });
  });

  it('keeps what a failed turn spent: usage and turns summed over every result, exit 1 or not', async () => {
    const turn = await runInputTurn({
      message: 'go',
      steps: [
        echo('go'), init, text('first'), result(), init, text('second'),
        result({ subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (2)'], num_turns: 2 }),
        { exit: 1 },
      ],
    });

    expect(of(turn.events, 'error')[0].data).toMatchObject({ code: 'provider_error' });
    const data = of(turn.events, 'done')[0].data as DoneData;
    expect(data.num_turns).toBe(3);
    expect(data.usage).toEqual({
      input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 8,
    });
  });

  it('still reports a CLI that died mid-turn, on a result that said all was well, as a crash', async () => {
    // stdin still open (a background task runs) and the last result a success:
    // nothing explains the exit, so it is not dressed up as a finished turn.
    const turn = await runInputTurn({
      message: 'go',
      steps: [echo('go'), init, taskStarted('t1', 'local_bash', true), text('started'), result(), { sleep: 50 }, { exit: 3 }],
    });

    expect(of(turn.events, 'error')[0].data).toMatchObject({ code: 'provider_error' });
    expect(turn.events.at(-1)!.event).toBe('done');
    // Reported as a crash, but with what it had spent.
    expect((of(turn.events, 'done')[0].data as DoneData).num_turns).toBe(1);
  });
});

describe('the port', () => {
  it('rejects before the CLI is running, and as ending once it has been ended', () => {
    const port = new TurnInputPort();
    expect(port.offer('a', 'hi')).toEqual({ status: 'rejected', reason: 'input_not_open' });

    const written: string[] = [];
    port.open((frame) => written.push(frame), () => {});
    expect(port.offer('b', 'hi')).toEqual({ status: 'accepted' });
    expect(written).toEqual([userMessageFrame('hi')]);

    // Ended by the adapter while the bridge still counts the turn as running:
    // the CLI may be alive, so the server must hold, not start a new turn.
    // (Once the bridge forgets the turn it answers turn_not_running itself.)
    port.end();
    expect(port.offer('c', 'hi')).toEqual({ status: 'rejected', reason: 'turn_ending' });
    // What was accepted and not read survives the end, for the terminal frame.
    expect(port.pending()).toEqual(['b']);
  });

  it('opens only at the CLI\'s first init: input_not_open before, accepted after', async () => {
    const outcomes: Array<{ status: string; reason?: string }> = [];
    const turn = await runInputTurn({
      message: 'go',
      steps: [
        echo('go'), { sleep: 100 }, init, text('first'),
        { waitInput: 2 }, echo('later'), init, text('second'), result(), { waitEof: true },
      ],
      onEvent: (e, port) => {
        // The spawn's `working` comes before init; the text block after it.
        if (outcomes.length === 0 && e.event === 'main_state') outcomes.push(port.offer('early', 'early'));
        if (outcomes.length === 1 && e.event === 'block_start') outcomes.push(port.offer('later', 'later'));
      },
    });

    expect(outcomes).toEqual([{ status: 'rejected', reason: 'input_not_open' }, { status: 'accepted' }]);
    expect(of(turn.events, 'user_input').map((e) => e.data)).toEqual([{ message_id: 'later' }]);
  });

  it('takes no message into a CLI that fails before it has a session', async () => {
    // A resumed session that is gone ends the process before init. A message
    // accepted into it would vanish: the turn is re-issued fresh without it.
    const outcomes: Array<{ status: string; reason?: string }> = [];
    const turn = await runInputTurn({
      message: 'go',
      cliSessionId: 'sess_gone',
      steps: [
        { sleep: 100 },
        line({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1',
          errors: ['No conversation found with session ID: sess_gone'] }),
        { exit: 1 },
      ],
      onEvent: (e, port) => {
        if (e.event === 'main_state' && outcomes.length === 0) outcomes.push(port.offer('m1', 'hello?'));
      },
    });

    expect(outcomes).toEqual([{ status: 'rejected', reason: 'input_not_open' }]);
    expect(turn.record.frames).toHaveLength(1);
    expect(of(turn.events, 'error')[0].data).toMatchObject({ code: 'session_lost' });
  });

  it('writes a message once, however often it is offered, and answers every retry as the first', () => {
    // An ack-timeout retry sends the same message_id again. Writing it twice
    // would have the assistant read it twice.
    const port = new TurnInputPort();
    expect(port.offer('m1', 'early')).toEqual({ status: 'rejected', reason: 'input_not_open' });
    const written: string[] = [];
    port.open((frame) => written.push(frame), () => {});

    // A rejection is not remembered: nothing was written, so it is judged afresh.
    expect(port.offer('m1', 'early')).toEqual({ status: 'accepted' });
    expect(port.offer('m1', 'early')).toEqual({ status: 'accepted' });
    expect(written).toEqual([userMessageFrame('early')]);
    expect(port.pending()).toEqual(['m1']);

    // Read, and then retried: still the first answer, still not written again.
    expect(port.shiftRead()).toBe('m1');
    expect(port.offer('m1', 'early')).toEqual({ status: 'accepted' });
    // Even after the turn has ended: it WAS delivered.
    port.end();
    expect(port.offer('m1', 'early')).toEqual({ status: 'accepted' });
    expect(written).toHaveLength(1);
    expect(port.pending()).toEqual([]);
  });

  it('rejects once the adapter closed stdin, even while the CLI is still finishing', async () => {
    const outcomes: Array<{ status: string; reason?: string }> = [];
    let closedAt = -1;
    await runInputTurn({
      message: 'go',
      steps: [echo('go'), init, text('done'), result(), { waitEof: true }, { sleep: 50 }],
      onEvent: (e, port) => {
        if (e.event === 'main_state' && (e.data as { state: string }).state === 'idle' && closedAt < 0) {
          // The terminal rule runs after the line; offer on the next tick.
          closedAt = 0;
          setImmediate(() => outcomes.push(port.offer('late', 'too late')));
        }
      },
    });

    // Ending, not over: the CLI is still finishing, and a new turn started
    // now would resume the session while it still writes to it.
    expect(outcomes).toEqual([{ status: 'rejected', reason: 'turn_ending' }]);
  });

  it('drops pending messages when the turn is stopped, and keeps them for the report', async () => {
    const controller = new AbortController();
    const turn = await runInputTurn({
      message: 'go',
      signal: controller.signal,
      steps: [echo('go'), init, taskStarted('t1', 'local_agent', true), text('working on it'), result(), { sleep: 5000 }],
      onEvent: (e, port) => {
        if (e.event === 'main_state' && (e.data as { state: string }).state === 'idle') {
          port.offer('p1', 'are you there?');
          setImmediate(() => controller.abort());
        }
      },
    });

    expect(turn.port.pending()).toEqual(['p1']);
    expect(turn.port.offer('p2', 'hello?')).toEqual({ status: 'rejected', reason: 'turn_ending' });
    // A stopped turn ends with a done, not an error — and the done still
    // says what the turn spent before it was stopped.
    expect(of(turn.events, 'error')).toHaveLength(0);
    expect(turn.events[turn.events.length - 1].event).toBe('done');
    expect((of(turn.events, 'done')[0].data as DoneData).usage).toEqual({
      input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4,
    });
  });

  it('keeps what the turn spent when a bound stops it', async () => {
    const turn = await runInputTurn({
      message: 'go',
      silenceTimeoutSeconds: 1,
      steps: [echo('go'), init, taskStarted('t1', 'local_bash', true), text('started'), result(), { sleep: 5000 }],
    });

    expect(of(turn.events, 'error')[0].data).toMatchObject({ code: 'silence_timeout_exceeded' });
    const data = of(turn.events, 'done')[0].data as DoneData;
    expect(data.usage).toEqual({
      input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4,
    });
    expect(data.num_turns).toBe(1);
  });
});

describe('a resumed session whose last turn left a background task running', () => {
  /**
   * The incident, frame for frame: a new input-open turn on a session whose
   * previous turn was stopped while its background command still ran. The CLI
   * answers that task's leftover notification FIRST — a stamped result, no
   * API call, num_turns 0 — and only after a pause takes in our opening
   * message and answers it. Built from the captured queued-notification turn
   * (its notification, stamped result, init, status, rate-limit frame and the
   * whole reply), with the opening's echo where --replay-user-messages puts it,
   * and the CLI then reading the message the test offers in the window.
   *
   * `notificationFirst` is the order that fixture was captured in (the
   * notification's result ahead of init); the default is the incident's,
   * init first.
   */
  function incident(opts: { notificationFirst?: boolean } = {}) {
    const frames = readFixture(QUEUED_NOTIFICATION);
    const [notification, stamped, initFrame, status, rateLimit, ...reply] = frames;
    expect(JSON.parse(stamped)).toMatchObject({ type: 'result', origin: { kind: 'task-notification' }, num_turns: 0 });
    const opening = 'What does the repo do? Look around first.';
    const injected = 'Also: what is the capital of France? One word.';

    const steps: Step[] = [];
    const written: string[] = [];
    const put = (raw: string): number => {
      steps.push({ line: raw });
      written.push(raw);

      return written.length - 1;
    };
    const putStep = (step: Step): number => put((step as { line: string }).line);

    if (opts.notificationFirst === true) {
      put(notification);
      put(stamped);
      put(initFrame);
    } else {
      put(initFrame);
      put(notification);
      put(stamped);
    }
    steps.push({ sleep: 40 });
    put(status);
    put(rateLimit);
    // The pause the incident had before the CLI read its prompt.
    steps.push({ sleep: 300 });
    const openingEcho = putStep(echo(opening));
    for (const raw of reply) {
      put(raw);
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (frame['type'] === 'result'
        || (frame['type'] === 'stream_event' && (frame['event'] as Record<string, unknown>)['type'] === 'message_delta')) {
        steps.push({ sleep: 40 });
      }
    }
    const firstUnstamped = written.length - 1;
    // Then the message offered in the window: a turn of the CLI's own for it.
    steps.push({ waitInput: 2 });
    putStep(init);
    putStep(echo(injected));
    putStep(text('Paris'));
    const lastResult = putStep(result());
    steps.push({ waitEof: true });

    return { steps, opening, injected, openingEcho, firstUnstamped, lastResult };
  }

  it.each([
    ['init first, as in the incident', false],
    ['the notification ahead of init, as captured', true],
  ])('does not close stdin before the opening is read (%s), and accepts a message in that window', async (_name, notificationFirst) => {
    const { steps, opening, injected, openingEcho, firstUnstamped, lastResult } = incident({ notificationFirst });
    const outcomes: Array<{ status: string; reason?: string }> = [];

    const turn = await runInputTurn({
      steps,
      message: opening,
      cliSessionId: 'sess_prev',
      onEvent: (e, port) => {
        // The rate-limit frame comes after the stamped result and before the
        // opening's echo: exactly the window in which the input used to be
        // closed already.
        if (e.event === 'rate_limit' && outcomes.length === 0) outcomes.push(port.offer('m1', injected));
      },
    });

    expect(outcomes).toEqual([{ status: 'accepted' }]);
    // Not closed at the stamped result, nor before the opening's echo, nor
    // before the reply's own (unstamped) result — and not before the offered
    // message was read and answered.
    expect(turn.record.eofAt).not.toBeNull();
    expect(turn.record.eofAt!).toBeGreaterThan(openingEcho);
    expect(turn.record.eofAt!).toBeGreaterThan(firstUnstamped);
    expect(turn.record.eofAt!).toBe(lastResult + 1);
    expect(of(turn.events, 'user_input').map((e) => e.data)).toEqual([{ message_id: 'm1' }]);
    expect(turn.port.pending()).toEqual([]);

    // main_state never said idle on the stamped result: the first idle is the
    // end of the reply, after its first block.
    expect(mainStates(turn.events)).toEqual(['working', 'idle', 'working', 'idle']);
    const firstIdle = turn.events.findIndex((e) => e.event === 'main_state'
      && (e.data as { state: string }).state === 'idle');
    expect(firstIdle).toBeGreaterThan(turn.events.map((e) => e.event).indexOf('block_start'));

    // The stamped result still counts in done, with every other one.
    const done = of(turn.events, 'done');
    expect(done).toHaveLength(1);
    // 0 for the notification, 3 for the reply, 1 for the offered message.
    expect((done[0].data as DoneData).num_turns).toBe(4);
    expect(of(turn.events, 'input_closed')).toHaveLength(1);
  });

  it('still closes after the unstamped result when the CLI never echoes the opening', async () => {
    // The fallback: a CLI that skipped (or folded) the echo. The unstamped
    // result answers our prompt, so the opening was read; waiting for an echo
    // that never comes would hang the turn until the silence bound.
    const turn = await runInputTurn({
      message: 'go',
      cliSessionId: 'sess_prev',
      steps: [
        init,
        result({ origin: { kind: 'task-notification' }, num_turns: 0 }), { sleep: 150 },
        text('hi'), { sleep: 150 },
        result(),
        { waitEof: true },
      ],
    });

    // Lines: init, stamped result (2) | text (3) | result (4). Not before it.
    expect(turn.record.eofAt).toBe(4);
    expect(mainStates(turn.events)).toEqual(['working', 'idle']);
    expect(of(turn.events, 'input_closed').map((e) => e.data)).toEqual([{ reason: 'idle' }]);
    expect(of(turn.events, 'done')).toHaveLength(1);
  });
});

describe('input_closed', () => {
  it('is sent once, when the terminal rule closes stdin: after the last idle, before done', async () => {
    const { steps, opening, injected } = stepsFromFixture(BACKGROUND_BASH);

    const turn = await runInputTurn({ steps, message: opening, onEvent: offerAtStart(injected, []) });

    const closed = of(turn.events, 'input_closed');
    expect(closed.map((e) => e.data)).toEqual([{ reason: 'idle' }]);
    const names = turn.events.map((e) => e.event);
    const at = names.indexOf('input_closed');
    expect(at).toBeGreaterThan(names.lastIndexOf('main_state'));
    expect(at).toBeGreaterThan(names.lastIndexOf('user_input'));
    expect(names.slice(at + 1)).toEqual(['done']);
  });

  it('comes with the port already ended: a message offered on it is answered turn_ending', async () => {
    const outcomes: Array<{ status: string; reason?: string }> = [];
    await runInputTurn({
      message: 'go',
      steps: [echo('go'), init, text('done'), result(), { waitEof: true }, { sleep: 50 }],
      onEvent: (e, port) => {
        if (e.event === 'input_closed') outcomes.push(port.offer('late', 'too late'));
      },
    });

    expect(outcomes).toEqual([{ status: 'rejected', reason: 'turn_ending' }]);
  });

  it('is not sent when the turn ends any other way', async () => {
    // Stopped by a cancel while a task runs: stdin was never closed by the rule.
    const controller = new AbortController();
    const cancelled = await runInputTurn({
      message: 'go',
      signal: controller.signal,
      steps: [echo('go'), init, taskStarted('t1', 'local_bash', true), text('working on it'), result(), { sleep: 5000 }],
      onEvent: (e) => {
        if (e.event === 'main_state' && (e.data as { state: string }).state === 'idle') setImmediate(() => controller.abort());
      },
    });
    // The CLI dying while a task still runs, so the rule never closed stdin.
    const failed = await runInputTurn({
      message: 'go',
      steps: [echo('go'), init, taskStarted('t1', 'local_bash', true), text('started'), result(), { sleep: 50 }, { exit: 3 }],
    });
    // And never on a turn that did not ask for input.
    const plain = await runInputTurn({ message: 'go', withPort: false, steps: [init, text('hi'), result()] });

    for (const turn of [cancelled, failed, plain]) {
      expect(of(turn.events, 'input_closed')).toHaveLength(0);
      expect(turn.events.at(-1)!.event).toBe('done');
    }
  });
});
