# Football Survivor

Single-user PWA for NFL survivor pool picks: tracks picks, pushes reminders before the Saturday-noon deadline, and ranks each week's teams with an analysis blend.

**Live:** On iPhone: Safari → Share → Add to Home Screen, open from the icon, then Settings → Enable on this device for push reminders.

## Run
```
npm install
PORT=3910 node server.js         # or: systemctl --user {start,status,restart} football-survivor
```
State lives in `data/store.json` (picks, push subscriptions, settings). Data caches and VAPID keys are in `data/` too. No API keys needed.

### Serve it on the tailnet (dedicated Tailscale Service)
The PWA is exposed under its **own** Tailscale Service, `svc:football-survivor`
(`football-survivor.<tailnet>.ts.net`), rather than on the node's shared root —
so another `tailscale serve` on the node (e.g. a report) can't overwrite it.
```
deploy/setup.sh                  # installs the app + service systemd user units, then approve svc:football-survivor in the admin console
```
See [`deploy/README.md`](deploy/README.md) for prerequisites (tagged host, operator, grant) and verification.

## Data sources (all free, fetched with timeouts and disk-cached fallback)
- ESPN scoreboard: schedule, DraftKings moneyline/spread, records, live status
- ESPN injuries: per-team report with status
- nflverse `games.csv`: every game since 1999 with results, closing lines, rest days, division flag
- SurvivorGrid (`lib/survivorgrid.js`): scraped, not an API — the grid page server-renders an inline `gridData` object plus one table row per team, giving market win% and pick share from four pools (PoolCrunch `projected`, ESPN, Yahoo, USA Football Pools). URL is `/{season}/{week}`; `robots.txt` disallows nothing. Cached 3h. A layout change throws (team count and pick-share sum are checked) rather than poisoning the model, and falls back to the last good cache.

## Model (`lib/model.js`)
- Elo from full history: margin-of-victory multiplier, home field (+48), rest days, one-third regression each offseason
- Market win probability from vig-free moneylines (spread fallback)
- Win% = 0.75 market + 0.25 Elo, then a damped injury adjustment (lines already price most news)
- Survivor score subtracts an opportunity cost when a team has a better week later
- Season planner: assigns one team per remaining week to maximize joint survival probability, scarce weeks first, then local swaps
- Calibration table: how often closing-line favorites of each strength actually won since 2010

## Pool spreadsheet (other entries' history)
Settings → Upload workbook takes the weekly "Knockout Pool" xlsx (column A entry, column B `PD`, columns headed `WEEK n`). Parsed with no dependencies (`lib/pool.js`), stored in `data/pool.json`. From it the model derives who is still alive and which teams each alive entry has burned.

## Pool tab: projected pick distribution (`public/crowd.js`, shared by server and client)
All of this is an estimate of other people's behaviour and is labelled as such in the UI.
- **SurvivorGrid import**: **Fetch from SurvivorGrid** scrapes the current week directly (no paste, no key); the 5-minute server tick also keeps the current week fresh on its own. An auto-import is refreshed in place, but a manual paste is never overwritten by the tick — only by clicking Fetch. Teams on bye contribute no prior and are reported separately from unrecognized ones. Set `settings.sgProvider` to `espn`, `yahoo` or `usa-football-pools` to store that pool's pick share instead of the blended default. Pasting still works: paste the grid or a CSV (`team, winProb, consensusPct`) per week. Win% accepts `81%`, `0.81` or a moneyline (`-571`); pick share accepts `29%` or `0.29`. Preview, then save; stored in `data/store.json` under `sg[season][week]`. Teams left out get a 0.5% floor. Without a paste the prior is the softmax over win probability (steepness fitted to the pool's past picks).
- **Projection**: for each alive rival (your own entry, named in Settings, is excluded) `prior(t) = consensus(t)^chalkFactor`, zeroed for teams they have burned, renormalised. Pool P% is the average over rivals. The chalk slider recomputes live in the browser; "Save as default" persists it. Optional behaviour tuning maps each rival's chalk hit rate (did they take the biggest favourite they still held?) to a per-rival factor.
- **EV** = win% × (rivals surviving on a neutral pick ÷ rivals surviving if this team wins); rivals on your team survive, rivals on your opponent are eliminated, others survive at their own rate. **Lev** is that ratio normalised so 1 is average; the survivor score adds `(lev − 1) × win% × 0.5`. **Avail #** = alive rivals who can still take the team.
- **Lookahead**: expected number of rivals still holding each elite team (tagged in Settings, else top 8 by remaining projected win%) entering each future week, thinning rivals by projected picks and losses. Weeks where most elite teams are burned are flagged as carnage candidates.
- **Rival inventory**: alive rivals by elite teams still held; zero held = blocked.

