import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
const hmr = host ? { protocol: "ws" as const, host, port: 1421 } : null;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    ...(hmr ? { hmr } : {}),
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  worker: {
    format: "es",
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        about: fileURLToPath(new URL("./about.html", import.meta.url)),
        settings: fileURLToPath(new URL("./settings.html", import.meta.url)),
        "mermaid-renderer": fileURLToPath(new URL("./mermaid-renderer.html", import.meta.url)),
      },
      output: {
        manualChunks(id) {
          if (id.includes("commonjsHelpers")) {
            return "commonjs";
          }
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (
            /@codemirror\/(lang-markdown|lang-html|lang-css|lang-javascript)|@lezer\/(markdown|html|css|javascript)/.test(
              id,
            )
          ) {
            return "markdown";
          }
          if (
            /@codemirror\/(state|view|language|commands|search|autocomplete)|@lezer\/(common|highlight|lr)/.test(
              id,
            )
          ) {
            return "codemirror";
          }
          if (/react-dom|scheduler|\/react\//.test(id)) {
            return "react";
          }
          if (/react-router/.test(id)) {
            return "router";
          }
          if (/i18next/.test(id)) {
            return "i18n";
          }
          if (/@tauri-apps/.test(id)) {
            return "tauri";
          }
          return undefined;
        },
      },
    },
  },
});
