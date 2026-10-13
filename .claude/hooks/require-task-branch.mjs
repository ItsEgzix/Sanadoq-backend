/**
 * PreToolUse guard for Claude's file tools (Edit, Write, MultiEdit,
 * NotebookEdit): a file tracked in a Sanadoq repository cannot be changed
 * while that repository is on master. Work starts from an issue and the
 * branch linked to it (the work-protocol skill); this turns skipping that
 * step from a slip into a clear refusal, with the way forward in the reason.
 *
 * Allowed through: files outside a git repository or in a repository that is
 * not ItsEgzix/Sanadoq-*, files git ignores (.env, .env.local), any branch but
 * master/main, and sessions started with SANADOQ_ALLOW_MASTER=1 (the owner's
 * emergency hatch — it does not get past the backend's branch ruleset).
 *
 * Self-contained so it runs from either repository, and from a parent folder
 * through .claude/parent-folder.settings.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const allow = () => process.exit(0);

if (process.env.SANADOQ_ALLOW_MASTER === '1') allow();

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  // Unreadable input is Claude Code's problem to report, not a reason to
  // block every edit in the session.
  allow();
}

const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (typeof target !== 'string' || target === '') allow();

const file = resolve(input.cwd ?? process.cwd(), target);

// Write creates new folders, so walk up to one that exists for git to run in.
let dir = dirname(file);
while (!existsSync(dir)) {
  const parent = dirname(dir);
  if (parent === dir) allow();
  dir = parent;
}

const git = (...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

let origin;
let branch;
try {
  origin = git('remote', 'get-url', 'origin');
  branch = git('branch', '--show-current');
} catch {
  allow(); // not a git repository, or one without an origin
}

if (!/ItsEgzix\/Sanadoq-/i.test(origin)) allow();
if (branch !== 'master' && branch !== 'main') allow();

try {
  // Exit 0 means ignored: local-only files such as .env never reach a PR.
  git('check-ignore', '-q', file);
  allow();
} catch {
  // Not ignored (exit 1) — fall through and refuse.
}

const repo = origin.replace(/^.*ItsEgzix\//i, 'ItsEgzix/').replace(/\.git$/, '');
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Sanadoq protocol: ${repo} is on ${branch}, and changes never start there. ` +
        'Load the work-protocol skill: find the matching issue on the Sanadoq board or file one, ' +
        'then switch to its branch (gh issue develop <N> --base master --name "<N>-<slug>" --checkout) ' +
        'and make this edit there. Ignored local files such as .env are not affected.',
    },
  }),
);
process.exit(0);
