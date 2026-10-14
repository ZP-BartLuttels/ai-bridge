/**
 * `ai_request.options.effort` — the Claude thinking level.
 *
 * A level in CLAUDE_EFFORT_LEVELS becomes `--effort <level>`, on a fresh turn
 * and on a resumed one; any other value is dropped and the turn runs as if the
 * option were absent; no option means no flag. Codex and Gemini ignore it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import { CodexAdapter } from '../../src/providers/codex.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { CLAUDE_EFFORT_LEVELS, resolveClaudeEffort } from '../../src/providers/claude-effort.js';
import type { AdapterStreamEvent, ExecutionContext } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

let workingDir: string;

beforeAll(() => {
  workingDir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-effort-')));
});

afterAll(() => {
  rmSync(workingDir, { recursive: true, force: true });
});

async function launch(
  AdapterClass: new () => ClaudeAdapter | CodexAdapter | GeminiAdapter,
  options: Record<string, unknown>,
  cliSessionId: string | null = null,
): Promise<string[]> {
  let recorded: string[] = [];

  class Probe extends (AdapterClass as new () => ClaudeAdapter) {
    protected override spawnCli(
      _command: string,
      args: string[],
      env: NodeJS.ProcessEnv,
      stdinInput?: string,
      cwd?: string,
    ): ChildProcessByStdio<Writable | null, Readable, Readable> {
      recorded = args;
      return spawn(process.execPath, ['-e', ''], {
        env,
        cwd,
        stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
  }

  const request = {
    type: 'ai_request',
    request_id: 'req_effort',
    conversation_id: 'conv_1',
    provider: 'x',
    message: 'think about it',
    system_prompt: null,
    options,
    cli_session_id: cliSessionId,
  } as AiRequestMessage;

  const context: ExecutionContext = {
    request,
    requestId: request.request_id,
    tools: [],
    mcp: null,
    cliIsolation: 'workspace',
    workingDir,
    signal: new AbortController().signal,
    requestTimeoutSeconds: 30,
    silenceTimeoutSeconds: 0,
    cliSessionId,
    attachmentDir: null,
    bridgeEnv: {},
    bridgeAddendum: null,
  };

  await new Probe().execute(context, (_e: AdapterStreamEvent) => undefined);
  return recorded;
}

function effortOf(args: string[]): string | null {
  const i = args.indexOf('--effort');
  return i >= 0 ? args[i + 1]! : null;
}

describe('resolveClaudeEffort()', () => {
  it('takes exactly the five levels claude --effort accepts', () => {
    expect([...CLAUDE_EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const level of CLAUDE_EFFORT_LEVELS) expect(resolveClaudeEffort(level)).toBe(level);
  });

  it('ignores anything else instead of failing', () => {
    for (const v of ['HIGH', 'ultra', ' high', 'high; rm -rf /', 3, true, {}, ['high']]) {
      expect(resolveClaudeEffort(v)).toBeNull();
    }
  });

  it('treats absent, null and empty as not asked', () => {
    expect(resolveClaudeEffort(undefined)).toBeNull();
    expect(resolveClaudeEffort(null)).toBeNull();
    expect(resolveClaudeEffort('')).toBeNull();
  });
});

describe('claude --effort', () => {
  it('passes a valid level on a fresh turn, beside --model', async () => {
    const args = await launch(ClaudeAdapter, { model: 'sonnet', effort: 'xhigh' });
    expect(effortOf(args)).toBe('xhigh');
    expect(args).toContain('--model');
    expect(args).not.toContain('--resume');
  });

  it('passes it on a resumed turn too', async () => {
    const args = await launch(ClaudeAdapter, { effort: 'max' }, '11111111-2222-3333-4444-555555555555');
    expect(args).toContain('--resume');
    expect(effortOf(args)).toBe('max');
  });

  it('drops an invalid level and still runs the turn', async () => {
    const args = await launch(ClaudeAdapter, { effort: 'ultra' });
    expect(args.length).toBeGreaterThan(0);
    expect(args).not.toContain('--effort');
    expect(args.join(' ')).not.toContain('ultra');
  });

  it('leaves the arguments exactly as before when the option is absent', async () => {
    const without = await launch(ClaudeAdapter, {});
    const withNull = await launch(ClaudeAdapter, { effort: null });
    expect(without).not.toContain('--effort');
    // The MCP config path differs per turn; everything else must be identical.
    const strip = (a: string[]): string[] => a.map((x) => (x.includes(tmpdir()) ? '<tmp>' : x));
    expect(strip(withNull)).toEqual(strip(without));
  });

  it('is ignored by Codex and Gemini', async () => {
    expect((await launch(CodexAdapter, { effort: 'high' })).join(' ')).not.toContain('effort');
    expect((await launch(GeminiAdapter, { effort: 'high' })).join(' ')).not.toContain('effort');
  });
});
