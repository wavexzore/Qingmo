#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { corpusSize, generateSearchCorpus } from "./fixtures/search-corpus.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    return process.argv[index + 1] ?? fallback;
  }
  const prefixed = process.argv.find((value) => value.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

const fixtureArg = argument("--fixtures", "10k");
const count =
  fixtureArg === "10k" ? 10_000 : fixtureArg === "100k" ? 100_000 : Number.parseInt(fixtureArg, 10);
if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`invalid --fixtures value: ${fixtureArg}`);
}

// 100k × ~4.5 KiB stays under the 512 MiB indexed-body cap, so every file
// participates in the query benchmark; indexing may still take several passes.
const targetBytes = Number.parseInt(argument("--bytes", count >= 100_000 ? "4608" : "2048"), 10);
const iterations = Number.parseInt(argument("--iterations", "5"), 10);
const keep = process.argv.includes("--keep");
const root = path.join(repo, "bench", "fixtures", "generated", `search-${count}`);
const db = path.join(repo, "bench", "results", ".raw", `search-index-${count}`);
fs.mkdirSync(path.dirname(db), { recursive: true });

if (!fs.existsSync(root) || process.argv.includes("--rebuild")) {
  console.error(`generating ${count} Markdown files under ${root}`);
  generateSearchCorpus({ root, count, targetBytes });
}
if (!keep && fs.existsSync(db)) {
  fs.rmSync(db, { recursive: true, force: true });
}
const corpus = corpusSize(root);
console.error(`corpus: ${corpus.files} files / ${(corpus.bytes / 1024 / 1024).toFixed(1)} MiB`);

const result = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--release",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--example",
    "search_bench",
    "--",
    "--root",
    root,
    "--db",
    db,
    "--iterations",
    String(iterations),
  ],
  { cwd: repo, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" },
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout.trim());
const dbBytes = (() => {
  try {
    return fs.statSync(path.join(db, "index.sqlite")).size;
  } catch {
    return 0;
  }
})();
report.fixtures = count;
report.corpusBytes = corpus.bytes;
report.dbBytes = dbBytes;
report.dbToCorpus = corpus.bytes === 0 ? 0 : dbBytes / corpus.bytes;

const output = path.join(repo, "bench", "results", `search-${count}.json`);
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`\nwritten to ${path.relative(repo, output)}`);

const p95 = Math.max(...report.queries.map((query) => query.p95Ms));
if (count <= 10_000 && report.scanMs > 60_000) {
  console.error(`FAIL: indexing 10k took ${report.scanMs}ms (> 60s)`);
  process.exitCode = 1;
}
if (count >= 100_000 && report.indexed < report.total) {
  console.error(
    `FAIL: indexed ${report.indexed}/${report.total} files; 100k query gate needs the full corpus`,
  );
  process.exitCode = 1;
}
if (count >= 100_000 && p95 >= 200) {
  console.error(`FAIL: query p95 ${p95}ms (>= 200ms)`);
  process.exitCode = 1;
}
if (report.dbToCorpus > 4) {
  console.error(`FAIL: DB/corpus ratio ${report.dbToCorpus.toFixed(2)} (> 4x)`);
  process.exitCode = 1;
}
