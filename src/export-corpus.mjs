// Turns the miners' checkpoints into the published corpus.
//
//   node src/export-corpus.mjs
//
// Two things change on the way out.
//
// Stored solutions are dropped. They are two thirds of the bytes and every one of them is
// reproducible from the board by the solver in this repository, so shipping them would be
// shipping a cache - and a cache nobody can check. Without them the par on each board is a
// claim the reader can verify (`node src/verify.mjs`) rather than a number to be trusted.
//
// The board shape is flattened. The miner carries display fields - colour, name, id - that
// mean something to the game it was written for and nothing to anyone else. A car here is
// four values: row, column, length, orientation.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CHECKPOINTS = "data/checkpoints";
const OUT = "data";

/// Which checkpoint files belong to which board size.
function sizeOf(name) {
  if (name.includes("8x8")) return 8;
  if (name.includes("7x7")) return 7;
  if (name.includes("6x6")) return 6;
  return null;
}

/// row, column, length, orientation - and the target car is always first.
function flatten(cars) {
  const target = cars.find((car) => car.target);
  const rest = cars.filter((car) => !car.target);
  return [target, ...rest].map((car) => [car.row, car.col, car.length, car.orientation]);
}

const files = (await readdir(CHECKPOINTS)).filter(
  (name) => name.endsWith(".json") && !name.endsWith(".tmp"),
);

const bySize = new Map([
  [6, new Map()],
  [7, new Map()],
  [8, new Map()],
]);
const seen = new Set();
let duplicates = 0;

for (const name of files) {
  const size = sizeOf(name);
  if (!size) continue;
  const parsed = JSON.parse(await readFile(path.join(CHECKPOINTS, name), "utf8"));
  for (const [par, boards] of Object.entries(parsed.buckets ?? {})) {
    const depth = Number(par);
    const bucket = bySize.get(size);
    const list = bucket.get(depth) ?? [];
    for (const board of boards) {
      const identity = size + ":" + board.signature;
      if (seen.has(identity)) {
        duplicates += 1;
        continue;
      }
      seen.add(identity);
      list.push({ exit: board.exitRow, par: depth, cars: flatten(board.cars) });
    }
    bucket.set(depth, list);
  }
}

const summary = [];
for (const [size, buckets] of bySize) {
  const pars = [...buckets.keys()].sort((left, right) => left - right);
  if (!pars.length) continue;

  const boards = [];
  for (const par of pars) for (const board of buckets.get(par)) boards.push(board);

  const directory = path.join(OUT, `${size}x${size}`);
  await mkdir(directory, { recursive: true });

  // One file per par, so a reader who only wants the hard end downloads only the hard end.
  for (const par of pars) {
    await writeFile(
      path.join(directory, `par-${String(par).padStart(3, "0")}.json`),
      JSON.stringify({ boardSize: size, par, count: buckets.get(par).length, boards: buckets.get(par) }),
    );
  }

  summary.push({
    boardSize: size,
    boards: boards.length,
    parMin: pars[0],
    parMax: pars.at(-1),
    parValues: pars.length,
    perPar: Object.fromEntries(pars.map((par) => [par, buckets.get(par).length])),
  });
  console.log(
    `${size}x${size}: ${boards.length} boards, par ${pars[0]}-${pars.at(-1)}, ${pars.length} par values`,
  );
}

await writeFile(path.join(OUT, "index.json"), JSON.stringify({ sizes: summary }, null, 2));
console.log(`${duplicates} duplicate placements skipped; wrote data/index.json`);
