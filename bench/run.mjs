#!/usr/bin/env node
/**
 * T-017 benchmark orchestrator.
 *
 * 1. Regenerate deterministic fixtures.
 * 2. Run the Node/jsdom benchmarks one fixture at a time (isolated RSS).
 * 3. Build and run the release `AtomicWriter` example per fixture.
 * 4. Merge automated results with `results/tauri-manual.json` (if present)
 *    into a dated JSON + Markdown report.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURES, generateFixtures } from "./generate-fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const RESULTS_DIR = path.join(ROOT, "bench", "results");
const RAW_DIR = path.join(RESULTS_DIR, ".raw");
const MANUAL_PATH = path.join(RESULTS_DIR, "tauri-manual.json");
const SIZES = ["small", "medium", "large"];
const SAVE_ITERATIONS = { small: 30, medium: 12, large: 5 };

mkdirSync(RAW_DIR, { recursive: true });
rmSync(RAW_DIR, { recursive: true, force: true });
mkdirSync(RAW_DIR, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${detail}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(summary) {
  if (!summary) {
    return "—";
  }
  return `${summary.p50} / ${summary.p95}`;
}

function fmtValue(value, unit = "ms") {
  return value === null || value === undefined ? "—" : `${value} ${unit}`;
}

console.log("== T-017 fixtures ==");
await generateFixtures();

console.log("\n== Node/jsdom benchmarks ==");
for (const name of SIZES) {
  console.log(`\n-- ${name} --`);
  run("pnpm", ["exec", "vitest", "run", "--config", "vitest.bench.config.ts"], {
    env: { BENCH_FIXTURE: name },
  });
}

let rustResults = null;
if (process.env.BENCH_SKIP_RUST === "1") {
  console.log("\n== Rust AtomicWriter benchmark: skipped (BENCH_SKIP_RUST=1) ==");
} else {
  console.log("\n== Rust AtomicWriter benchmark ==");
  run("cargo", [
    "build",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--release",
    "--example",
    "atomic_bench",
  ]);
  const binary = path.join(ROOT, "src-tauri", "target", "release", "examples", "atomic_bench");
  rustResults = {};
  for (const name of SIZES) {
    const output = path.join(RAW_DIR, `rust-save-${name}.json`);
    run(binary, [
      "--fixture",
      path.join(ROOT, "bench", "fixtures", FIXTURES[name].file),
      "--iterations",
      String(SAVE_ITERATIONS[name]),
      "--label",
      name,
      "--json",
      output,
    ]);
    rustResults[name] = readJson(output);
  }
}

const manifest = readJson(path.join(ROOT, "bench", "fixtures", "manifest.json"));
const manual = existsSync(MANUAL_PATH) ? readJson(MANUAL_PATH) : null;

const fixtures = SIZES.map((name) => {
  const open = readJson(path.join(RAW_DIR, `open-${name}.json`));
  const decorate = readJson(path.join(RAW_DIR, `decorate-${name}.json`));
  const fakeSave = readJson(path.join(RAW_DIR, `save-${name}.json`));
  const rust = rustResults?.[name] ?? null;
  const tauri = manual?.fixtures?.[name] ?? null;

  return {
    fixture: name,
    bytes: manifest.fixtures[name].bytes,
    lines: manifest.fixtures[name].lines,
    sha256: manifest.fixtures[name].sha256,
    open_ms: {
      summary: open.sessionOpenMs,
      source: "EditorSession.create -> createEditorState (fake IPC payload)",
    },
    ipc_copy_ms: {
      summary: open.ipcCopyMs,
      source: "JSON round-trip of FilePayload; proxy, not the Tauri transport",
    },
    decorate_ms: {
      summary: decorate.decorateMs,
      skipped: decorate.decorateSkipped,
      skipReason: decorate.decorateSkipReason,
      specs: decorate.decorationSpecs,
      viewportLines: decorate.viewportLines,
      viewMountMs: decorate.viewMountMs,
      source: "ensureSyntaxTree(8ms) + buildLivePreviewDecorations",
    },
    key_p95_ms: {
      value: decorate.keyMs.p95,
      p50: decorate.keyMs.p50,
      count: decorate.keyIterations,
      source: decorate.keySource,
    },
    save_ms: rust
      ? {
          summary: rust.saveMs,
          source: rust.source,
        }
      : null,
    fake_save_ms: {
      summary: fakeSave.fakeSaveMs,
      readTextMs: fakeSave.readTextMs,
      source: fakeSave.sources.fakeSaveMs,
    },
    max_rss_mb: tauri
      ? {
          value: tauri.rssMb,
          source: "ps -o rss= after opening the file in the real Tauri app",
        }
      : null,
    node_peak_rss_mb: { value: open.nodePeakRssMb, source: "process.resourceUsage().maxRSS" },
    manual_tauri: tauri,
  };
});

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim()
  ? "-dirty"
  : "";
const capturedAt = new Date();
const date = [
  capturedAt.getFullYear(),
  String(capturedAt.getMonth() + 1).padStart(2, "0"),
  String(capturedAt.getDate()).padStart(2, "0"),
].join("-");

const report = {
  task: "T-017",
  capturedAt: capturedAt.toISOString(),
  commit: `${commit}${dirty}`,
  environment: {
    platform: `${os.platform()} ${os.arch()}`,
    release: os.release(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    totalMemGb: round(os.totalmem() / 1024 / 1024 / 1024, 1),
    node: process.version,
    rust: run("rustc", ["--version"], { capture: true }),
  },
  definitions: {
    open_ms: "createEditorState for an already-received FilePayload (fake adapter)",
    ipc_copy_ms: "JSON.stringify + JSON.parse of FilePayload (proxy)",
    decorate_ms: "80-line viewport, ensureSyntaxTree budget 8ms + decoration specs",
    key_p95_ms: "single-character dispatch/update p95",
    save_ms: "real AtomicWriter::write on a temp copy (release build)",
    max_rss_mb: "real Tauri process RSS after open (manual, ps)",
  },
  fixtures,
  manualTauri: manual,
};

const jsonPath = path.join(RESULTS_DIR, `${date}.json`);
const mdPath = path.join(RESULTS_DIR, `${date}.md`);
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const lines = [
  `# Qingmo P1 性能基线 — ${date}`,
  "",
  `- Commit：\`${commit}${dirty}\``,
  `- 环境：${report.environment.platform} / ${report.environment.cpu} / Node ${report.environment.node}`,
  `- Rust：${report.environment.rust}`,
  `- Fixtures：\`bench/fixtures/manifest.json\`（确定性生成；10MiB 不入库）`,
  "- 方法：见 `bench/README.md`；P1 只记录，不设性能门禁。",
  "",
  "## 自动化基准（Node/jsdom + 真实 Rust AtomicWriter）",
  "",
  "| Fixture | 大小 | 行数 | open p50/p95 (ms) | IPC copy p50/p95 (ms) | decorate p50/p95 (ms) | key p95 (ms) | save p50/p95 (ms) | Node peak RSS (MB) |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
];

for (const item of fixtures) {
  const decorateCell = item.decorate_ms.skipped
    ? "skipped（LP 关闭）"
    : fmt(item.decorate_ms.summary);
  lines.push(
    `| ${item.fixture} | ${item.bytes} | ${item.lines} | ${fmt(item.open_ms.summary)} | ${fmt(
      item.ipc_copy_ms.summary,
    )} | ${decorateCell} | ${item.key_p95_ms.value} | ${fmt(item.save_ms?.summary)} | ${
      item.node_peak_rss_mb.value
    } |`,
  );
}

lines.push(
  "",
  "> `open` 是 `EditorState` 创建，不含原生读盘、IPC 传输和首次渲染；`decorate` 使用 80 行视口；10MiB 默认关闭 Live Preview，因此装饰为 skipped/0。",
  "",
  "## 真实 Tauri（手动，AX 上界 / ps RSS）",
  "",
);

if (manual) {
  lines.push(
    "| Fixture | open（AX 上界） | save（UI 确认上界） | 打开后 RSS | Live Preview | 备注 |",
    "|---|---:|---:|---:|---|---|",
  );
  for (const name of SIZES) {
    const item = manual.fixtures?.[name];
    if (!item) {
      continue;
    }
    lines.push(
      `| ${name} | ${fmtValue(item.openMs)} | ${fmtValue(item.saveMs)} | ${fmtValue(
        item.rssMb,
        "MB",
      )} | ${item.livePreview ? "开启" : "关闭"} | ${item.notes ?? ""} |`,
    );
  }
  lines.push(
    "",
    `> 手动记录：${manual.capturedAt ?? "unknown"}；方法：${manual.method ?? "AX poll"}`,
  );
} else {
  lines.push("未找到 `bench/results/tauri-manual.json`，本次报告不含真实 Tauri 数据。");
}

lines.push(
  "",
  "## 指标口径",
  "",
  "| 指标 | 口径 | 来源 |",
  "|---|---|---|",
  "| `open_ms` | `EditorSession.create`（`createEditorState`）耗时 | 浏览器 fake payload |",
  "| `ipc_copy_ms` | `FilePayload` 的 JSON 序列化/反序列化 | 代理值，非 Tauri 传输 |",
  "| `decorate_ms` | 80 行视口 + `ensureSyntaxTree(8ms)` + 装饰规格 | 状态级，真实 DOM 挂载耗时另记 `viewMountMs` |",
  "| `key_p95_ms` | 单字符 dispatch/update 的 p95 | 10KB/1MB 用真实 `EditorView`；10MiB 关闭 LP 后用 `EditorState.update` |",
  "| `save_ms` | 真实 `AtomicWriter::write` 的读盘/BLAKE3/编码/原子提交 | release 构建，临时副本 |",
  "| `max_rss_mb` | 真实 Tauri 打开后 `ps -o rss=` | 手动记录，非峰值 |",
  "",
  "## 结论边界",
  "",
  "- 10MiB 的 `open_ms` 只是状态创建；真实 Tauri 的首屏时间以手动 AX 上界为准。",
  "- jsdom 不渲染像素，`key_p95_ms` 不包含 GPU/合成器；P1 仅作回归基线。",
  "- 未测得的值写 `—` 或 `skipped`，不推断 16ms/10MiB 指标。",
  "",
);

writeFileSync(mdPath, `${lines.join("\n")}\n`, "utf8");

// Keep the machine-readable report stable under `pnpm format:check`.
try {
  run("pnpm", ["exec", "prettier", "--write", jsonPath], { capture: true });
} catch {
  // Formatting is a convenience; the report itself is already written.
}

console.log(`\n== report ==\n${mdPath}\n${jsonPath}`);
console.log(`\n${lines.join("\n")}`);
