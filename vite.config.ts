import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  build: {
    // The persistent Firestore SDK is isolated in an async vendor chunk. Its
    // minified size is ~514 kB (~153 kB gzip); the initial app stays ~102 kB gzip.
    chunkSizeWarningLimit: 525,
    rollupOptions: {
      output: {
        manualChunks(moduleId) {
          if (moduleId.includes("/node_modules/@firebase/firestore/")) {
            return "firebase-firestore";
          }
          if (moduleId.includes("/node_modules/@firebase/auth/")) {
            return "firebase-auth";
          }
          return undefined;
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Horner — Next Ten",
        short_name: "Next Ten",
        description: "Your next chapter from each of the ten Horner reading lists.",
        theme_color: "#29594d",
        background_color: "#f4f1ea",
        display: "standalone",
        start_url: "./",
        scope: "./",
        icons: [
          {
            src: "pwa-64x64.png",
            sizes: "64x64",
            type: "image/png",
          },
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
      },
    }),
  ],
});
