// Overnight driver for the native board miner.
//
//   node scripts/mine-native-boards.mjs [--size 7|8] [--hours 8] [--workers N]
//
// Resumability
// ------------
// A mining batch is a range of seeds, and a seed determines everything the batch does. So the
// checkpoint records two things: the boards kept so far, and the seed to hand out next. Killing the
// run - or losing power - costs only the batches that were in flight, a minute at most. Starting it
// again picks up from the recorded seed with the collection intact.
//
// Checkpoints are written by rename, never in place: a machine that dies mid-write leaves the
// previous checkpoint whole rather than a truncated JSON file that would throw away the night.
//
// What it collects
// ----------------
// A bucket per par value, each holding up to KEEP_PER_PAR distinct boards. Filling buckets rather
// than chasing the single deepest board is the point: a graded level set needs breadth at
// every difficulty far more than it needs one more record-holder at the top. Boards are deduplicated
// by placement, so a bucket of forty is forty different puzzles.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

// Seeds per batch. Large enough that the message round trip is noise, small enough that a kill
// throws away seconds rather than minutes.
const BATCH = 4;

// How many distinct boards to hold per par value.
//
// Sixty was right while the target set was a thousand boards. It is not any more, and the checkpoint
// says so: on the 7x7 every par from 4 to 36 sits at exactly sixty, which is the cap speaking, not
// the search running out. Boards past the cap were found and thrown away. So this is a flag now -
// mining longer at sixty adds nothing below par 37, and the run has to be told it may keep more
// before another night of it is worth anything.
const KEEP_PER_PAR = flag("keep", 60);
const MIN_PAR = 4;

// A component larger than this belongs to a board too open to be an interesting puzzle, and the
// walk would cost more than it is worth. Rejecting it is a filter, not a failure.
//
// It is also the single biggest lever on throughput, because the rejected walks are the expensive
// ones: a layout that overruns the cap costs the full cap before it is thrown away, while a good
// one finishes in a fraction of it. Lowering the cap makes the common case - rejection - cheap, and
// biases what survives towards the tight boards that carry the deep puzzles anyway.
const MAX_STATES = flag("maxstates", BOARD_SIZE >= 8 ? 700_000 : 500_000);

// A real hill climb, not a nudge. At 46 steps the search reached par 34 on a 7x7 and stopped:
// every seed threw away a fresh random layout after barely leaving it. The landscape is mostly
// plateau, so crossing it is most of the work and the walk has to be given room to do it.
const CLIMB_STEPS = flag("climb", 420);
const HARVEST_PER_COMPONENT = 6;

// Piece counts, by board size and overridable.
//
// The 6x6 is not a smaller 7x7. Thirty-six cells against forty-nine means the same ten to eighteen
// pieces run it to a density the 7x7 never sees, and a dense small board is the one that fills an
// edge line - which is the stripe this whole corpus was remined to be rid of. Eight to thirteen
// keeps it in the range the printed Rush Hour sets use.
const CAR_DEFAULTS = { 6: { min: 8, max: 13 }, 7: { min: 10, max: 18 }, 8: { min: 13, max: 22 } };
const CARS = {
  min: flag("mincars", (CAR_DEFAULTS[BOARD_SIZE] ?? CAR_DEFAULTS[8]).min),
  max: flag("maxcars", (CAR_DEFAULTS[BOARD_SIZE] ?? CAR_DEFAULTS[8]).max),
};

const OUT_DIR = "data/checkpoints";
const CHECKPOINT = path.join(OUT_DIR, `native-${BOARD_SIZE}x${BOARD_SIZE}.json`);

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
      `resuming ${BOARD_SIZE}x${BOARD_SIZE}: ${seen.size} boards, ` +
        `${buckets.size} par values, next seed ${parsed.nextSeed}`,
    );
    return { buckets, seen, nextSeed: parsed.nextSeed, seedsDone: parsed.seedsDone ?? 0 };
  } catch {
    console.log(`starting ${BOARD_SIZE}x${BOARD_SIZE} from scratch`);
    return { buckets: new Map(), seen: new Set(), nextSeed: BOARD_SIZE * 1_000_003, seedsDone: 0 };
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
  await mkdir(OUT_DIR, { recursive: true });
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

/// The lowest par still worth mining: everything under it already has all the boards it can hold.
///
/// Without this the workers keep producing easy boards long after those buckets filled - after two
/// hundred seeds every par up to 14 was full and most of what the searches returned was discarded on
/// arrival. Handing the floor back with each batch points the whole machine at the part of the range
/// that is still short.
function parFloor(state) {
  let floor = MIN_PAR;
  while ((state.buckets.get(floor)?.length ?? 0) >= KEEP_PER_PAR) floor += 1;
  return floor;
}

function summary(state) {
  const pars = [...state.buckets.keys()].sort((a, b) => a - b);
  if (!pars.length) return "nothing yet";
  const full = pars.filter((par) => state.buckets.get(par).length >= KEEP_PER_PAR).length;
  return `${state.seen.size} boards, par ${pars[0]}-${pars.at(-1)}, ${full}/${pars.length} buckets full`;
}

const state = await loadCheckpoint();
const deadline = Date.now() + HOURS * 3600_000;
let stopping = false;
let deepestSeen = 0;
let lastSave = Date.now();

// Ctrl-C writes a checkpoint and leaves cleanly rather than dropping everything since the last one.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\nstopping: finishing the batches in flight, then saving");
  });
}

console.log(
  `mining ${BOARD_SIZE}x${BOARD_SIZE} on ${WORKERS} workers for ${HOURS}h; ` +
    `checkpoint ${CHECKPOINT}`,
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
    worker.postMessage({ from, to: from + BATCH, minPar: parFloor(state) });
  };

  for (let index = 0; index < WORKERS; index += 1) {
    const worker = new Worker(new URL("./breadth-worker.mjs", import.meta.url), {
      workerData: {
        boardSize: BOARD_SIZE,
        maxStates: MAX_STATES,
        climbSteps: CLIMB_STEPS,
        minCars: CARS.min,
        maxCars: CARS.max,
        minPar: MIN_PAR,
        harvestPerComponent: HARVEST_PER_COMPONENT,
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
            `deepest ${deepestSeen}; floor ${parFloor(state)}; +${added} last batch; ` +
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
