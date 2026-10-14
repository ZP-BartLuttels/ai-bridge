/**
 * `ai_request.options.effort` — the Claude "thinking level", passed to the CLI
 * as `--effort <level>`.
 *
 * Only the levels below are passed. Anything else is dropped with a debug line
 * and the turn runs exactly as it would without the option: an unknown level
 * must never fail a turn, and the bridge does not guess what a server meant.
 * Verified on Claude Code 2.1.287, which accepts all five levels, also together
 * with `--resume`. Advertised as `hello.effort_levels`. Codex and Gemini ignore it.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('ClaudeAdapter');

/** The levels `claude --effort` takes, in increasing order; sent as `hello.effort_levels`. */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/**
 * The level to pass for `options.effort`, or null for none. Absent, null and
 * empty mean "not asked"; any other value outside CLAUDE_EFFORT_LEVELS is
 * ignored (logged at debug), never an error.
 */
export function resolveClaudeEffort(value: unknown): ClaudeEffortLevel | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value)) {
    return value as ClaudeEffortLevel;
  }
  log.debug('Ignoring unsupported options.effort', {
    effort: typeof value === 'string' ? value.slice(0, 64) : typeof value,
  });
  return null;
}
