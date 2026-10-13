---
name: open-pr
description: Finish a Sanadoq task and open its pull request — run the same checks CI runs, review the diff, commit, push, open the PR with the template filled in and the right labels (migration, api-contract, i18n), move the card to "In review", open the follow-up issue in the other repo when the API contract changed, and watch CI. Use when the user says "open a PR", "ship it", "I'm done with this", or invokes /open-pr.
argument-hint: "(optional) anything the PR description should mention"
---

# Open a pull request

```bash
PROJECT_ID=PVT_kwHOCYkjcc4Bm1Yz
STATUS_FIELD=PVTSSF_lAHOCYkjcc4Bm1YzzhlcviM
IN_REVIEW=47fc9ee4
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

Never open a PR from `master`. The branch name starts with the issue number
(`42-expense-categories`) when `start-task` made it.

## 1. Run what CI runs — fix before pushing

Backend (`Sanadoq-backend`):

```bash
npm run lint && npx tsc --noEmit && npm test
npm run test:e2e        # when main.ts, app.module.ts, a guard, filter, interceptor or route order changed
npm run build
```

Frontend (`Sanadoq-frontend`):

```bash
npm run lint && npx tsc --noEmit && npm run build
```

## 2. Review your own diff

```bash
git fetch origin master
git diff --stat origin/master...HEAD
git diff origin/master...HEAD
```

Read it as the reviewer will, against this repo's skills. Look hardest for:
a code or text missing from one language; money computed or summed where it
should only be displayed; a migration that breaks the code now in
production; anything from the workbook or a real person's name in a public
file. For a larger change, run `/code-review` too.

## 3. Commit and push

Commit messages: a subject in the imperative, at most 72 characters, then a
blank line and a body that says **why** (what was wrong, what the fund asked
for). One logical change per commit.

```bash
git push -u origin HEAD
```

## 4. Labels from what changed

```bash
git diff --name-only origin/master...HEAD
```

| Changed                                                                  | Label          |
| ------------------------------------------------------------------------ | -------------- |
| `prisma/migrations/**`                                                   | `migration`    |
| a route, a DTO, or a response's shape (backend) / `lib/api.ts` or `lib/types.ts` relying on an unmerged backend change (frontend) | `api-contract` |
| `src/i18n/**` or `lib/i18n/**`                                           | `i18n`         |
| plus the issue's type label                                              | `feature`, `bug`, `chore`, `documentation` |

## 5. Open it

Fill `.github/pull_request_template.md` — every section, no placeholders left.
`Closes #<N>` must be the first line so the merge closes the issue and the
card moves to Done.

```bash
gh pr create --base master --title "<subject line>" --body-file <filled-template> --label <labels> --assignee @me
```

Then move the card (the board also does this when the PR links, but do not
rely on timing):

```bash
URL=$(gh issue view <N> --json url -q .url)
ITEM=$(gh project item-add 2 --owner ItsEgzix --url "$URL" --format json --jq .id)
gh project item-edit --project-id $PROJECT_ID --id "$ITEM" --field-id $STATUS_FIELD --single-select-option-id $IN_REVIEW
```

## 6. The other repo

- **Backend PR labelled `api-contract`:** open the frontend issue now, in
  plain words (what changed, the new shape, which screens read it), and link
  both ways:

  ```bash
  gh issue create -R ItsEgzix/Sanadoq-frontend --title "<what the UI must follow>" \
    --body "Backend change: <backend PR URL>. <new shape and affected screens>" \
    --label api-contract --project "Sanadoq"
  ```

  Mention the new issue in the PR description.
- **Frontend PR that needs an unmerged backend PR:** write `Depends on
  ItsEgzix/Sanadoq-backend#<PR>` in the description. Merge the backend first
  and wait for its Vercel deploy before merging the frontend.

## 7. Watch CI

```bash
gh pr checks --watch
```

Fix failures on the branch and push again. Claude's automatic review posts
on the PR when it is configured; answer or fix each point.

## 8. Merging

Only when the user asks, CI is green, and review is done:

```bash
gh pr merge --squash --delete-branch
```

A PR labelled `migration` is not finished at merge: the run *Migrate
production database* waits for the owner's approval in the Actions tab.
Tell the user to approve it, and only call the task done after it succeeds.
