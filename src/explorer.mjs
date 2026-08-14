// Mines 7x7 and 8x8 Rush Hour boards natively, instead of padding a 6x6 one out to size.
//
// Why this exists
// ---------------
// The published Rush Hour database is 6x6. The old importer made bigger boards by pasting a 6x6
// into the middle of a larger grid and filling the leftover row with cars whose lengths add up to
// exactly the width - 2+2+3 on a 7, 3+3+2 on an 8, top and bottom. A horizontal car only ever
// slides along its own row, and a row packed solid has nowhere to slide to, so those cars could
// never move: on every single 7x7 and 8x8 in the catalog, three to six of the pieces were scenery.
// It is also what a player sees as the same solid stripe across the top of board after board.
//
// The method
// ----------
// Rush Hour moves are reversible, so every position reachable from a layout forms one connected
// component of a graph whose vertices are placements of that fixed set of cars.
//
//   1. Walk the whole component once from the start.
//   2. Breadth-first search backwards from every solved position at once. Each vertex's distance is
//      then the exact minimum number of moves that solves it. One walk scores every position in the
//      component rather than one puzzle at a time - this is how Fogleman built his database, and it
//      is the reason mining is affordable at all.
//   3. The deepest vertex is the hardest puzzle this arrangement of cars can pose.
//
// Two consequences worth stating, because the old miner threw both away:
//
//   * One walk yields a playable board at *every* distance in the component, not just the maximum.
//     A single expensive search produces puzzles across the whole difficulty range.
//   * The walk also proves which cars are furniture. If a car sits at the same offset in every
//     vertex of the component, it cannot move in any line of play, and the layout is rejected.
//
// Hill climbing on top: move one car, rescore, keep the change unless the depth got worse. Sideways
// moves are accepted because this landscape is mostly plateau - most single-car moves leave the
// deepest position exactly where it was.

const MAX_CARS = 26;

export const COLORS = [
  ["#2f80ed", "Xe xanh"],
  ["#ffc247", "Xe vàng"],
  ["#8c6ff7", "Xe tím"],
  ["#28c79a", "Xe ngọc"],
  ["#ff7b54", "Xe cam"],
  ["#38b9d6", "Xe lam"],
  ["#ec70ad", "Xe hồng"],
  ["#9aa6b2", "Xe bạc"],
];

