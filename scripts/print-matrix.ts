/**
 * Print the coverage matrix.
 *
 * The table itself lives in `src/disposition/matrix.ts` and is computed by
 * running the mappers. This file only decides how to fit it in a terminal, so
 * the printed table and the one on the console page cannot disagree.
 *
 * No credentials, no network, no calls.
 */

import {
  CELL_MEANING,
  type Cell,
  SURFACES_IN_ORDER,
  coverage,
} from "../src/disposition/matrix.js";

function symbol(cell: Cell): string {
  switch (cell.kind) {
    case "yes":
      return "yes";
    case "app":
      return "app";
    case "derived":
      return "derived";
    case "no":
      return "no";
    case "collapsed":
      return `-> ${cell.collapsedOnto}`;
    case "none":
      return "-";
  }
}

function main(): void {
  const rows = coverage();
  const width = Math.max(...rows.map((row) => row.ending.length)) + 2;
  const header = "ending".padEnd(width) + SURFACES_IN_ORDER.map((s) => s.padEnd(20)).join("");

  console.log("\nCan this surface tell you the call ended this way?\n");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const row of rows) {
    console.log(
      row.ending.padEnd(width) + row.cells.map((c) => symbol(c).padEnd(20)).join(""),
    );
  }

  console.log("");
  for (const [kind, meaning] of Object.entries(CELL_MEANING)) {
    if (kind === "none") continue;
    const label = kind === "collapsed" ? "-> x" : kind;
    console.log(`${label.padEnd(9)}${meaning}`);
  }
  console.log("");
}

main();
