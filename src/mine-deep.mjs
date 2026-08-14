// Overnight driver for the deep end of the catalog.
//
//   node scripts/mine-deep-boards.mjs --size 8 [--hours 8] [--workers N] [--minpar 55]
//
// Why this exists separately from mine-native-boards.mjs
// -----------------------------------------------------
// The breadth miner fills every par evenly, and it is good at that. It is bad at the last chapters,
// and the checkpoint says exactly how bad: par 4 to 36 sit at their cap while par 60 upward have
// four to twenty boards each, thinning to a single board at par 100, 106, 108 and 115. Chapters 16
// to 20 are a hundred and sixty-five levels in total because that is all the deep boards there are.
//
// Two things in the breadth miner cost the deep end most of what it finds.
//
// It restarts from a fresh random layout every seed. A random 8x8 sits nowhere near par 80, so the
// climb spends its entire budget getting back to a depth the catalog reached weeks ago, and every
// seed pays that toll again. Iterated local search does not: it starts from a board already known
// to be deep, kicks it hard enough to leave the basin, and climbs from there. The whole corpus
// becomes the starting population instead of being written once and never read.
//
// It harvests one board per depth. A component eighty moves deep holds many distinct positions at
// depth seventy-six, each a different par-76 board, and the walk that priced them is the expensive
// part of the run - already paid for by the time the harvest happens. Keeping one and discarding
// the rest is where most of the deep supply was going.
//
// Neither is a new idea. Both are the standard fix for a search that has plateaued, which is what
// the breadth miner has done up here.
//
// Checkpoints are written under a name the merge already reads: `native-7x7-deep.json` and
// `padded-8x8-deep.json` both match the prefixes in merge-mined-catalogs.mjs, so the deep boards
// join the catalog without another wiring step.

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? Number(argv[index + 1]) : fallback;
};

const BOARD_SIZE = flag("size", 8);
const HOURS = flag("hours", 8);
const WORKERS = flag("workers", Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1));
// One seed a batch. A deep seed costs a minute or so, against milliseconds for a breadth seed, so
// the message round trip is free by comparison and a kill should not cost two of them.
const BATCH = 1;

/// Only boards this deep are worth writing down.
///
/// The point of this run is the last chapters, and a par-30 board found on the way is one the
/// breadth miner already has sixty of. Defaulting to roughly where each size starts to thin.
const MIN_PAR = flag("minpar", BOARD_SIZE >= 8 ? 48 : 37);

/// Boards kept per par. Generous - up here a bucket that fills is a good problem, and at twenty-five
/// boards a walk the buckets fill faster than the old numbers assumed.
const KEEP_PER_PAR = flag("keep", 250);

/// A larger cap than the breadth miner runs with, and measured rather than guessed.
///
/// Depth and component size are correlated, so the cap that makes the breadth miner fast by
/// rejecting big components rejects part of what this run is looking for. Timing thirty of the
/// deepest 8x8 boards said how much: at 700k, nine of the thirty overran the cap and were thrown
/// away; at 1.2M all thirty finish, averaging 511k states. Past that is dead weight - 2.6M accepts
/// no board 1.2M rejects and costs nine percent more per walk.
const MAX_STATES = flag("maxstates", BOARD_SIZE >= 8 ? 1_200_000 : 900_000);

/// Climb steps, set from the walk budget rather than from taste.
///
/// The same timing put one deep 8x8 walk between three and four seconds, so a whole night on
/// fourteen workers is about a hundred and twenty thousand walks in total - and a climb step is not
/// one walk but up to four, because every step settles. Eighteen steps came to four minutes a seed
/// and returned nothing in five.
///
/// Three, because the climb is no longer where the yield is. Walking a pool board and harvesting it
/// densely returns twenty-five new boards for one walk, measured; the climb returns new *maxima*,
/// which matter far less than volume when the ask is levels in chapters sixteen to twenty. A few
/// kicks per seed keeps some exploration without spending the night on it.
const CLIMB_STEPS = flag("climb", 3);

