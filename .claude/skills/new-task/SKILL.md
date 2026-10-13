---
name: new-task
description: File work on the Sanadoq board — a feature, bug, chore, or an open question for the fund — as a GitHub issue in the right repo (or a private draft card for fund decisions), with acceptance criteria, labels, Priority and Size set. Use when the user says "add a task", "file a bug", "put this on the board", "we should remember to…", or invokes /new-task.
argument-hint: "<what needs doing, in a sentence>"
---

# File a task

```bash
PROJECT_ID=PVT_kwHOCYkjcc4Bm1Yz
STATUS_FIELD=PVTSSF_lAHOCYkjcc4Bm1YzzhlcviM      # Backlog=f75ad846 Ready=726bcb13
PRIORITY_FIELD=PVTSSF_lAHOCYkjcc4Bm1YzzhlcwIw    # P0=6fd6f73a P1=0b4846e9 P2=27ad7a8d P3=8e9562f7
SIZE_FIELD=PVTSSF_lAHOCYkjcc4Bm1YzzhlcwJA        # S=37443025 M=4166a6fc L=97c828b0
```

## 1. Where it goes

| It is…                                                         | Goes to                                                |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| API, database, migration, import script, server rule           | issue in `ItsEgzix/Sanadoq-backend` — **public**       |
| screen, layout, wording, client behaviour                      | issue in `ItsEgzix/Sanadoq-frontend` — private         |
| both                                                           | one issue in each, backend first, linked to each other, both labelled `api-contract` |
| a question only the fund can answer (a money rule, a policy)   | a **draft card** on the board, title starting `Decision:`, label nothing |

The backend repo is public. Its issues never carry real names, account
numbers, amounts from the books, or anything copied from the workbook —
describe the rule, and put specifics in a frontend issue or a draft card.

## 2. Write it

Use the issue form's shape so the board reads the same everywhere:

- **Title** — what changes, in the user's words ("Expense lines can have a
  category"), not the implementation.
- **What and why** — the problem and who has it.
- **Acceptance criteria** — a short checklist someone else could verify.
- **Notes** — files, links, the related issue in the other repo.

Ask the user only for what you cannot infer. If the rule for the money is
not settled, file it with `needs-decision` and leave it in Backlog.

## 3. Create and place it

```bash
gh issue create -R <repo> --title "<title>" --body-file <body.md> \
  --label <feature|bug|chore|documentation>[,needs-decision][,api-contract] --project "Sanadoq"
URL=<printed issue URL>
ITEM=$(gh project item-add 2 --owner ItsEgzix --url "$URL" --format json --jq .id)
gh project item-edit --project-id $PROJECT_ID --id "$ITEM" --field-id $PRIORITY_FIELD --single-select-option-id <priority>
gh project item-edit --project-id $PROJECT_ID --id "$ITEM" --field-id $SIZE_FIELD --single-select-option-id <size>
```

A fund decision:

```bash
gh project item-create 2 --owner ItsEgzix --title "Decision: <question>" --body "<context and the options>"
```

New cards land in **Backlog**. Move one to **Ready** only when its
acceptance criteria are clear and nothing is waiting on a decision:

```bash
gh project item-edit --project-id $PROJECT_ID --id "$ITEM" --field-id $STATUS_FIELD --single-select-option-id 726bcb13
```

Priority: P0 = the fund cannot work or a figure is wrong in production ·
P1 = next · P2 = planned · P3 = nice to have. Size: S < half a day · M = a
day or two · L = more — suggest splitting an L into sub-issues.

Report the issue URL(s) back to the user.
