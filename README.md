# Roadle

A daily junction puzzle. Every day there is one new, procedurally generated junction: place
signs, traffic lights, roundabouts and other traffic control, test the design with rush-hour
traffic, then submit it for an official run. The score rewards short waits and few crashes and
subtracts the cost of everything you built. Mondays are easy; each day adds traffic and features
(bus stops, a tram line, a level crossing, double junctions) until Sunday.

## Hosting

The game is plain static files with no build step and no server code.

- Upload `index.html`, `css/` and `js/` to any static host (GitHub Pages, Netlify, S3, nginx, …).
- It also runs by opening `index.html` straight from disk.
- Shared results link to the address the game is served from. To use a different link, uncomment
  the `window.ROADLE_URL` line near the bottom of `index.html`.
- The only external request is the Nunito web font from Google Fonts (two `<link>` tags in
  `index.html`). Remove them and the game falls back to a system font.
- Progress, settings and stats live in the browser's `localStorage`. Nothing is sent anywhere.

Puzzle #1 is 16 November 2026 (`EPOCH` in `js/util.js`). The puzzle is derived from the player's
local date, so everyone gets the same junction on the same calendar day.

## Developer mode

Hidden from players. Turn it on with any of:

- add `?dev=1` to the URL (`?dev=0` turns it off again),
- type `roadworks` on the keyboard,
- tap the Roadle logo seven times quickly.

It adds a panel below the game with:

- **Day**: step through dates, force a weekday's difficulty, or load a custom/random seed.
- **Junction**: demand per road, features, train and tram timetables.
- **Run**: 8× and 16× speed, an instant score across five traffic samples plus the official
  one, and an official-traffic run that does not save.
- **Overlays**: lane paths, conflict zones, vehicle ids.
- **Engineer**: run the full solver and see the best score per family of control, apply its
  design, recompute the par score.
- **Data**: reset the day, wipe all saved data, copy/paste a design as JSON.

Scores from dates other than today, or from custom seeds, never touch the player's streak.

## How it works

| File | Role |
| --- | --- |
| `js/util.js` | seeded RNG, dates |
| `js/level.js` | junction generator (weekday recipes in `RECIPES`) and traffic demand |
| `js/net.js` | lane geometry, junction movements, conflict zones, priority rules, costs (`COST`), driver perception (`CTX`) |
| `js/sim.js` | the traffic simulation and scoring (`SCORE`) |
| `js/solver.js` | the "city engineer" that sets the par score |
| `js/render.js`, `js/audio.js`, `js/ui.js` | canvas drawing, synthesised sound, game shell |

Traffic model, briefly: vehicles follow lanes with an intelligent-driver car-following model
(acceleration, braking, queues). Arrivals are a rush-hour-shaped Poisson process with platoons;
the number of vehicles per road is fixed by the forecast, their timing varies between traffic
samples. Drivers who must give way accept gaps with imperfect judgement, get impatient while
waiting, and occasionally overlook someone — that is where near-misses and crashes come from.
Tests use practice samples (A–E); the official run uses a separate sample that is the same for
every player that day.

The simulation is deterministic for a given design and traffic sample.

## Tools

Both need only Node 22+ (no packages).

```
node tools/playtest.js [weeks] [startDate] [-v]
```

Runs the solver over a range of days and reports which kind of control wins on each junction —
use it after changing costs, demand or driver behaviour to check that the puzzles still reward a
variety of solutions. `tools/sweep.js <date> [q,q,…]` compares the control families on one
junction at different demand levels.

```
node tools/e2e.js
```

Drives the real page in headless Microsoft Edge (set `EDGE` to another Chromium binary if
needed): places every tool, paints a signal plan, runs a test, submits, checks persistence and
the phone layout, and saves screenshots.
