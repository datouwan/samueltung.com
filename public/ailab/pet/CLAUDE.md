# YURA — project memory

YURA is a robot companion pet (working name): a furry, non-verbal creature whose pitch is
"smarter than Moflin — without breaking the spell." This folder holds the three-page
concept dossier; this file is the persistent memory and working agreement for everything
YURA — read it before touching anything in `public/ailab/pet/`.

**Mission: turn YURA from a concept dossier into a profitable product.** Every tool,
page, and analysis added here should serve that goal. The current business thesis (from
`market/index.html`, concept-stage estimates, July 2026):

- **Price:** $449 D2C hardware + optional $9/mo "Deep Bond" subscription.
- **Cost:** BOM ≈ $191–264 → ~$214–269 landed COGS ($240 midpoint, mono-split eyes +
  auto-dock nest; stereo would add ~$10). Gross ~$180–235/unit (40–52%); subscription
  runs 70–80% margin ($1.50–3.00/mo cloud cost).
- **Scenarios:** Bear 5k units/yr = −$1.8M (fails fast). Base 20k/yr (Moflin parity) =
  +$1.2M at midpoints, spanning break-even (worst-cost corner) to +$2.3M — thin and
  assumption-sensitive. Bull 100k/yr = +$15–19M operating. **Robust-profitability gate
  (positive even at the worst-cost corner): ~30–40k units/yr or >40% subscription
  attach.** ~$2–4M NRE before unit one.
- **Structural read:** hardware keeps the lights on; the business lives in the
  subscription.
