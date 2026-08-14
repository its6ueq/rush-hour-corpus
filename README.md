# Rush Hour corpus

55,404 sliding-block puzzles with a proven optimal move count, on 6×6, 7×7 and 8×8 boards, ranging
from 4 moves to 202.

Every board in here satisfies three conditions:

- **The par is optimal, not a heuristic.** Each puzzle's move count is the length of the shortest
  solution, found by exhaustive search of the board's reachable state space.
- **Every piece matters.** No board contains a car that cannot move in any line of play. Boards
  with immobile pieces are repaired if possible and rejected otherwise.
- **No edge is a solid wall of cars.** A board whose top, bottom, left or right line is completely
  filled is rejected. This is an aesthetic rule rather than a mathematical one; see
  [why](#the-rule-that-is-not-about-difficulty).

The corpus, the miners that produced it, and an independent verifier that checks it are all here.

## The game

Cars and trucks lie on a square grid. A horizontal piece can only slide left and right; a vertical
piece can only slide up and down; nothing may pass through anything else. One horizontal piece is
the target car, and the puzzle is solved when it has been driven off the right-hand edge.

A **move** is one piece sliding any distance along its own line. A piece that travels three squares
in one go has made one move, not three. The exit slide is a move like any other.

That definition matters when comparing numbers with other sources. Counting each square separately
roughly doubles every figure, and stopping the clock when the exit lane merely becomes clear —
rather than when the target has been driven through it — reports every puzzle as one move short.

## What is in the corpus

| Board | Puzzles | Par range | Distinct par values |
| ----- | ------: | --------- | ------------------: |
| 6×6   |   9,487 | 4 – 64    |                  54 |
| 7×7   |   6,507 | 4 – 58    |                  55 |
| 8×8   |  39,410 | 4 – 202   |                 186 |
| **Total** | **55,404** | **4 – 202** | |

Around 166,000 independent searches produced them. Boards are deduplicated by piece placement, so
55,404 means 55,404 different puzzles, not the same layout under different names.

The distribution is deliberately flat rather than natural. Random search finds enormously more
easy boards than hard ones, so the miners cap how many they keep at each par and steer later work
toward the depths still short. What comes out is a corpus usable as a difficulty ladder instead of
a pile with a long thin tail.

### Layout

```
data/
  index.json          per-size summary and a board count for every par
  6x6/par-004.json    one file per par value
  6x6/par-005.json
  ...
  8x8/par-202.json
```

Each file:

```json
{
  "boardSize": 8,
  "par": 47,
  "count": 80,
  "boards": [
    { "exit": 3, "par": 47, "cars": [[3,0,2,"H"], [0,1,3,"V"], ...] }
  ]
}
```

A car is `[row, column, length, orientation]`. Rows and columns count from zero at the top left.
`"H"` slides horizontally, `"V"` vertically. **The first car in the list is always the target
car**, and `exit` repeats its row for convenience — the gap in the right-hand wall is on that row.

Solutions are not stored. They are two thirds of the bytes and every one is reproducible from the
board by the solver in this repository, so shipping them would be shipping an uncheckable cache.
Without them, each par is a claim you can verify rather than a number you have to trust:

```
npm run verify              # samples every par at every size
node src/verify.mjs --all   # every board; slow at the deep end
```

`src/verify.mjs` shares no code with the miner — different state encoding, different move
generator, different goal test. That is the point of it. A verifier that imported the fast solver
would only be checking that a function still returns what it returned last time.

## Method

Nothing here is a new algorithm. The solver is the standard one and the search around it is
standard local search. What the corpus reflects is mostly which standard thing was applied where,
and a handful of measurements that contradicted the obvious choice.

### Scoring a board

Rush Hour moves are reversible, so every position reachable from a layout forms one connected
component of the state graph. Walking that component from the solved positions backwards, breadth
first, prices *every* position in it at once: each one's distance from the walk's start is exactly
the minimum number of moves that solves it.

So a single search does not evaluate one puzzle. It evaluates every puzzle that shares that
arrangement of pieces, and the deepest position in the component is the hardest puzzle that
arrangement can pose.

### Finding deep boards

A random layout is almost never interesting, and hill climbing from one is slow because the
landscape is mostly plateau — most single-piece moves leave the deepest position exactly where it
was. Sideways moves are therefore accepted, not just improving ones; refusing them strands the
search on the first plateau it meets.

Two measurements changed the design more than any amount of tuning:

**Harvest density.** A component 80 moves deep contains many distinct positions at depth 76, each a
different 76-move puzzle, and the search that priced them has already been paid for. Taking one and
discarding the rest was throwing away nearly everything the expensive part of the run produced.
Sampling several positions per depth across the top of the range yielded about 25 new distinct
boards per search, and turned up positions deeper than anything the corpus already held — inside
components it already owned.

**Where to start.** Restarting from a fresh random layout every time discards everything previous
work found. A random 8×8 sits nowhere near 80 moves, so each restart spends its whole budget
climbing back to a depth the corpus reached long ago. Seeding instead from boards already known to
be deep — kick one hard enough to leave its basin, then climb — is ordinary iterated local search,
and it is what made the deep end practical. Starting boards are drawn round-robin across par rather
than from the top of a sorted list: take only the deepest and the middle of the range quietly stops
growing, because a component 154 moves deep only harvests near its own ceiling.

**Search caps cut both ways.** Rejecting layouts whose state space exceeds a cap is what makes
breadth mining fast — rejected walks are the expensive ones. But depth and component size are
correlated, so a cap tuned for throughput rejects a good share of the deepest boards outright.
Measuring found that a cap comfortable for general mining threw away roughly a third of the deepest
8×8 boards tried; raising it accepted all of them, and raising it further accepted nothing more
while costing time on every search.

### Growing a board size

Random 8×8 layouts are a poor place to start: sparse ones explode into enormous shallow state
spaces, dense ones tend to freeze. Embedding a known-good 6×6 puzzle into the larger board and
searching from there works far better.

Where it is embedded turns out to matter, for a reason worth writing down. Centring a 6×6 core in
an 8×8 board leaves a ring one cell wide, and a piece in a one-cell ring has nowhere to point but
along it — so the edge line fills up and the board grows exactly the solid stripe the corpus rules
out. Pushed into a corner instead, the spare space is a band two cells deep, and pieces in it can
face either way. That single change took the rejection rate on padded boards from most of them to
none.

### The rule that is not about difficulty

The solid-edge rule exists because these boards were built for a game people look at. A board whose
entire top row is cars reads as a wall rather than as a puzzle, however good its search properties
are.

It is worth stating how the check is written, because the obvious version is wrong. Counting the
pieces that run *along* an edge misses a column closed by three vertical cars plus the nose of a
horizontal one: seven cells belong to matching pieces, but eight cells are full. The rule has to
count occupancy of the edge line, not the orientation of the pieces near it. Applying the corrected
rule to a well-known set of hand-made 6×6 puzzles rejects about half of them.

## Running the miners

Requires Node.js 18 or newer. No dependencies.

```bash
# Breadth: fill every par evenly at one board size.
node src/mine-breadth.mjs --size 7 --hours 8 --workers 8 --keep 250

# Depth: iterated local search seeded from boards already mined.
node src/mine-deep.mjs --size 8 --hours 8 --workers 16 --minpar 48

# Grow 8x8 boards from the 6x6 corpus.
node src/pad-eight.mjs --hours 4 --workers 8

# Publish checkpoints as the compact corpus under data/.
node src/export-corpus.mjs
```

Both miners are resumable. A run is a range of seeds and a seed determines everything that run
does, so a checkpoint records which seeds are finished rather than where a search had got to.
Interrupting one costs the batches in flight and nothing else; starting it again picks up where it
left off with the collection intact. Checkpoints are written to a temporary file and renamed, so a
machine that dies mid-write leaves the previous checkpoint whole rather than a truncated file.

Checkpoints are much larger than the published corpus — they carry stored solutions and internal
bookkeeping — and are not tracked here. `src/export-corpus.mjs` is what turns them into `data/`.

### Files

| File | What it is |
| ---- | ---- |
| `src/explorer.mjs` | State-space search, board generation, mutation, the edge rule |
| `src/mine-breadth.mjs` | Fills every par evenly at one board size |
| `src/mine-deep.mjs` | Iterated local search for the deep end |
| `src/pad-eight.mjs` | Grows 8×8 boards from 6×6 cores |
| `src/export-corpus.mjs` | Checkpoints to the published `data/` format |
| `src/verify.mjs` | Independent solver, shares no code with the above |

## Uses

Difficulty-graded level sets for puzzle games; benchmarks for search and planning where an exact
optimum is known; test data for solvers; a source of hard instances well past the sizes usually
published.

Rush Hour is PSPACE-complete in general, so an 8×8 board needing 202 moves is not merely a large
number — it is an instance where no shortcut to the answer is known.

## Credits and licence

The 6×6 set includes puzzles derived from the classic commercial game, kept only where they pass
the checks above. Everything else was generated by the miners here.

Code is MIT. The corpus data is released under
[CC0](https://creativecommons.org/publicdomain/zero/1.0/) — use it for anything, attribution
welcome but not required.

Contributions are welcome, particularly deeper boards, other board sizes, and independent
verification. A pull request that adds boards should say how they were checked.