/// How many positions to keep at each depth in the band.
///
/// Boards taken from one component share a piece multiset, so a large number here fills a chapter
/// with variations on one puzzle. Four is a compromise: enough that the walk pays for itself many
/// times over, few enough that the last chapters still draw from many different components.
const PER_DEPTH = flag("perdepth", 4);

/// How much of a component's depth range counts as "the deep end" for harvesting.
const BAND_FRACTION = flag("band", 0.86);

/// Kicks per restart, drawn from 1..this. Too few and the climb lands back where it started; too
/// many and it is a random layout with extra steps.
const PERTURBATIONS = flag("perturb", 5);

/// How many of the catalog's deepest boards form the starting population.
///
/// Large, because the first pass over the pool is the cheapest yield in the whole run. Every board
/// in it was harvested at six depths when it was mined and its component holds far more than that;
/// walking it once and harvesting densely costs one walk and returns boards the corpus never had.
/// Seeds index the pool directly, so the first `POOL_SIZE` seeds sweep it exactly once before any
/// seed revisits a board with a different kick.
const POOL_SIZE = flag("pool", 4000);

/// How far below the collecting floor a board may sit and still be worth climbing from. A par-44
/// component is one good kick away from par 50 and there are far more of them.
const POOL_SLACK = flag("slack", 8);

const MINED = "data/checkpoints";
const PREFIX = BOARD_SIZE >= 8 ? "padded-8x8" : `native-${BOARD_SIZE}x${BOARD_SIZE}`;
const CHECKPOINT = path.join(MINED, `${PREFIX}-deep.json`);

/// The starting population: the deepest boards already mined at this size, from every checkpoint
/// including this run's own. A night that finds par 92 seeds the next night from par 92.
async function loadPool() {
  const files = (await readdir(MINED)).filter(
    (name) => name.startsWith(PREFIX) && name.endsWith(".json") && !name.endsWith(".tmp"),
  );
  const byPar = new Map();
  let found = 0;
  for (const name of files) {
    const parsed = JSON.parse(await readFile(path.join(MINED, name), "utf8"));
    for (const [par, list] of Object.entries(parsed.buckets ?? {})) {
      const depth = Number(par);
      if (depth < MIN_PAR - POOL_SLACK) continue;
      const bucket = byPar.get(depth) ?? [];
      for (const board of list) bucket.push({ par: depth, cars: board.cars, obstacles: board.obstacles ?? [] });
      byPar.set(depth, bucket);
      found += list.length;
    }
  }
  if (!found) throw new Error(`no boards under ${MINED}/${PREFIX}* to start from`);

  // Round-robin across par, not the deepest N.
  //
  // Taking the top of a sorted list looks right and starves the middle. After one night the 8x8 had
  // twelve thousand boards past par 40, so the deepest four thousand of them all sat above par 76 -
  // and a component 154 moves deep only harvests its top band, around 133 and up. Every par from 48
  // to 75 would have stopped growing, which is chapters sixteen through nineteen: exactly the part
  // of the range this run exists to fill.
  const pars = [...byPar.keys()].sort((left, right) => left - right);
  for (const par of pars) byPar.get(par).sort(() => 0.5 - Math.random());
  const pool = [];
  for (let round = 0; pool.length < POOL_SIZE; round += 1) {
    let placed = 0;
    for (const par of pars) {
      const bucket = byPar.get(par);
      if (round >= bucket.length) continue;
      pool.push(bucket[round]);
      placed += 1;
      if (pool.length >= POOL_SIZE) break;
    }
    if (!placed) break;
  }

  console.log(
    `pool: ${pool.length} of ${found} boards from ${files.length} checkpoint(s), ` +
      `par ${pars[0]}-${pars.at(-1)} across ${pars.length} par values`,
  );
  return pool;
}

async function loadCheckpoint() {
  try {
    const parsed = JSON.parse(await readFile(CHECKPOINT, "utf8"));
    const buckets = new Map();
    const seen = new Set();
    for (const [par, boards] of Object.entries(parsed.buckets ?? {})) {
      buckets.set(Number(par), boards);
      for (const board of boards) seen.add(board.signature);
    }
    console.log(
      `resuming deep ${BOARD_SIZE}x${BOARD_SIZE}: ${seen.size} boards, ` +
        `${buckets.size} par values, next seed ${parsed.nextSeed}`,
    );
    return { buckets, seen, nextSeed: parsed.nextSeed, seedsDone: parsed.seedsDone ?? 0 };
  } catch {
    console.log(`starting deep ${BOARD_SIZE}x${BOARD_SIZE} from scratch`);
    return { buckets: new Map(), seen: new Set(), nextSeed: BOARD_SIZE * 7_700_017, seedsDone: 0 };
  }
}