- **Next physical step:** home works-like prototype (Phase 0 puppet dropped 2026-07-30 —
  Samuel's Moflin is the live reference). Stage A "presence blob" $247–429 → Stage B
  comprehension +$35–40 (+$5–15/mo API) → Stage C glide +$115–217; $397–686 all-in.
  Chassis via online print service (no printer at home): MJF PA12 rigid, TPU 95A
  compliant. Plan on the Proto page; parts in `yura` repo `tools/proto-kit/`.
- **Key comps:** Moflin ($429, sells out — proof of demand), KEYi Loona ($450 — proof
  the BOM is feasible), Lovot (D2C playbook), and the graveyard (Aibo, Jibo, Vector,
  Cozmo — retention past month 3 is the real gate, not launch demand).

## Dossier map

Password-gated (site-wide Basic Auth in `src/index.js`; secret `SITE_PASSWORD`).

| Page | Path | Covers |
|---|---|---|
| Concept / Design | `index.html` | Species fiction, frond language, moods, three nervous systems, spec, positioning, risks, Phase 0 plan |
| Market study | `market/index.html` | TAM, competitors, uniqueness, $449 scenarios, BOM/unit economics, forces, sources |
| Prototype plan | `proto/index.html` | Home works-like build: stages A/B/C with gates, parts kit, print-service guidance, safety rules |
| Components | `components/index.html` | Exploded stack, parts breakdown, buses/power, two-brain split, DFA rules |
| **HQ** | `hq/index.html` | **The startup operating hub**: scoreboard, phase roadmap with gates, workstream status, open decisions, milestone log |
| yurapp | `yurapp/index.html` | Drag-to-spin turntable viewer (24 WebP frames × 18 pelts, Cycles renders from the yura repo's `apps/yura-web` pipeline) — an app, not a nav tab |

All three share the same design tokens (indigo `#0B0E1A` ground, aqua `#6FE7D2` glow,
Charter body, mono labels) and a pill tab nav — **adding a page means updating the nav
on every page.**

## Images

- Sources are AI-generated (ChatGPT) by Samuel, in `C:\Users\samue\OneDrive\Pictures\yura\`
  (one subfolder per series).
- Convert with Pillow (PIL is installed): strips/series → 900px-wide JPEG q82;
  hero/mood → full-res q85; blueprints/line art → full-res q88 (thin lines degrade first).
- File into `images/<category>/<descriptive-name>.jpg` — categories: `hero/`, `mood/`,
  `colorway/`, `pelt/<series>/`, `blueprint/`.
- A new pelt series = a new `.strip` row on the concept page; marquee + lightbox come
  free from the shared JS.

## Verify & deploy

- `index.html` is one load-time inline script. **Execute it, don't just lint it**: the
  Node harness `run-yura-script.js` lives in the session scratchpad (recreate if
  missing — it stubs the DOM, clicks all moods, drives marquee + lightbox, and checks
  every referenced image file exists).
- Then `npx wrangler deploy` (repo root).
- `public/.assetsignore` keeps this CLAUDE.md out of the deployed assets — keep it that
  way; this file is internal strategy, not dossier content.

## Known issues

- (2026-07-17, cosmetic, second pass) The fixed Rev B2 sheets cured the original
  typos (EYE CUP SETBACK, DIAMETER, 78/28/19 chain) but introduced new small ones —
  fix opportunistically on the next art regeneration, not worth their own cycle:
  - Head sheet title block reads "FLUFF-01" (dropped the Q) vs the exploded
    sheet's "FLUFF-Q1"; the exploded ID drifted to "FLUF-Q1-B" (was FLUF-01-B).
  - Head sheet facial-sensing note reads "EYELID CLOSED = VERTICALLY BLIND" —
    should be "VERIFIABLY BLIND".
  - Head sheet [1A] callout 3 garbles "Ø16 mm" as "16~ mm".
  - Exploded chain now shows 78/28/19 correctly but the soft-shell body's "55"
    segment is unlabeled.

Resolved (kept for context):
- ~~Blueprint title-block specs invented (7.4 V / 1.45 kg / 228 mm / 2,600 mAh)~~ —
  resolved 2026-07-17 by regeneration: sheets now read 180 mm / Ø160 / 680 g /
  3.7 V / 4,000 mAh, matching the concept spec.
- ~~Vision architecture fork~~ — resolved 2026-07-17 as **mono-split eyes**
  (camera + mechanical privacy eyelid in one IR-transparent dome, VCSEL ToF +
  940 nm IR in the other, externally identical; eye wells symmetric so stereo
  stays a drop-in upgrade). Spec, Components §B, bom-model, and both blueprint
  sheets (Rev B2) all agree.

## Tool suite — the road to profitable

Tools live in the dedicated **`yura` build repo** — `C:\GitHub\yura`, private at
github.com/datouwan/yura (has its own `CLAUDE.md`). One folder per tool under
`tools/`, each with a README; data files (BOM, watch lists, logs) are JSON committed
so they version with the thinking; every tool supports `--json`.
Update the status column here whenever a tool lands or changes.

| # | Tool | Purpose | Status |
|---|---|---|---|
| T1 | `bom-model` | BOM + margin calculator: `bom.json` (subsystem costs, ranges) → landed COGS, gross margin, and scenario P&L at any price/volume/attach. Replaces the hand-computed tables in `market/index.html` and can regenerate them. | **v0 shipped** 2026-07-17 |
| T2 | `market-watch` | Competitor tracker: watch list (Moflin, Loona, Ropet, Lovot, Casio…) → price, availability, news deltas; append-only log so the market page's claims stay current. | planned |
| T3 | `waitlist` | Demand signal: email-capture endpoint in `src/index.js` + KV, with a signup card on the dossier — the cheapest possible test of real interest before Phase 0. | planned |
| T4 | `image-pipeline` | Formalize the Pillow conversion rules above into one script: OneDrive source folder in → correctly sized/filed `images/` out. | planned |
| T5 | `proto-kit` | Home-prototype kit (was `phase0-kit`): `parts.json` + `kit.js` — stages A/B/C with gates, part price ranges, per-stage totals; regenerates the Proto page tables. STLs will live in `tools/proto-kit/cad/`. | **v0 shipped** 2026-07-30 |

Priority order is T1 → T3 → T2 (know the economics, measure demand, watch the
competition); T4/T5 when their moment comes.

### Operating loop

YURA runs like a startup, and the HQ page is its heartbeat. The `/yura-report`
skill (`.claude/skills/yura-report/SKILL.md`) refreshes `hq/index.html` from
this file + git activity, verifies the 4-tab nav, and deploys. Run it after any
meaningful YURA work session, or on a schedule. HQ and this file must never
disagree — the skill syncs both. Scoreboard rule: never invent metrics; "—"
until a tool actually measures it.

## Decision log

Append-only; date + one line each. Newest first.

- 2026-08-04 — **Checkable shopping list added to the Proto page.** "The kit"
  table now has an "Open as shopping list" toggle: the same 23 parts as
  checkboxes grouped by stage, with a vendor-category suggestion per part
  (Adafruit, Amazon, Pololu, print service, etc.) and check-state saved to
  localStorage. Mirrored in the yura repo: `proto-kit`'s `kit.js` gained
  `--shopping-list` (and `--json`), and `parts.json` gained a `vendor` field
  per part.
- 2026-07-30 — **Phase 0 puppet dropped; home-prototype path adopted.** Samuel owns a
  Moflin (live alive-ness reference), so Phases 0–1 merged into a staged home build:
  Stage A presence blob → B comprehension → C glide, $397–686 all-in, chassis from an
  online print service (no printer at home). Proto page shipped as 5th nav tab (nav
  updated on all pages); T5 re-purposed phase0-kit → **proto-kit v0** in the yura repo.
  Gate discipline kept: stages judged by someone who isn't Samuel, Moflin in the room.
  Next blocker: Stage A shell CAD before print order #1.
- 2026-07-30 — **Base-case wording resolved** (was an open decision since T1 shipped):
  "≈ break-even" was the worst-cost corner ($269 COGS, $4.5M opex, $3/mo cloud), not
  the midpoint (+$1.2M). Market §06 now states the corners explicitly (0 → +$2.3M,
  +$1.2M mid); the 30–40k gate re-worded as *robust* profitability (positive even at
  the worst corner). bom-model gate line synced in the yura repo.
- 2026-07-17 — Fixed Rev B2 sheets landed (typos cured, dimension chain 78/28/19);
  new smaller glitches recorded in Known issues. **Auto-dock nest re-costed** —
  it had shipped in the art without a BOM update: nest-dock $10–15 → $14–22,
  landed midpoint $235 → $240, gross 40–52%. Market §06 and Components §G synced
  (G rewritten from passive crater to self-docking station).
- 2026-07-17 — Rev B2 blueprints landed (regenerated by user from prompts):
  mono-split eyes on both sheets, corrected title blocks (180 mm / Ø160 / 680 g /
  3.7 V / 4,000 mAh) — closes both the invented-specs issue and the mono-split
  art debt. `exploded.jpg` + `head-detail.jpg` replaced.
- 2026-07-17 — **Vision architecture decided: mono-split eyes** (camera + eyelid in
  one dome, ToF/IR in the other; no dummy eye). COGS midpoint back to $235, gross
  42–53%; concept spec, Components §B, Market §06, and bom.json all synced.
  Blueprint regeneration (mono-split + corrected title blocks) handed to the user.
- 2026-07-17 — BOM re-costed for Rev B1 stereo eyes via T1: sensors $24–32 →
  $32–44, landed COGS midpoint $235 → $245, gross margin 42–53% → 40–51%. Market
  page section 06 updated to match. Mono option (camera in one eye, ToF+IR in the
  other — no dummy eye) saves ~$8–12/unit; folded into the vision-architecture
  open decision.
- 2026-07-17 — Blueprints updated from new renders: `exploded.jpg` replaced (now
  includes the auto-dock nest + self-docking sequence); `cutaway.jpg` retired,
  replaced by `head-detail.jpg` (Rev B1 head/eye-module sheet). Components §B
  rewritten to the eye-dome stereo vision design; vision-architecture fork logged
  in Known issues.
- 2026-07-17 — Build repo `yura` created (private, github.com/datouwan/yura);
  T1 bom-model v0 shipped there. It exposed a dossier inconsistency: the Market
  page's base case computes to ≈+$1.3M operating, not the "≈ break-even" it
  claims — open decision (re-word vs make opex explicit), tracked on HQ.
- 2026-07-17 — HQ page stood up at `/ailab/pet/hq/` as the startup operating hub
  (scoreboard, phase gates, workstreams, decisions, milestone log); `/yura-report`
  skill created to refresh it; nav is now 4 tabs on all pages.
- 2026-07-17 — This file created as YURA memory base; tool suite defined, all planned.
- 2026-07 — Dossier grew to three pages (concept, market, components); $449 + $9/mo
  business model adopted as the working baseline.
