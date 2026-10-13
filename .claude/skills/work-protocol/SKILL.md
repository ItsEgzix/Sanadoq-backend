---
name: work-protocol
description: >-
  MANDATORY for any request to build, add, change, fix, refactor, rename or remove anything in a Sanadoq repo — code, migrations, screens, wording, docs — even a one-line fix, and even when the request does not mention an issue or a branch. Load it before exploring code for the task and before editing any file. Runs the team protocol end to end for the developer: finds the matching issue on the Sanadoq board or files one, creates the linked branch, plans, builds with the repo's skills, verifies, opens the PR, moves the card and watches CI. Not for questions or explanations that change nothing.
---

# The work protocol

Every change reaches `master` the same way:

```
issue on the board → branch linked to it → commits → PR → green CI + review → squash-merge → Vercel deploys
```

**You run all of it.** The developer says what they want in their own words
("expense lines need a category"); you do the bookkeeping, ask only what you
cannot decide, and hand back a PR ready for review. They should never have to
type a `gh` or `git` command or remember a step.

This skill is the conductor. The steps reuse three smaller skills — load each
when you reach it: `new-task` (filing), `start-task` (branch and card),
`open-pr` (shipping).

## 0. Does it apply?

Yes for any change to a file git tracks, however small, including docs and
config. No for questions, explanations, reviews that change nothing, and
gitignored local files (`.env`, `.env.local`). When unsure, it applies.

A hook refuses edits to tracked files while the repo is on `master`. If you
hit it, you skipped a step: come back here.

## 1. Orient — quietly, no questions yet

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
git branch --show-current
git status --porcelain
```

- **Which repo(s)?** API, database, migrations, import scripts → backend.
  Screens, wording, client behaviour → frontend. Both → section 7.
- **Already on a task branch** (`<N>-…`) whose issue is this request → resume
  where the work stands (build, or ship).
- **On a task branch for a different issue**, with uncommitted work → ask
  whether to commit it there first or set it aside; never carry it over.
- **`gh` cannot touch the board** (an error mentioning `project` scope) → ask
  the developer to run `gh auth refresh -s project` once, then continue.

## 2. Find the issue

Search before filing — two people file the same idea otherwise:

```bash
gh issue list --state open --limit 20 --search "<2–4 key words>" --json number,title,assignees,labels,url
gh project item-list 2 --owner ItsEgzix --format json --limit 300 \
  --jq '.items[] | select(.status != "Done") | {number: .content.number, repo: .content.repository, title, status, assignees}'
```

| What you find                                        | Do                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| One clear match in this repo                         | Use it. Say so in one line: "Working from #12 — …".             |
| A few plausible matches                              | Show them (number + title) and ask which, or whether it is new. |
| A match assigned to someone else, or In progress     | Ask before taking it over.                                      |
| A match labelled `needs-decision`                    | Stop: say what the fund still has to decide.                    |
| Nothing                                              | File it (section 3).                                            |

## 3. File it when nothing matches

Follow `new-task`, writing the issue **yourself** from the request:

- title in the developer's words; *What and why*; *Acceptance criteria* you
  derive from the request and the codebase (include "messages/words in
  English and Arabic" whenever text changes);
- labels, Priority (P2 unless they said it is urgent or broken in
  production), Size from your estimate;
- the backend repo is **public** — no real names, account numbers or figures.

Show the title and criteria in two or three lines and carry on — do not wait
for approval unless something is genuinely undecided. A money or policy rule
nobody has settled is undecided: file it with `needs-decision`, stop, and
tell the developer what to ask the fund.

## 4. Start it

Follow `start-task` section 3: linked branch via `gh issue develop`, assign
the developer (`@me`), card → **In progress**.

Then plan in a few lines (files to touch, the existing file you will copy
the shape of, tests). **Carry on without waiting** when the plan does only
what the issue says. **Stop and ask** before:

- choosing a rule about money or the books that the issue and README do not settle;
- a migration that drops, renames or rewrites data;
- changing an API shape the other repo reads;
- removing behaviour someone may rely on;
- anything bigger than the issue's Size suggests — offer to split it.

## 5. Build

- Load the repo's own skills first (`AGENTS.md` lists them: `backend-style`
  + `sanadoq-backend`, or `sanadoq-frontend`) and follow them.
- Commit as you reach working steps — subject in the imperative (≤ 72
  chars), body saying why. Never commit to `master`.
- Keep to the issue. Note other problems you notice for the PR or a new
  issue (`new-task`); do not fix them in passing.

## 6. Verify — like CI, and for real

- Run what CI runs (the commands are in `open-pr` step 1) and fix failures.
- Exercise the change: backend — run it against the developer's own Neon
  branch and call the endpoint or run the script; frontend — open the page in
  the browser in **English and Arabic**, desktop and phone width.
- Anything you could not check goes in the PR's *Not verified*.

## 7. When the change spans both repos

1. Two issues — backend first — each linking the other, both `api-contract`.
2. Backend: sections 4–8 until its PR is open and green.
3. Frontend (in `../frontend`): its own branch from `master`, built against
   the backend branch running locally; PR says
   `Depends on ItsEgzix/Sanadoq-backend#<PR>`.
4. Merge order for the humans: backend, wait for its Vercel deploy (and the
   migration approval, if any), then frontend.

## 8. Ship

Follow `open-pr` all the way: checks, self-review of the diff, push, PR from
the template with `Closes #<N>`, labels, card → **In review**, the other
repo's issue if the API changed, then `gh pr checks --watch`.

- CI red → fix on the branch, push, watch again until green.
- Claude's automatic review comments arrive a few minutes after the PR opens:
  fix what is right, reply where you disagree and say why.

## 9. Hand back

Tell the developer, briefly:

- the issue and PR links, and what changed for the fund;
- what you verified, and what you did not;
- what is left for people: a review, the merge (**you never merge unless they
  ask**), and approving *Migrate production database* if the PR has a migration.

## Never

- edit tracked files on `master`, push to `master`, or force-push;
- skip the issue "because it is small";
- run migrations or data scripts against production — only the developer's own Neon branch;
- put real names, account numbers or figures from the workbook in the public repo.
