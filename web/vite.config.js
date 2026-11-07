import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  server: { port: 5173, host: true, proxy: { "/api": "http://127.0.0.1:8000" } },
  build: { target: "es2022", rollupOptions: { input: { main: "index.html", qa: "qa.html" } } },
  resolve: { dedupe: ["three"] },
});