## First-run setup
Signing in says who you are; it cannot say which rows on the pool sheet are yours. A membership with no entry names opens a setup sheet over the app: the workbook first (only when none is imported, and upload is offered to the pool admin alone — everyone else is told to wait for it), then your name and how many entries you have. Setup writes the names in this pool's format: **one entry is the bare name** (`Ryan, Andrew`), **several are all numbered from 1** (`Ryan, Andrew #1`, `Ryan, Andrew #2`, …). That rule is `crowd.entryNames()`, the inverse of the `crowd.ownerOf()` / `crowd.stripEntryNo()` the projection already uses to group an owner's entries.

The name field is prefilled with `family_name, given_name` from the Google `profile` scope the sign-in already requests — but only as a starting point, since the sheet is what the pool admin typed: about 12% of this pool's owners are handles rather than `Last, First`, and `Acosta, E` will never match "Acosta, Elias" exactly. Typing two or more characters searches the league's workbook and suggests owners with their entry counts, so picking `Ryan, Brendan · 3 entries` fills in both fields; the preview then marks each generated name **on the sheet** or **not on the sheet** before you save. Google cannot know your entry count — the sheet match can, which is why picking a suggestion sets it.

Saving sets the league setting `onboarded`, so setup does not come back; Settings → Pool projection → **Re-run setup** reopens it prefilled. Skipping sets the flag too. Any membership that already names an entry is treated as onboarded when it loads, so existing users and second leagues never see the sheet.

## Multiple entries (portfolio)
Settings → My entries, one workbook name per line (up to 8; a blank line is an entry that is not on the sheet) — first-run setup fills this in for you. Entry 1 is the default and keeps the old single-entry behaviour. Picks are stored per entry (`entryPicks[season][entry][week]`; the old `picks` map migrates into entry 0 on first load) and graded per entry; reminders fire while any entry has no pick. None of my entries ever counts as a rival.
- **Pick / Season tabs** get an entry chip row. Availability, the win-probability grid and the season path are per entry. Paths are planned in entry order so two entries never spend the same team in the same week; weeks where that de-confliction costs an entry 3+ points of win probability are flagged as collision weeks.
- **Pool tab → Portfolio** (`crowd.portfolio`): every assignment of one team per alive entry (each entry limited to its top 6 by single-entry EV) is scored over all 2^k outcomes of the k ≤ 12 games spanned by those candidates plus the biggest rival chalk. Joint EV = Σ P(outcome) × (my survivors ÷ all survivors), with my own entries in the denominator, so stacking one team leaks equity. Also shown: P(wipeout), P(all survive), E[survivors], distinct teams. Objective chips reorder by max joint EV, min wipeout, or a balance; the highlighted hedge row is the best split across 2+ teams. "Must take different teams" (also a saved setting) drops duplicate assignments.
- **Same-owner diversification λ** (Pool tab slider, saved with the chalk factor): rivals are grouped by owner (workbook name minus a trailing `#n`). With λ < 1 each entry's chance of a team is scaled by `1 − (1 − λ) × P(another of the owner's entries takes it)` then renormalised, so an owner with three entries is less likely to put them all on the same favourite. λ = 1 is off and reproduces the independent projection exactly.

## Reminders
Server checks every 5 minutes. If the current week has no pick, it sends web-push at 24h, 3h, and 0h before the deadline (Saturday 12:00 America/New_York by default; configurable in Settings). Picks are auto-graded once games go final.

## Test
```
npm test   # projection, EV, parser, lookahead, joint-EV portfolio, SurvivorGrid scrape parser, ID-token verification
node test/ui-test.mjs     # headless Chrome walkthrough: picks, filters, season, trends, push, offline
BASE=http://127.0.0.1:3910 node test/pool-ui-test.mjs   # Pool tab: paste preview, chalk slider, sorting
BASE=http://127.0.0.1:3911 node test/portfolio-ui-test.mjs   # two configured entries: per-entry picks, portfolio table, λ slider, season paths (picks week 1 then clears)
# first-run setup: a signed-in user whose membership has no entry names; NOWB is a second server with no workbook
BASE=http://127.0.0.1:3912 NOWB=http://127.0.0.1:3913 node test/onboarding-ui-test.mjs
```
The UI tests other than the setup one assume entries are already configured — against a fresh membership the setup sheet covers the app, which is the point.
