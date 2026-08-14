// Builds 8x8 boards from the 6x6 database, with padding that is checked rather than assumed.
//
//   node scripts/pad-eight-boards.mjs [--tries 40] [--hours 4]
//
// Why not mine 8x8 from nothing
// -----------------------------
// Because it does not work. A random 8x8 layout dense enough to be interesting still has around
// fourteen free cells, and its pieces are mobile enough that the component runs to millions of
// positions: at a 200k cap none of 120 sampled layouts finished, at 320k none, at 700k seven of
// eighty, at 2.5M two of fifty and five and a half seconds each. This is the same reason the
// published Rush Hour work is all on 6x6. The 7x7 miner works because one row less is an order of
// magnitude less room.
//
// What went wrong the first time
// ------------------------------
// The old importer padded a 6x6 up to 8x8 with cars whose lengths add up to exactly the width -
// 3+3+2 across row 0 and again across row 7. A horizontal car only slides along its own row, so a
// row packed edge to edge can never move, and neither can anything in it. Six of every board's
// twenty-two pieces were scenery, in the same place, on all thousand boards.
//
// The fix is not a cleverer padding pattern. It is checking: pad at random, walk the result, and
// keep it only if the walk proves every piece can move and no edge line is packed. The walk also
// returns the exact par of the padded board, so the recorded difficulty is measured rather than
// inherited from the 6x6 it grew out of.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  COLORS,
  Explorer,
  hasTiledEdge,
  seededRandom,
  signature,
} from "./explorer.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? Number(argv[index + 1]) : fallback;
};

const SIZE = 8;

/// Where the 6x6 core sits. Not the middle.
///
/// Centring it leaves a ring one cell wide, and a piece in a one-wide ring has nowhere to point but
/// along it - so the edge line fills up and the board grows the exact stripe this whole exercise is
/// about. Reserving gaps in that ring only trades the stripe for a loose board whose state space
/// runs past the search cap: yield fell to one padding in two hundred.
///
/// Pushed into a corner instead, the spare space is a band two cells deep. Half of it is one step in
/// from the edge, where a piece can sit across the band without touching the edge line at all. The
/// board packs and the edge still has gaps in it.
const OFFSETS = [0, 2];
const TRIES = flag("tries", 40);
const HOURS = flag("hours", 4);
const KEEP_PER_PAR = 60;
const MIN_PAR = 4;
const MAX_STATES = 900_000;
const HARVEST_PER_PADDING = 8;

// Sharded by source board rather than threaded. Each shard is an independent process over a
// disjoint slice of the 6x6 corpus with its own checkpoint, so the work parallelises without a
// worker protocol and any one shard can be killed and resumed on its own.
const SHARDS = flag("shards", 1);
const SHARD = flag("shard", 0);

/// Distinguishes a second pass over the same source boards. Padding is a pure function of the source
/// index, so without this a second set of processes would redo exactly the work the first set is
/// doing. With it, the same 6x6 gets a different set of paddings tried against it.
const SALT = flag("salt", 0);

const OUT_DIR = "data/checkpoints";
const CHECKPOINT = path.join(
  OUT_DIR,
  SHARDS > 1 ? `padded-8x8-${SALT}-${SHARD}.json` : `padded-8x8-${SALT}.json`,
);

const explorer = new Explorer(SIZE, MAX_STATES);

async function loadCheckpoint() {
  try {
    const parsed = JSON.parse(await readFile(CHECKPOINT, "utf8"));
    const buckets = new Map();
    const seen = new Set();
    for (const [par, boards] of Object.entries(parsed.buckets ?? {})) {
      buckets.set(Number(par), boards);
      for (const board of boards) seen.add(board.signature);
    }
    console.log(`resuming: ${seen.size} boards, next source ${parsed.nextSource}`);
    return { buckets, seen, nextSource: parsed.nextSource ?? 0 };
  } catch {
    console.log("starting from scratch");
    return { buckets: new Map(), seen: new Set(), nextSource: 0 };
  }
}