/// Deterministic generator, so a worker's whole run replays from its seed alone. That is what makes
/// the overnight run resumable: a checkpoint stores which seeds are done, not where a search was.
export function seededRandom(seed) {
  let state = (seed >>> 0) || 0x9e3779b1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

function axisOf(car) {
  return car.orientation === "H" ? car.col : car.row;
}

/// Reusable scratch space for one worker. The buffers are the expensive part of a search - tens of
/// megabytes - and a run does hundreds of thousands of searches, so they are allocated once.
export class Explorer {
  constructor(boardSize, maxStates) {
    this.boardSize = boardSize;
    this.maxStates = maxStates;
    this.cells = boardSize * boardSize;

    this.states = new Uint8Array(maxStates * MAX_CARS);
    this.distance = new Int32Array(maxStates);
    this.queue = new Int32Array(maxStates);
    this.grid = new Int16Array(this.cells);
    this.blocked = new Uint8Array(this.cells);

    let tableSize = 1024;
    while (tableSize < maxStates * 2) tableSize <<= 1;
    this.table = new Int32Array(tableSize);
    // Stamped rather than cleared. The table is megabytes and a run does hundreds of thousands of
    // searches; wiping it between them costs more than the searches near the small end. A slot
    // belongs to this search only if its stamp matches, so the previous contents are simply invisible.
    this.stamp = new Int32Array(tableSize);
    this.tableMask = tableSize - 1;
    this.generation = 0;

    // Every node expansion needs a clean board to read occupancy off. Obstacles never move, so the
    // clean board is built once per search and memcopied per node instead of being re-derived.
    this.template = new Int16Array(this.cells);

    this.horizontal = new Uint8Array(MAX_CARS);
    this.lengths = new Uint8Array(MAX_CARS);
    this.line = new Uint8Array(MAX_CARS);
    this.axisMin = new Uint8Array(MAX_CARS);
    this.axisMax = new Uint8Array(MAX_CARS);
    this.probe = new Uint8Array(MAX_CARS);
  }

  /// Walks the component and scores every position in it.
  ///
  /// Returns null when the layout is unusable: no solved position is reachable, the component is
  /// larger than the cap (a board that open is not an interesting puzzle), or some car never moves
  /// anywhere in the component.
  run(cars, obstacles) {
    const size = this.boardSize;
    const count = cars.length;
    if (count > MAX_CARS) return null;

    const targetIndex = cars.findIndex((car) => car.target);
    if (targetIndex < 0) return null;
    const goal = size - cars[targetIndex].length;

    const { states, distance, queue, grid, blocked, table, stamp, template } = this;
    const { horizontal, lengths, line, axisMin, axisMax, probe } = this;
    const tableMask = this.tableMask;

    for (let index = 0; index < count; index += 1) {
      const car = cars[index];
      horizontal[index] = car.orientation === "H" ? 1 : 0;
      lengths[index] = car.length;
      line[index] = car.orientation === "H" ? car.row : car.col;
    }

    blocked.fill(0);
    for (const obstacle of obstacles ?? []) {
      for (let row = 0; row < (obstacle.height ?? 1); row += 1) {
        for (let col = 0; col < (obstacle.width ?? 1); col += 1) {
          blocked[(obstacle.row + row) * size + obstacle.col + col] = 1;
        }
      }
    }

    template.fill(-1);
    for (let cell = 0; cell < this.cells; cell += 1) {
      if (blocked[cell]) template[cell] = -2;
    }
    this.generation += 1;
    const run = this.generation;

    const hashAt = (node) => {
      let hash = 2166136261;
      const base = node * MAX_CARS;
      for (let offset = 0; offset < count; offset += 1) {
        hash ^= states[base + offset];
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    };

    const sameAt = (left, right) => {
      const a = left * MAX_CARS;
      const b = right * MAX_CARS;
      for (let offset = 0; offset < count; offset += 1) {
        if (states[a + offset] !== states[b + offset]) return false;
      }
      return true;
    };

    /// Returns the existing index for this position, or -1 after claiming the slot for it.
    const intern = (node) => {
      let slot = hashAt(node) & tableMask;
      while (stamp[slot] === run) {
        if (sameAt(table[slot], node)) return table[slot];
        slot = (slot + 1) & tableMask;
      }
      stamp[slot] = run;
      table[slot] = node;
      return -1;
    };

    for (let index = 0; index < count; index += 1) {
      const axis = axisOf(cars[index]);
      states[index] = axis;
      axisMin[index] = axis;
      axisMax[index] = axis;
    }
    intern(0);
    let total = 1;

    // Neighbours are recomputed rather than stored: an edge list for half a million positions costs
    // far more memory than walking the board twice costs time.
    const fillGrid = (node) => {
      grid.set(template);
      const base = node * MAX_CARS;
      for (let index = 0; index < count; index += 1) {
        const axis = states[base + index];
        const fixed = line[index];
        for (let part = 0; part < lengths[index]; part += 1) {
          grid[horizontal[index] ? fixed * size + axis + part : (axis + part) * size + fixed] = index;
        }
      }
    };

    // Pass one: enumerate the component.
    for (let cursor = 0; cursor < total; cursor += 1) {
      fillGrid(cursor);
      const base = cursor * MAX_CARS;
      for (let index = 0; index < count; index += 1) {
        const axis = states[base + index];
        const fixed = line[index];
        const length = lengths[index];
        for (let direction = -1; direction <= 1; direction += 2) {
          for (let next = axis + direction; next >= 0 && next <= size - length; next += direction) {
            const edge = direction < 0 ? next : next + length - 1;
            const occupant = grid[horizontal[index] ? fixed * size + edge : edge * size + fixed];
            if (occupant !== -1 && occupant !== index) break;

            if (total >= this.maxStates) return null;
            const slot = total * MAX_CARS;
            for (let copy = 0; copy < count; copy += 1) states[slot + copy] = states[base + copy];
            states[slot + index] = next;
            if (intern(total) === -1) {
              if (next < axisMin[index]) axisMin[index] = next;
              if (next > axisMax[index]) axisMax[index] = next;
              total += 1;
            }
          }
        }
      }
    }

    // A car at one offset in every position of the component is scenery: no line of play can ever
    // touch it. At the densities that produce deep puzzles most layouts have one or two, so throwing
    // the layout away costs four fifths of everything generated. Report them instead and let the
    // caller lift them out and walk again - the walk is what the search spends its time on, and
    // pass two is skipped entirely here, so a rejected layout is priced at half a search.
    let frozen = null;
    for (let index = 0; index < count; index += 1) {
      if (axisMin[index] !== axisMax[index]) continue;
      (frozen ??= []).push(index);
    }
    if (frozen) return { frozen, total };

    // Pass two: distance to the nearest solved position, breadth first from all of them at once.
    distance.fill(-1, 0, total);
    let head = 0;
    let tail = 0;
    for (let node = 0; node < total; node += 1) {
      if (states[node * MAX_CARS + targetIndex] !== goal) continue;
      distance[node] = 0;
      queue[tail] = node;
      tail += 1;
    }
    if (tail === 0) return null;

    const lookup = () => {
      let slot = 2166136261;
      for (let offset = 0; offset < count; offset += 1) {
        slot ^= probe[offset];
        slot = Math.imul(slot, 16777619);
      }
      slot = (slot >>> 0) & tableMask;
      while (stamp[slot] === run) {
        const candidate = table[slot];
        const base = candidate * MAX_CARS;
        let same = true;
        for (let offset = 0; offset < count; offset += 1) {
          if (states[base + offset] !== probe[offset]) { same = false; break; }
        }
        if (same) return candidate;
        slot = (slot + 1) & tableMask;
      }
      return -1;
    };

    let maxDistance = 0;
    while (head < tail) {
      const node = queue[head];
      head += 1;
      const step = distance[node] + 1;
      fillGrid(node);
      const base = node * MAX_CARS;
      for (let index = 0; index < count; index += 1) {
        const axis = states[base + index];
        const fixed = line[index];
        const length = lengths[index];
        for (let direction = -1; direction <= 1; direction += 2) {
          for (let next = axis + direction; next >= 0 && next <= size - length; next += direction) {
            const edge = direction < 0 ? next : next + length - 1;
            const occupant = grid[horizontal[index] ? fixed * size + edge : edge * size + fixed];
            if (occupant !== -1 && occupant !== index) break;

            for (let copy = 0; copy < count; copy += 1) probe[copy] = states[base + copy];
            probe[index] = next;
            const neighbour = lookup();
            if (neighbour < 0 || distance[neighbour] !== -1) continue;
            distance[neighbour] = step;
            queue[tail] = neighbour;
            tail += 1;
            if (step > maxDistance) maxDistance = step;
          }
        }
      }
    }

    return { total, count, targetIndex, goal, maxDistance, frozen: null };
  }

  /// The car placements of one position in the last walk.
  carsAt(node, cars) {
    const base = node * MAX_CARS;
    return cars.map((car, index) => {
      const axis = this.states[base + index];
      return car.orientation === "H" ? { ...car, col: axis } : { ...car, row: axis };
    });
  }

  /// The optimal move list out of a position, read straight off the distance field: from any
  /// position, step to a neighbour one closer to a solution. No second search is needed, and the
  /// path is optimal by construction rather than by assertion.
  solutionFrom(node, cars) {
    const size = this.boardSize;
    const count = cars.length;
    const { states, distance, grid, template, probe, horizontal, lengths, line } = this;
    const path = [];
    let current = node;

    while (distance[current] > 0) {
      grid.set(template);
      const base = current * MAX_CARS;
      for (let index = 0; index < count; index += 1) {
        const axis = states[base + index];
        const fixed = line[index];
        for (let part = 0; part < lengths[index]; part += 1) {
          grid[horizontal[index] ? fixed * size + axis + part : (axis + part) * size + fixed] = index;
        }
      }

      let stepped = false;
      for (let index = 0; index < count && !stepped; index += 1) {
        const axis = states[base + index];
        const fixed = line[index];
        const length = lengths[index];
        for (let direction = -1; direction <= 1 && !stepped; direction += 2) {
          for (let next = axis + direction; next >= 0 && next <= size - length; next += direction) {
            const edge = direction < 0 ? next : next + length - 1;
            const occupant = grid[horizontal[index] ? fixed * size + edge : edge * size + fixed];
            if (occupant !== -1 && occupant !== index) break;

            for (let copy = 0; copy < count; copy += 1) probe[copy] = states[base + copy];
            probe[index] = next;
            const neighbour = this.lookupProbe(count);
            if (neighbour < 0 || distance[neighbour] !== distance[current] - 1) continue;
            path.push({ index, from: axis, to: next });
            current = neighbour;
            stepped = true;
            break;
          }
        }
      }
      if (!stepped) return null;
    }
    return path;
  }

  lookupProbe(count) {
    const { states, table, stamp, probe } = this;
    let slot = 2166136261;
    for (let offset = 0; offset < count; offset += 1) {
      slot ^= probe[offset];
      slot = Math.imul(slot, 16777619);
    }
    slot = (slot >>> 0) & this.tableMask;
    while (stamp[slot] === this.generation) {
      const candidate = table[slot];
      const base = candidate * MAX_CARS;
      let same = true;
      for (let offset = 0; offset < count; offset += 1) {
        if (states[base + offset] !== probe[offset]) { same = false; break; }
      }
      if (same) return candidate;
      slot = (slot + 1) & this.tableMask;
    }
    return -1;
  }
}

export function legal(cars, boardSize) {
  const occupied = new Set();
  for (const car of cars) {
    for (let part = 0; part < car.length; part += 1) {
      const row = car.orientation === "H" ? car.row : car.row + part;
      const col = car.orientation === "H" ? car.col + part : car.col;
      if (row < 0 || col < 0 || row >= boardSize || col >= boardSize) return false;
      const cell = row * boardSize + col;
      if (occupied.has(cell)) return false;
      occupied.add(cell);
    }
  }
  return true;
}

/// True when an edge row or column has no gap in it.
///
/// Occupancy, not orientation. An earlier version summed the lengths of the pieces running along the
/// line, which misses a column closed by three vertical cars plus the nose of the horizontal target
/// car: seven cells from matching pieces, eight cells full. The walk accepts such a board - the
/// horizontal car can pull out and free the column, so nothing is permanently stuck - but a solid
/// line of metal down the edge of the board is exactly what a player sees and objects to, whichever
/// way the pieces happen to point.
export function hasTiledEdge(cars, boardSize) {
  const last = boardSize - 1;
  const filled = new Uint8Array(boardSize * boardSize);
  for (const car of cars) {
    const horizontal = car.orientation === "H";
    for (let part = 0; part < car.length; part += 1) {
      const row = horizontal ? car.row : car.row + part;
      const col = horizontal ? car.col + part : car.col;
      if (row >= 0 && col >= 0 && row < boardSize && col < boardSize) filled[row * boardSize + col] = 1;
    }
  }

  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < boardSize; index += 1) {
    top += filled[index];
    bottom += filled[last * boardSize + index];
    left += filled[index * boardSize];
    right += filled[index * boardSize + last];
  }
  return top === boardSize || bottom === boardSize || left === boardSize || right === boardSize;
}

/// Whether a piece fits, against a grid of what is already down. Rejection sampling with a fresh
/// Set per attempt is quadratic, and at the fill fractions below a layout takes hundreds of
/// attempts, so the occupancy grid is what makes dense generation affordable at all.
function fits(occupied, boardSize, row, col, length, horizontal) {
  if (row < 0 || col < 0) return false;
  if (horizontal ? col + length > boardSize : row + length > boardSize) return false;
  if (horizontal ? row >= boardSize : col >= boardSize) return false;
  for (let part = 0; part < length; part += 1) {
    if (occupied[horizontal ? row * boardSize + col + part : (row + part) * boardSize + col]) return false;
  }
  return true;
}

function occupy(occupied, boardSize, car, value) {
  const horizontal = car.orientation === "H";
  for (let part = 0; part < car.length; part += 1) {
    occupied[horizontal ? car.row * boardSize + car.col + part : (car.row + part) * boardSize + car.col] = value;
  }
}

/// A fresh layout: the target car on the exit row, then trucks and cars packed in around it.
///
/// Density is the whole trick. A sparse board looks like a promising puzzle and is not: its pieces
/// barely interact, so the state space explodes into hundreds of thousands of positions that are
/// all two moves from a solution. Sixty sparse 8x8 layouts produced no usable board at all - every
/// one blew past the search cap. Packing four fifths of the board keeps the component small enough
/// to walk and is where the deep puzzles live, because a piece can only move when another moved
/// first.
export function randomLayout(boardSize, carCount, random) {
  const exitRow = 1 + Math.floor(random() * (boardSize - 2));
  const occupied = new Uint8Array(boardSize * boardSize);
  const hero = {
    id: "hero",
    row: exitRow,
    col: Math.floor(random() * (boardSize - 3)),
    length: 2,
    orientation: "H",
    color: "#f24855",
    name: "target",
    target: true,
  };
  occupy(occupied, boardSize, hero, 1);
  const cars = [hero];

  let attempts = 0;
  const budget = carCount * 140;
  while (cars.length < carCount && attempts < budget) {
    attempts += 1;
    const length = random() < 0.66 ? 2 : 3;
    const horizontal = random() < 0.5;
    const fixed = Math.floor(random() * boardSize);
    const axis = Math.floor(random() * (boardSize - length + 1));
    const row = horizontal ? fixed : axis;
    const col = horizontal ? axis : fixed;
    if (!fits(occupied, boardSize, row, col, length, horizontal)) continue;

    const paint = COLORS[cars.length % COLORS.length];
    const candidate = {
      id: `car-${cars.length}`,
      row,
      col,
      length,
      orientation: horizontal ? "H" : "V",
      color: paint[0],
      name: `car-${cars.length}`,
    };
    occupy(occupied, boardSize, candidate, 1);
    cars.push(candidate);
  }

  return { cars, exitRow };
}

/// Places one non-target car somewhere else, keeping the board legal.
export function mutate(cars, boardSize, random) {
  const occupied = new Uint8Array(boardSize * boardSize);
  for (const car of cars) occupy(occupied, boardSize, car, 1);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const pick = 1 + Math.floor(random() * (cars.length - 1));
    const car = cars[pick];
    occupy(occupied, boardSize, car, 0);

    const horizontal = random() < 0.3 ? car.orientation !== "H" : car.orientation === "H";
    const fixed = Math.floor(random() * boardSize);
    const axis = Math.floor(random() * (boardSize - car.length + 1));
    const row = horizontal ? fixed : axis;
    const col = horizontal ? axis : fixed;

    if (fits(occupied, boardSize, row, col, car.length, horizontal)) {
      const moved = { ...car, row, col, orientation: horizontal ? "H" : "V" };
      return cars.map((item, index) => (index === pick ? moved : item));
    }
    occupy(occupied, boardSize, car, 1);
  }
  return null;
}

/// Stable identity for a board: which pieces sit where. Two boards with the same signature are the
/// same puzzle however they were reached, which is what keeps a graded level set from being
/// four hundred boards wearing different paint.
export function signature(cars) {
  return cars
    .map((car) => `${car.row},${car.col},${car.length},${car.orientation}${car.target ? "*" : ""}`)
    .sort()
    .join("|");
}
