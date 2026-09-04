# Football Survivor

Single-user PWA for NFL survivor pool picks: tracks picks, pushes reminders before the Saturday-noon deadline, and ranks each week's teams with an analysis blend.

**Live:** On iPhone: Safari → Share → Add to Home Screen, open from the icon, then Settings → Enable on this device for push reminders.

## Run
```
npm install
PORT=3910 node server.js         # or: systemctl --user {start,status,restart} football-survivor
```
State lives in `data/store.json` (picks, push subscriptions, settings). Data caches and VAPID keys are in `data/` too. No API keys needed.

## Data sources (all free, fetched with timeouts and disk-cached fallback)
- ESPN scoreboard: schedule, DraftKings moneyline/spread, records, live status
- ESPN injuries: per-team report with status
- nflverse `games.csv`: every game since 1999 with results, closing lines, rest days, division flag

## Model (`lib/model.js`)
- Elo from full history: margin-of-victory multiplier, home field (+48), rest days, one-third regression each offseason
- Market win probability from vig-free moneylines (spread fallback)
- Win% = 0.75 market + 0.25 Elo, then a damped injury adjustment (lines already price most news)
- Survivor score subtracts an opportunity cost when a team has a better week later
- Season planner: assigns one team per remaining week to maximize joint survival probability, scarce weeks first, then local swaps
- Calibration table: how often closing-line favorites of each strength actually won since 2010

## Pool spreadsheet (other entries' history)
Settings → Upload workbook takes the weekly "Knockout Pool" xlsx (column A entry, column B `PD`, columns headed `WEEK n`). Parsed with no dependencies (`lib/pool.js`), stored in `data/pool.json`. From it the model derives:
- who is still alive (an entry whose recorded pick lost, or who has no pick in a recorded finished week, is out)
- which teams each alive entry has burned, so a softmax-over-win-probability crowd model (steepness fitted by max likelihood to the pool's own past picks) forecasts this week's pick distribution
- leverage per team: expected surviving share of the pool if an average team wins ÷ if this team wins. Survivor score gets `(leverage − 1) × win% × 0.5`; rows show `crowd %` and flag `crowd pick` / `contrarian edge`.

## Reminders
Server checks every 5 minutes. If the current week has no pick, it sends web-push at 24h, 3h, and 0h before the deadline (Saturday 12:00 America/New_York by default; configurable in Settings). Picks are auto-graded once games go final.

## Test
```
node test/ui-test.mjs     # headless Chrome walkthrough: picks, filters, season, trends, push, offline
```
