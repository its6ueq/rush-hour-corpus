// One deep-mining batch per message, on a background thread.
//
// Same contract as native-miner-worker.mjs - a batch is a range of seeds, everything is a pure
// function of them - and a different search. See mine-deep-boards.mjs for why.

import { parentPort, workerData } from "node:worker_threads";

import { Explorer, hasTiledEdge, mutate, seededRandom, signature } from "./explorer.mjs";

const {
  boardSize,
  maxStates,
  climbSteps,
  minPar,
  perDepth,
  bandFraction,
  perturbations,
  pool,
} = workerData;

const explorer = new Explorer(boardSize, maxStates);

/// Takes boards out of the deep end of a scored component - as many as there are, not one.
///
/// The breadth miner samples one position per depth across the whole range, which is right when the
/// job is to fill par 12 and par 30 evenly. It is wrong here. A component eighty moves deep holds
/// many distinct positions at depth seventy-six, every one of them a different par-76 board, and
/// the walk that priced them has already been paid for. Sampling one and discarding the rest throws
/// away the only part of the run that was expensive to reach.
///
/// So this scans once and keeps up to `perDepth` positions at every depth in the top band, by
/// reservoir so the choice does not depend on enumeration order.
function harvestDeep(component, cars, obstacles, random, floorPar, out) {
  const deepest = component.maxDistance;
  if (deepest < floorPar) return;

  const floor = Math.max(floorPar, Math.ceil(deepest * bandFraction));

  // Reservoir of size perDepth per depth: `kept` holds the chosen nodes, `seen` how many candidates
  // that depth has offered so far.
  const kept = new Map();
  const seen = new Map();
  for (let node = 0; node < component.total; node += 1) {
    const depth = explorer.distance[node];
    if (depth < floor) continue;
    const count = (seen.get(depth) ?? 0) + 1;
    seen.set(depth, count);
    let slots = kept.get(depth);
    if (!slots) {
      slots = [];
      kept.set(depth, slots);
    }
    if (slots.length < perDepth) {
      slots.push(node);
      continue;
    }
    const swap = Math.floor(random() * count);
    if (swap < perDepth) slots[swap] = node;
  }

  for (const [par, nodes] of kept) {
    for (const node of nodes) {
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
}

/// Walks a layout, lifting out any piece the walk proves can never move. Unchanged from the breadth
/// miner: a board with a frozen piece is a board with scenery on it.
function settle(cars, obstacles) {
  let current = cars;
  // Two passes, not the breadth miner's four. Up here a walk costs seconds, and a board that still
  // has frozen pieces after two liftings is being rebuilt rather than repaired.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const component = explorer.run(current, obstacles);
    if (!component) return null;
    if (!component.frozen) return { component, cars: current };
    if (current.length - component.frozen.length < 6) return null;
    const dead = new Set(component.frozen);
    current = current.filter((car, index) => car.target || !dead.has(index));
  }
  return null;
}

/// One kick-and-climb from a board that is already deep.
///
/// The kick has to be big enough to leave the basin the pool board sits in and small enough to stay
/// in the deep region of the landscape - that is the whole bet of iterated local search, and it is
/// a better bet than a fresh random layout because a random 8x8 is nowhere near this depth and
/// spends its whole climb budget getting back to where this one starts.
function mineSeed(seed, floorPar) {
  const random = seededRandom(seed);

  // Indexed, not sampled. The first `pool.length` seeds therefore walk every board in the pool
  // exactly once - the sweep that collects what dense harvesting can take from components the
  // corpus already owns - and only after that do seeds start revisiting boards with new kicks.
  const start = pool[seed % pool.length];
  const obstacles = start.obstacles ?? [];
  let cars = start.cars;
  const found = [];

  // The unkicked board first.
  //
  // It was harvested at six depths when it was mined and its component holds many more than that
  // at every depth. This walk would have to happen anyway to have something to climb from, so the
  // boards it returns are free.
  let settled = settle(cars, obstacles);
  if (settled) {
    cars = settled.cars;
    harvestDeep(settled.component, cars, obstacles, random, floorPar, found);
  }

  const kicks = 1 + Math.floor(random() * perturbations);
  for (let kick = 0; kick < kicks; kick += 1) {
    const candidate = mutate(cars, boardSize, random);
    if (candidate) cars = candidate;
  }

  settled = settle(cars, obstacles);
  if (!settled) return { found, best: -1 };
  cars = settled.cars;
  let best = settled.component.maxDistance;
  harvestDeep(settled.component, cars, obstacles, random, floorPar, found);

  for (let step = 0; step < climbSteps; step += 1) {
    const candidate = mutate(cars, boardSize, random);
    if (!candidate) continue;
    const next = settle(candidate, obstacles);
    if (!next || next.component.maxDistance < best) continue;
    cars = next.cars;

    // Harvested on equal depth too, not only on improvement.
    //
    // The breadth miner harvests on strict improvement, which is right when what it wants is the
    // ladder of depths on the way up. Here the plateau is the target: a sideways move at depth
    // seventy-eight lands in a different component that is also seventy-eight deep, holding a
    // different set of par-78 boards. Those are exactly the boards the last chapters are short of.
    if (next.component.maxDistance >= best) {
      best = next.component.maxDistance;
      harvestDeep(next.component, cars, obstacles, random, floorPar, found);
    }
  }

  return { found, best };
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
