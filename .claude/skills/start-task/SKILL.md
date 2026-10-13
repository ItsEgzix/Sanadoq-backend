---
name: start-task
description: >-
  Start work on a Sanadoq issue — read it, assign yourself, create the branch linked to the issue, move its card to "In progress" on the Sanadoq board, and plan before coding. Use when the user says "start #12", "pick up issue 12", "what should I work on next", or invokes /start-task.
argument-hint: "<issue number> — or nothing, to pick the top Ready card"
---

# Start a task

The board is GitHub Project **Sanadoq** (`https://github.com/users/ItsEgzix/projects/2`),
shared by `ItsEgzix/Sanadoq-backend` (public) and `ItsEgzix/Sanadoq-frontend`
(private). Columns: Backlog → Ready → In progress → In review → Done.

```bash
PROJECT_ID=PVT_kwHOCYkjcc4Bm1Yz
STATUS_FIELD=PVTSSF_lAHOCYkjcc4Bm1YzzhlcviM
IN_PROGRESS=325cb76e
```

If an ID stops working (someone renamed a field), re-read them with
`gh project field-list 2 --owner ItsEgzix --format json` and fix this file.

## 1. Choose the issue

With a number, use it. Without one, list what is ready, highest priority
first, and ask the user which to take:

```bash
gh project item-list 2 --owner ItsEgzix --format json --limit 300 \
  --jq '.items[] | select(.status=="Ready") | {number: .content.number, repo: .content.repository, title, priority, size, assignees}'
```

The issue must belong to **this** repo (`gh repo view --json nameWithOwner -q .nameWithOwner`).
If it belongs to the other one, say so and stop.

## 2. Read it properly

```bash
gh issue view <N> --comments
```

If the acceptance criteria are missing or a decision is still open (label
`needs-decision`), stop and say what is unclear — do not guess a rule for
the fund's money.

## 3. Branch, assign, move the card

The working tree must be clean (`git status --porcelain` empty); if it is
not, ask the user before going on.

```bash
git switch master && git pull --ff-only
gh issue develop <N> --base master --name "<N>-<three-to-five-word-slug>" --checkout
gh issue edit <N> --add-assignee @me
URL=$(gh issue view <N> --json url -q .url)
ITEM=$(gh project item-add 2 --owner ItsEgzix --url "$URL" --format json --jq .id)   # returns the existing card if already on the board
gh project item-edit --project-id $PROJECT_ID --id "$ITEM" --field-id $STATUS_FIELD --single-select-option-id $IN_PROGRESS
```

`gh issue develop` links the branch to the issue, so the PR opened from it
closes the issue on merge and the board moves the card by itself.

## 4. Plan before code

Load this repo's skills (see AGENTS.md — `backend-style` + `sanadoq-backend`,
or `sanadoq-frontend`). Then tell the user, briefly:

- the acceptance criteria as you understand them;
- the files you expect to touch, and the nearest existing file of each kind
  you will copy the shape of;
- anything on the other side of the API: a backend shape change needs a
  frontend issue (label `api-contract`); a frontend task that needs a new
  endpoint waits for the backend PR to merge and deploy first;
- for backend work, whether it needs a migration (and that it will be
  expand-safe).

Wait for a go-ahead if the plan changes behaviour the issue did not describe.
