Closes #

## What and why

<!-- What changes for the fund, and why. Link the frontend PR or issue if there is one. -->

## How I checked it

- [ ] CI green (lint, types, unit tests, build, migrations on a fresh Postgres, schema drift, e2e)
- [ ] Ran it for real against my own Neon branch: <!-- the endpoint called / the script run / the page clicked -->

## Checklist

- [ ] Every new success/error code is in `src/i18n/en` **and** `src/i18n/ar`
- [ ] README tables (API, env, layout) updated if routes, env vars or folders changed
- [ ] No real names, account numbers or workbook figures (this repo is public)
- [ ] **Migration?** Labelled `migration`, opens with its comment block, `schema.prisma` matches, and it is safe while the current production code keeps running (expand → deploy → contract). After merge, approve *Migrate production database*.
- [ ] **API shape changed?** Labelled `api-contract`, frontend issue/PR: <!-- link -->

## Not verified

<!-- Say plainly what you did not check. "Nothing" is a valid answer. -->
