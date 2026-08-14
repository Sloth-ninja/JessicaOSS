#!/usr/bin/env node
// Stop hook (BUILD_PLAN §6.3): run unit tests (where a test script exists) and the
// eval smoke subset. On failure exit 2 so the agent keeps working instead of stopping.
"use strict";
const { execSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {}
  // Prevent infinite stop loops: if a previous Stop hook already blocked, let it stop.
  if (input.stop_hook_active) process.exit(0);

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const failures = [];
  const run = (label, cmd, cwd) => {
    try {
      execSync(cmd, { cwd, stdio: "pipe", timeout: 280000 });
    } catch (err) {
      const out = [err.stdout, err.stderr].filter(Boolean).map(String).join("\n");
      // Tolerate the known vitest worker IPC flake: every test passed but the
      // runner exited non-zero with an unhandled 'Timeout calling "onTaskUpdate"'.
      // See docs/DURABLE_LESSONS.md 2026-08-13 (owner-approved 14/08/2026).
      // Real failures still block: both summary lines must show ONLY passes,
      // and the flake signature must be present. Never silent — logs a note.
      const summaryLines = out.match(/^\s*(Test Files|Tests)[^\n]*$/gm)?.join("\n") ?? "failed";
      const flakeOnly =
        /^\s*Test Files\s+\d+ passed \(\d+\)\s*$/m.test(out) &&
        /^\s*Tests\s+\d+ passed \(\d+\)\s*$/m.test(out) &&
        !/failed/.test(summaryLines) &&
        out.includes('Timeout calling "onTaskUpdate"');
      if (flakeOnly) {
        console.log(`stop-check: ${label} — all tests passed; tolerated known vitest worker IPC flake.`);
        return;
      }
      failures.push(`--- ${label} failed ---\n${out.slice(0, 6000)}`);
    }
  };

  // Unit tests: only where a project defines a test script (none exist upstream yet).
  for (const project of ["backend", "frontend", "evals"]) {
    const pkgPath = path.join(root, project, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.scripts && pkg.scripts.test && existsSync(path.join(root, project, "node_modules"))) {
      run(`${project} tests`, "npm test", path.join(root, project));
    }
  }

  // Eval smoke subset (skip gracefully if evals deps not installed).
  if (existsSync(path.join(root, "evals", "node_modules"))) {
    run("evals:smoke", "npm run evals:smoke", root);
  } else {
    console.log("stop-check: evals/node_modules missing — run `cd evals && npm install` (smoke skipped).");
  }

  if (failures.length > 0) {
    process.stderr.write(`Stop blocked — tests/evals failing, keep working:\n${failures.join("\n")}\n`);
    process.exit(2);
  }
  process.exit(0);
});