async function save(state) {
  const buckets = {};
  for (const [par, boards] of [...state.buckets.entries()].sort((a, b) => a[0] - b[0])) {
    buckets[par] = boards;
  }
  await mkdir(OUT_DIR, { recursive: true });
  const temporary = `${CHECKPOINT}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({
      boardSize: SIZE,
      updated: new Date().toISOString(),
      nextSource: state.nextSource,
      total: state.seen.size,
      buckets,
    }),
  );
  await rename(temporary, CHECKPOINT);
}

/// The 6x6 board moved into one corner of an 8x8.
function embed(source, rowOffset, colOffset) {
  return source.cars.map((car, index) => ({
    ...car,
    id: car.target ? "hero" : `core-${index}`,
    row: car.row + rowOffset,
    col: car.col + colOffset,
  }));
}

function fits(occupied, row, col, length, horizontal) {
  if (row < 0 || col < 0) return false;
  if (horizontal ? col + length > SIZE : row + length > SIZE) return false;
  if (horizontal ? row >= SIZE : col >= SIZE) return false;
  for (let part = 0; part < length; part += 1) {
    if (occupied[horizontal ? row * SIZE + col + part : (row + part) * SIZE + col]) return false;
  }
  return true;
}

function mark(occupied, car, value) {
  const horizontal = car.orientation === "H";
  for (let part = 0; part < car.length; part += 1) {
    occupied[horizontal ? car.row * SIZE + car.col + part : (car.row + part) * SIZE + car.col] = value;
  }
}

/// Drops pieces into the ring around the embedded core. Placement is random and deliberately not
/// exhaustive: leaving gaps is the whole point, and a piece that reaches into the core's rows is
/// what gives the ring somewhere to move to.
/// Most cells of an edge line that may be filled. Two gaps, always.
///
/// Without this almost nothing survived: padding aimed at the ring fills the ring, and 248 of 286
/// boards from the first run had at least one edge line with no gap in it. Leaving the gaps to
/// chance and checking afterwards meant paying for the whole state-space walk before finding out.
const EDGE_LIMIT = SIZE - 2;

function pad(core, count, random) {
  const occupied = new Uint8Array(SIZE * SIZE);
  for (const car of core) mark(occupied, car, 1);
  const cars = [...core];

  // Running count for row 0, row last, col 0, col last.
  const edges = [0, 0, 0, 0];
  const edgesOf = (row, col) => {
    const hit = [];
    if (row === 0) hit.push(0);
    if (row === SIZE - 1) hit.push(1);
    if (col === 0) hit.push(2);
    if (col === SIZE - 1) hit.push(3);
    return hit;
  };
  for (let index = 0; index < SIZE; index += 1) {
    if (occupied[index]) edges[0] += 1;
    if (occupied[(SIZE - 1) * SIZE + index]) edges[1] += 1;
    if (occupied[index * SIZE]) edges[2] += 1;
    if (occupied[index * SIZE + SIZE - 1]) edges[3] += 1;
  }

  // A generous attempt budget: the edge ceiling refuses a lot of placements, and falling short of
  // the requested count is what loosens the board and costs a search at the cap.
  for (let attempt = 0; attempt < count * 60 && cars.length < core.length + count; attempt += 1) {
    const length = random() < 0.6 ? 2 : 3;
    const horizontal = random() < 0.5;
    const fixed = Math.floor(random() * SIZE);
    const axis = Math.floor(random() * (SIZE - length + 1));
    const row = horizontal ? fixed : axis;
    const col = horizontal ? axis : fixed;

    if (!fits(occupied, row, col, length, horizontal)) continue;

    // What this piece would add to each edge line, refused if it would close one.
    const added = [0, 0, 0, 0];
    for (let part = 0; part < length; part += 1) {
      const r = horizontal ? row : row + part;
      const c = horizontal ? col + part : col;
      for (const edge of edgesOf(r, c)) added[edge] += 1;
    }
    if (added.some((amount, edge) => edges[edge] + amount > EDGE_LIMIT)) continue;
    for (let edge = 0; edge < 4; edge += 1) edges[edge] += added[edge];

    const paint = COLORS[cars.length % COLORS.length];
    const car = {
      id: `pad-${cars.length}`,
      row,
      col,
      length,
      orientation: horizontal ? "H" : "V",
      color: paint[0],
      name: `car-${cars.length}`,
    };
    mark(occupied, car, 1);
    cars.push(car);
  }
  return cars;
}

/// Walks a padded board, lifting out any pad piece the walk proves can never move, until every
/// piece left is in play. Core pieces are kept whatever happens.
function settle(cars) {
  let current = cars;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const component = explorer.run(current, []);
    if (!component) return null;
    if (!component.frozen) return { component, cars: current };
    const dead = new Set(component.frozen);
    const next = current.filter((car, index) => !dead.has(index) || !car.id.startsWith("pad-"));
    if (next.length === current.length) return null;
    current = next;
  }
  return null;
}

const sources = (
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      readFile(`public/levels/easy/${index + 1}.json`, "utf8").then(JSON.parse),
    ),
  )
).flat();

const state = await loadCheckpoint();
const deadline = Date.now() + HOURS * 3600_000;
let lastSave = Date.now();
let kept = 0;
let attempted = 0;
let deepest = 0;

console.log(
  `shard ${SHARD}/${SHARDS}: padding ${sources.length} source boards, ` +
    `${TRIES} tries each, ${HOURS}h budget`,
);

for (; state.nextSource < sources.length; state.nextSource += 1) {
  if (Date.now() > deadline) break;
  if (state.nextSource % SHARDS !== SHARD) continue;
  const source = sources[state.nextSource];
  const random = seededRandom(0x8080 + state.nextSource + SALT * 0x9e37);

  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    // The spare band is twenty-eight cells whichever corner the core goes in. Padding it lightly
    // leaves an 8x8 with enough room that its component runs past the search cap, so the padding is
    // heavy and the thinning below decides how much of it survives.
    const core = embed(
      source,
      OFFSETS[Math.floor(random() * OFFSETS.length)],
      OFFSETS[Math.floor(random() * OFFSETS.length)],
    );
    const count = 9 + Math.floor(random() * 5);
    const cars = pad(core, count, random);
    attempted += 1;
    if (hasTiledEdge(cars, SIZE)) continue;

    // Padding that strands a piece is thinned, not thrown away: a stuck pad car simply means this
    // board wanted less padding, and taking it out costs one more walk against the roughly one in a
    // hundred paddings that came back clean on the first try. Core pieces are never removed - that
    // would be editing the source puzzle rather than padding it.
    const settled = settle(cars);
    if (!settled) continue;
    const component = settled.component;
    const padded = settled.cars;
    if (component.maxDistance < MIN_PAR) continue;
    if (component.maxDistance > deepest) deepest = component.maxDistance;

    // Several boards per padding, not one. The walk has already priced every position in the
    // component, so a second board out of it costs a lookup - and keeping only the deepest left the
    // catalog with holes exactly where the deep end needs boards: par 54 had none at all
    // while components reaching 100 were being mined and thrown away down to a single entry.
    //
    // Depths are taken from across the top half. The shallow end of a deep component is a nearly
    // solved board, which reads as a puzzle abandoned halfway rather than as an easy one.
    const deepestHere = component.maxDistance;
    const floor = Math.max(MIN_PAR, Math.ceil(deepestHere * 0.5));
    const wanted = new Set();
    const slots = Math.min(HARVEST_PER_PADDING, deepestHere - floor + 1);
    for (let slot = 0; slot < slots; slot += 1) {
      const span = slots <= 1 ? 0 : slot / (slots - 1);
      const depth = Math.round(floor + (deepestHere - floor) * span);
      if ((state.buckets.get(depth)?.length ?? 0) < KEEP_PER_PAR) wanted.add(depth);
    }
    if (!wanted.size) continue;

    // One scan, reservoir-sampling a position per wanted depth, so which board a component gives up
    // does not depend on the order the walk happened to enumerate positions in.
    const chosen = new Map();
    const seenAt = new Map();
    for (let index = 0; index < component.total; index += 1) {
      const depth = explorer.distance[index];
      if (!wanted.has(depth)) continue;
      const count = (seenAt.get(depth) ?? 0) + 1;
      seenAt.set(depth, count);
      if (random() < 1 / count) chosen.set(depth, index);
    }

    for (const [par, node] of chosen) {
      const placed = explorer.carsAt(node, padded);
      if (hasTiledEdge(placed, SIZE)) continue;
      const route = explorer.solutionFrom(node, padded);
      if (!route || route.length !== par) continue;

      const bucket = state.buckets.get(par) ?? [];
      if (bucket.length >= KEEP_PER_PAR) continue;
      const id = signature(placed);
      if (state.seen.has(id)) continue;

      bucket.push({
        boardSize: SIZE,
        exitRow: placed.find((car) => car.target).row,
        cars: placed,
        obstacles: [],
        par,
        explored: component.total,
        solution: route.map((move) => ({ id: padded[move.index].id, from: move.from, to: move.to })),
        signature: id,
      });
      state.buckets.set(par, bucket);
      state.seen.add(id);
      kept += 1;
    }
  }

  if (Date.now() - lastSave > 60_000) {
    lastSave = Date.now();
    await save(state);
    const pars = [...state.buckets.keys()].sort((a, b) => a - b);
    console.log(
      `  ${new Date().toISOString().slice(11, 19)}  source ${state.nextSource}/${sources.length}; ` +
        `${state.seen.size} boards, par ${pars[0] ?? 0}-${pars.at(-1) ?? 0}; deepest ${deepest}; ` +
        `${kept}/${attempted} paddings kept`,
    );
  }
}

await save(state);
console.log(`done: ${state.seen.size} boards, deepest ${deepest}, ${kept}/${attempted} paddings kept`);
process.exit(0);
