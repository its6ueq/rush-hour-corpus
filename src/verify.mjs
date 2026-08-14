// Checks the corpus against a solver that shares no code with the one that built it.
//
//   node src/verify.mjs                 sample every size and every par
//   node src/verify.mjs --size 8        one board size
//   node src/verify.mjs --per-par 5     how many boards to check at each par
//   node src/verify.mjs --all           every board, which takes a long time at the deep end
//
// This is deliberately the slow, obvious implementation: plain objects, string keys, a forward
// breadth-first search from the start position. It shares nothing with src/explorer.mjs - not the
// state encoding, not the move generator, not the goal test. Agreement between the two therefore
// means something; if this file imported the fast one it would only be checking that a function
// returns what it returned last time.
//
// A move is one car sliding any distance along its own line, and the exit slide counts. The
// difference matters: stopping when the exit lane merely becomes clear reports every board as one
// move short.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? Number(argv[index + 1]) : fallback;
};

const ONLY_SIZE = flag("size", 0);
const PER_PAR = argv.includes("--all") ? Infinity : flag("per-par", 2);
const CAP = flag("cap", 6_000_000);

function key(cars) {
  let out = "";
  for (const car of cars) out += car.r + "," + car.c + ";";
  return out;
}

/// Fewest moves to drive the target car off the right-hand edge, or null if the search gave up.
function solve(board, size) {
  const start = board.cars.map(([row, column, length, orientation], index) => ({
    r: row,
    c: column,
    n: length,
    h: orientation === "H",
    t: index === 0,
  }));
  const hero = start.findIndex((car) => car.t);

  const seen = new Set([key(start)]);
  let frontier = [start];
  let depth = 0;
  let visited = 1;

  while (frontier.length) {
    const next = [];
    for (const state of frontier) {
      if (state[hero].c + state[hero].n === size) return { par: depth, visited };

      const grid = new Int16Array(size * size).fill(-1);
      for (let i = 0; i < state.length; i += 1) {
        const car = state[i];
        for (let part = 0; part < car.n; part += 1) {
          grid[car.h ? car.r * size + car.c + part : (car.r + part) * size + car.c] = i;
        }
      }

      for (let i = 0; i < state.length; i += 1) {
        const car = state[i];
        for (const direction of [-1, 1]) {
          for (let step = 1; ; step += 1) {
            const row = car.h ? car.r : car.r + direction * step;
            const column = car.h ? car.c + direction * step : car.c;
            if (row < 0 || column < 0) break;
            if (car.h ? column + car.n > size : row + car.n > size) break;

            const edge = direction < 0
              ? (car.h ? column : row)
              : (car.h ? column + car.n - 1 : row + car.n - 1);
            const cell = car.h ? grid[car.r * size + edge] : grid[edge * size + car.c];
            if (cell !== -1 && cell !== i) break;

            const moved = state.map((other, j) => (j === i ? { ...other, r: row, c: column } : other));
            const id = key(moved);
            if (seen.has(id)) continue;
            seen.add(id);
            visited += 1;
            if (visited > CAP) return { par: null, why: "over cap" };
            next.push(moved);
          }
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  return { par: null, why: "unsolvable" };
}

let checked = 0;
let agreed = 0;
const problems = [];

for (const size of ONLY_SIZE ? [ONLY_SIZE] : [6, 7, 8]) {
  const directory = path.join("data", `${size}x${size}`);
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.startsWith("par-")).sort();
  } catch {
    console.log(`${size}x${size}: no data directory, skipped`);
    continue;
  }

  let sizeChecked = 0;
  let sizeAgreed = 0;
  for (const name of names) {
    const file = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    const sample = file.boards.slice(0, PER_PAR === Infinity ? file.boards.length : PER_PAR);
    for (const board of sample) {
      const result = solve(board, size);
      checked += 1;
      sizeChecked += 1;
      if (result.par === file.par) {
        agreed += 1;
        sizeAgreed += 1;
      } else {
        problems.push(`${size}x${size} par ${file.par}: independent solver says ${result.par ?? result.why}`);
      }
    }
  }
  console.log(`${size}x${size}: ${sizeAgreed}/${sizeChecked} boards agree`);
}

console.log(`\n${agreed}/${checked} boards agree with the independent solver`);
for (const line of problems.slice(0, 40)) console.log(`  MISMATCH ${line}`);
process.exit(problems.length ? 1 : 0);
