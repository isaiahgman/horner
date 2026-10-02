import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  build: {
    // Keep Vite 7's production syntax floor, including iOS/Safari 16.0.
    // Vite 8's default baseline would otherwise raise Safari to 16.4.
    target: ["chrome107", "edge107", "firefox104", "safari16", "ios16"],
    // Keep Firebase SDKs split from the app's initial bundle.
    chunkSizeWarningLimit: 525,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "firebase-firestore",
              test: /node_modules[\\/]@firebase[\\/]firestore[\\/]/,
            },
            {
              name: "firebase-auth",
              test: /node_modules[\\/]@firebase[\\/]auth[\\/]/,
            },
          ],
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
