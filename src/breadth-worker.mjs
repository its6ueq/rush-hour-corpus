// One mining batch per message, on a background thread.
//
// A batch is a range of seeds. Everything a batch does is a pure function of its seeds, so the
// driver's checkpoint only has to record which seeds are finished - never where a search had got
// to. Killing the run loses at most the batches currently in flight.

import { parentPort, workerData } from "node:worker_threads";

import {
  Explorer,
  hasTiledEdge,
  mutate,
  randomLayout,
  seededRandom,
  signature,
} from "./explorer.mjs";

const { boardSize, maxStates, climbSteps, minCars, maxCars, minPar, harvestPerComponent } = workerData;

const explorer = new Explorer(boardSize, maxStates);

/// Takes playable boards out of a scored component.
///
/// The walk has already priced every position in it, so the marginal cost of a board here is a
/// lookup. Positions are taken from across the top of the range: the shallow end of a hard
/// component is a nearly-solved board, which reads to a player as a puzzle someone abandoned
/// halfway rather than as an easy one.
function harvest(component, cars, obstacles, random, floorPar, out) {
  const deepest = component.maxDistance;
  if (deepest < floorPar) return;

  const floor = Math.max(floorPar, Math.ceil(deepest * 0.45));
  const wanted = new Set();
  const slots = Math.min(harvestPerComponent, deepest - floor + 1);
  for (let index = 0; index < slots; index += 1) {
    const span = slots <= 1 ? 0 : index / (slots - 1);
    wanted.add(Math.round(floor + (deepest - floor) * span));
  }

  // One scan, reservoir-sampling a single position per wanted depth, so which board a component
  // contributes does not depend on the order the walk happened to enumerate positions in.
  const chosen = new Map();
  const seen = new Map();
  for (let node = 0; node < component.total; node += 1) {
    const depth = explorer.distance[node];
    if (!wanted.has(depth)) continue;
    const count = (seen.get(depth) ?? 0) + 1;
    seen.set(depth, count);
    if (random() < 1 / count) chosen.set(depth, node);
  }

  for (const [par, node] of chosen) {
    const placed = explorer.carsAt(node, cars);
    if (hasTiledEdge(placed, boardSize)) continue;
    const path = explorer.solutionFrom(node, cars);
    if (!path || path.length !== par) continue;

    out.push({
      boardSize,
      exitRow: placed.find((car) => car.target).row,
      cars: placed,
      obstacles,
      par,
      explored: component.total,
      solution: path.map((move) => ({ id: cars[move.index].id, from: move.from, to: move.to })),
      signature: signature(placed),
    });
  }
}

/// Walks a layout, lifting out any piece the walk proves can never move, until what is left is a
/// board where every car is in play. Returns null if that never settles or nothing is left.
function settle(cars, obstacles) {
  let current = cars;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const component = explorer.run(current, obstacles);
    if (!component) return null;
    if (!component.frozen) return { component, cars: current };
    if (current.length - component.frozen.length < 6) return null;
    const dead = new Set(component.frozen);
    current = current.filter((car, index) => car.target || !dead.has(index));
  }
  return null;
}

function mineSeed(seed, floorPar) {
  const random = seededRandom(seed);
  const carCount = minCars + Math.floor(random() * (maxCars - minCars + 1));
  let { cars, exitRow } = randomLayout(boardSize, carCount, random);
  const obstacles = [];
  const found = [];

  let settled = settle(cars, obstacles);
  if (settled) {
    cars = settled.cars;
    harvest(settled.component, cars, obstacles, random, floorPar, found);
  }

  // Sideways moves are kept deliberately: most single-car moves leave the deepest position exactly
  // where it was, and refusing them strands the walk on the first plateau it reaches. Random search
  // alone tops out around 55 moves; this is what gets past it.
  let best = settled ? settled.component.maxDistance : -1;
  for (let step = 0; step < climbSteps; step += 1) {
    const candidate = mutate(cars, boardSize, random);
    if (!candidate) continue;
    const next = settle(candidate, obstacles);
    if (!next || next.component.maxDistance < best) continue;
    cars = next.cars;
    if (next.component.maxDistance > best) {
      best = next.component.maxDistance;
      harvest(next.component, cars, obstacles, random, floorPar, found);
    }
  }

  return { found, exitRow, best };
}

parentPort.on("message", (batch) => {
  if (batch === null) {
    parentPort.close();
    return;
  }

  const started = Date.now();
  const boards = [];
  let deepest = 0;
  for (let seed = batch.from; seed < batch.to; seed += 1) {
    const { found, best } = mineSeed(seed, Math.max(minPar, batch.minPar ?? minPar));
    if (best > deepest) deepest = best;
    for (const board of found) boards.push(board);
  }

  parentPort.postMessage({
    from: batch.from,
    to: batch.to,
    boards,
    deepest,
    elapsed: Date.now() - started,
  });
});
