# Working on Sanadoq

Two repositories, one board:

| Repo                                                                   | What                       | Deploys to                          |
| ---------------------------------------------------------------------- | -------------------------- | ----------------------------------- |
| [Sanadoq-backend](https://github.com/ItsEgzix/Sanadoq-backend) (public) | NestJS + Prisma API        | https://sandoq-backend.vercel.app  |
| [Sanadoq-frontend](https://github.com/ItsEgzix/Sanadoq-frontend) (private) | Next.js app            | https://sanadoq.intellagent.my     |
| [Sanadoq board](https://github.com/users/ItsEgzix/projects/2)          | every task, both repos     | —                                   |

Pushing to `master` deploys to production within a minute. That is why
nothing reaches `master` except through a pull request with green CI.

## First day

1. **Accept the GitHub invitations** to both repositories (and to the board,
   if it came separately).
2. **Install** Node 24, Git, the GitHub CLI and Claude Code. Then:

   ```bash
   gh auth login
   gh auth refresh -s project      # lets the CLI and the skills move cards on the board
   ```

3. **Clone both repos side by side:**

   ```bash
   mkdir Sanadoq && cd Sanadoq
   gh repo clone ItsEgzix/Sanadoq-backend backend
   gh repo clone ItsEgzix/Sanadoq-frontend frontend
   ```

4. **Your database.** You get your own Neon branch — a copy of production
   that nothing else uses. The owner sends you its connection string
   privately. It holds the fund's real records: never paste it, or anything
   from it, into an issue, a commit, a test fixture or a chat.

5. **Backend:**

   ```bash
   cd backend
   cp .env.example .env
   # DATABASE_URL = your branch's pooled connection string
   # JWT_SECRET   = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   npm install
   npm run db:generate
   npm run db:migrate              # your branch only — catches it up with any newer migration
   npm run create:user -- --email you@example.org --name "Your Name" --apply   # prints a one-time password
   npm run start:dev               # http://localhost:5050
   ```

6. **Frontend** (second terminal):

   ```bash
   cd frontend
   npm install
   npm run dev                     # http://localhost:5000, talks to localhost:5050
   ```

   Sign in with the account from step 5.

7. **Read** the backend [README](README.md) (*How the books work* is the
   domain), then `AGENTS.md` in each repo.

## Every task

```
Board (Ready) → /start-task 42 → code → /open-pr → CI + Claude review → merge → Vercel deploys
```

1. **Pick** a card from **Ready** — or ask Claude: `/start-task`. It assigns
   you, creates the branch `42-short-name` linked to the issue, and moves the
   card to **In progress**.
2. **Build** it. Claude loads this repo's skills by itself; the rules that
   matter most are in `AGENTS.md`.
3. **Open the PR** with `/open-pr`: it runs the CI checks locally, fills the
   template, labels it, moves the card to **In review**, and opens the
   follow-up issue in the other repo if the API changed.
4. **CI** must be green. **Claude** reviews the PR once it opens; ask for
   another pass with `@claude review`. A person reads it too.
5. **Merge** with *Squash and merge*. The issue closes, the card moves to
   **Done**, the branch is deleted, Vercel deploys.
6. **Migrations** (`migration` label): after the merge, *Migrate production
   database* waits in the Actions tab until the owner approves it. The task
   is done once it has run.

New work goes on the board with `/new-task` (or the issue forms). Questions
only the fund can answer become draft cards titled `Decision: …`.

## Rules everyone keeps

- No pushes to `master` — branch, PR, green CI. (The backend enforces it;
  the frontend relies on us.)
- Nothing you run touches production. Migrations reach Neon only through the
  approved workflow; scripts run against your own branch.
- A change to an API shape is two PRs: backend first (label `api-contract`),
  frontend after the backend has deployed.
- Every message exists in English and Arabic, on both sides.
- The workbook and anything copied from it stay off GitHub. This repo is
  public.

## Labels

| Label            | Means                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| `feature`        | new behaviour                                                         |
| `bug`            | wrong behaviour or a wrong figure                                     |
| `chore`          | tooling, dependencies, refactors with no behaviour change             |
| `documentation`  | docs only                                                             |
| `migration`      | adds a database migration — needs approval after merge                |
| `api-contract`   | changes a shape the other repo reads — needs the matching PR there    |
| `i18n`           | English/Arabic text                                                   |
| `needs-decision` | waiting on the fund; not Ready until answered                         |
| `dependencies`   | Dependabot's monthly update                                           |
