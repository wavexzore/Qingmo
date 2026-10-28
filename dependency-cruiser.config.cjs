/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "tauri-only-in-adapters",
      severity: "error",
      from: {
        path: "^apps/desktop/src",
        pathNot: "^apps/desktop/src/lib/(ipc|platform|update|about|log)/tauri\\.ts$",
      },
      to: { path: "(^|/)@tauri-apps/|\\.pnpm/@tauri-apps\\+" },
    },
    {
      name: "tauri-not-in-workspace-packages",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "(^|/)@tauri-apps/|\\.pnpm/@tauri-apps\\+" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: "(^|/)(dist|coverage|src-tauri/target|src-tauri/gen)/",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