async function save(state) {
  const buckets = {};
  for (const [par, boards] of [...state.buckets.entries()].sort((a, b) => a[0] - b[0])) {
    buckets[par] = boards;
  }
  const payload = {
    boardSize: BOARD_SIZE,
    updated: new Date().toISOString(),
    nextSeed: state.nextSeed,
    seedsDone: state.seedsDone,
    total: state.seen.size,
    buckets,
  };
  await mkdir(MINED, { recursive: true });
  const temporary = `${CHECKPOINT}.tmp`;
  await writeFile(temporary, JSON.stringify(payload));
  await rename(temporary, CHECKPOINT);
}

function absorb(state, boards) {
  let added = 0;
  for (const board of boards) {
    if (board.par < MIN_PAR) continue;
    if (state.seen.has(board.signature)) continue;
    const bucket = state.buckets.get(board.par) ?? [];
    if (bucket.length >= KEEP_PER_PAR) continue;
    bucket.push(board);
    state.buckets.set(board.par, bucket);
    state.seen.add(board.signature);
    added += 1;
  }
  return added;
}

function summary(state) {
  const pars = [...state.buckets.keys()].sort((a, b) => a - b);
  if (!pars.length) return "nothing yet";
  const full = pars.filter((par) => state.buckets.get(par).length >= KEEP_PER_PAR).length;
  return `${state.seen.size} boards, par ${pars[0]}-${pars.at(-1)}, ${full}/${pars.length} buckets full`;
}

const pool = await loadPool();
const state = await loadCheckpoint();
const deadline = Date.now() + HOURS * 3600_000;
let stopping = false;
let deepestSeen = 0;
let lastSave = Date.now();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\nstopping: finishing the batches in flight, then saving");
  });
}

console.log(
  `deep-mining ${BOARD_SIZE}x${BOARD_SIZE} on ${WORKERS} workers for ${HOURS}h, ` +
    `par ${MIN_PAR}+; checkpoint ${CHECKPOINT}`,
);

await new Promise((resolve, reject) => {
  const workers = [];
  let live = 0;

  const feed = (worker) => {
    if (stopping || Date.now() > deadline) {
      worker.postMessage(null);
      live -= 1;
      if (live === 0) resolve();
      return;
    }
    const from = state.nextSeed;
    state.nextSeed += BATCH;
    worker.postMessage({ from, to: from + BATCH, minPar: MIN_PAR });
  };

  for (let index = 0; index < WORKERS; index += 1) {
    const worker = new Worker(new URL("./deep-worker.mjs", import.meta.url), {
      workerData: {
        boardSize: BOARD_SIZE,
        maxStates: MAX_STATES,
        climbSteps: CLIMB_STEPS,
        minPar: MIN_PAR,
        perDepth: PER_DEPTH,
        bandFraction: BAND_FRACTION,
        perturbations: PERTURBATIONS,
        pool,
      },
    });
    workers.push(worker);
    live += 1;

    worker.on("message", async (batch) => {
      state.seedsDone += batch.to - batch.from;
      const added = absorb(state, batch.boards);
      if (batch.deepest > deepestSeen) deepestSeen = batch.deepest;

      if (Date.now() - lastSave > 60_000) {
        lastSave = Date.now();
        await save(state);
        const left = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
        console.log(
          `  ${new Date().toISOString().slice(11, 19)}  ${summary(state)}; ` +
            `deepest ${deepestSeen}; +${added} last batch; ` +
            `${state.seedsDone} seeds; ${left}m left`,
        );
      }
      feed(worker);
    });

    worker.on("error", reject);
    feed(worker);
  }
});

await save(state);
console.log(`done: ${summary(state)}; deepest par seen ${deepestSeen}`);
process.exit(0);
