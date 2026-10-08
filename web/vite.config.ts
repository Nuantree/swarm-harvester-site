import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "development-deployment",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const path = (req.url ?? "").split("?")[0];
          if (
            path !== "/imd-deployment.json" &&
            !/^\/abi\/[A-Za-z]+\.json$/.test(path)
          )
            return next();
          try {
            const bytes = await readFile(
              new URL(`../dist${path}`, import.meta.url),
            );
            res.setHeader("Content-Type", "application/json");
            res.end(bytes);
          } catch {
            res.statusCode = 503;
            res.end(
              "Run npm run build first to generate the verified deployment.",
            );
          }
        });
      },
    },
  ],
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { react: ["react", "react-dom"], evm: ["viem"] },
      },
    },
  },
});
