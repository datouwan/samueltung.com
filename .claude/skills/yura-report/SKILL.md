---
name: yura-report
description: Refresh YURA HQ (/ailab/pet/hq/) — the startup operating hub — from project memory and repo activity, then verify and deploy. Run manually or on a schedule; also run after any meaningful YURA work session.
---

# /yura-report — refresh YURA HQ

You are refreshing the operating hub of the YURA project (robot companion pet,
mission: profitable product). The hub is `public/ailab/pet/hq/index.html` on
samueltung.com. The project memory is `public/ailab/pet/CLAUDE.md` — read it
first; it is the source of truth for tool statuses, decisions, and conventions.

## Steps

1. **Gather state.**
   - Read `public/ailab/pet/CLAUDE.md` (tool suite table, decision log, known issues).
   - Read the current HQ page and note its `updated YYYY-MM-DD` date in the kicker.
   - `git log --oneline --since=<that date>` for `public/ailab/pet`, `tools/yura`,
     and `.claude/skills/yura-*` to find what happened since the last refresh.

2. **Update the HQ page** (`public/ailab/pet/hq/index.html`) — edit in place,
   keep the existing design tokens and section structure:
   - Kicker and footer dates → today.
   - **Scoreboard**: recompute real values (tools shipped, dossier pages, pelt
     series, waitlist count once T3 exists — read it from its KV/log, never
     invent numbers). Leave "—" for anything not yet measurable.
   - **Roadmap**: move phase chips (`done` / `now`) only when the phase's gate
     evidence actually exists; record gate evidence in the milestone log.
   - **Workstreams**: sync statuses with the CLAUDE.md tool table.
   - **Open decisions**: drop resolved ones (move the resolution to the
     milestone log + CLAUDE.md decision log), add new ones.
   - **Milestone log**: prepend dated entries for anything meaningful since the
     last refresh (newest first). Keep entries one sentence, concrete.

3. **Sync memory.** Mirror any status/decision changes into
   `public/ailab/pet/CLAUDE.md` (tool table statuses + decision log). The two
   files must never disagree.

4. **Verify.** All four dossier pages must have the identical 4-tab pill nav
   (Concept / Market / Components / HQ). If `public/ailab/pet/index.html` was
   touched, execute its inline script per the CLAUDE.md verify rule (Node
   harness, not just a lint). Confirm `public/.assetsignore` still excludes
   `**/CLAUDE.md`.

5. **Deploy.** `npx wrangler deploy` from the repo root, then confirm
   `https://samueltung.com/ailab/pet/hq/` responds (it is behind the site's
   Basic Auth — a 401 without credentials is the expected healthy response).

6. **Report back** to the user in one short paragraph: what changed on the hub,
   anything that moved phase, and the single most important next action.

## Rules

- Never invent metrics; an honest "—" beats a fabricated number.
- Never edit the market/concept/components content from this skill — this skill
  only operates the HQ page and memory. Content changes are their own tasks.
- This page is the startup's heartbeat: if a refresh finds nothing changed,
  say so and change only the dates.
