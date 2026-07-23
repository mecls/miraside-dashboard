import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SF Mono", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"],
      },
      colors: {
        // ── Supabase brand green (primary). #3ECF8E = hsl(153.1 60.2% 52.7%).
        // Primary buttons use `accent` bg with near-black text (text-neutral-950); hover = accent-600.
        // Usable app-wide as bg-accent / text-accent / ring-accent / bg-accent/10 etc.
        accent: {
          DEFAULT: "#3ECF8E",
          50: "#f0fbf6",
          100: "#dcf6ea",
          200: "#bfeeda",
          300: "#93e3bf",
          400: "#62d8a2",
          500: "#3ECF8E",
          600: "#2eb87a",
          700: "#26935f",
        },
        // Brand alias (same green) for anywhere that reads more clearly as "brand".
        brand: {
          DEFAULT: "#3ECF8E",
          400: "#62d8a2",
          500: "#3ECF8E",
          600: "#2eb87a",
        },
        // ── Supabase three-layer surface system (pure greyscale). Named tokens for the shell.
        canvas: "#121212", // app background — hsl(0 0% 7.1%)
        panel: "#171717", // sidebar / panels — hsl(0 0% 9%)
        surface: {
          DEFAULT: "#1f1f1f", // surface-100 (cards / elevated) — hsl(0 0% 12.2%)
          100: "#1f1f1f",
          200: "#242424", // hover surface — hsl(0 0% 14.1%)
        },
        // ── Remap the pervasive neutral scale onto Supabase's exact greys so the whole
        // app shifts to the Supabase palette without touching every class name.
        // 950 = app bg, 900 = card surface-100, 800 = border, 400 = muted text (unchanged).
        neutral: {
          50: "#fafafa",
          100: "#ededed",
          200: "#e0e0e0",
          300: "#cccccc",
          400: "#a3a3a3", // muted / secondary text — hsl(0 0% 63.9%)
          500: "#8f8f8f",
          600: "#707070", // subtle / disabled — hsl(0 0% 43.9%)
          700: "#3d3d3d",
          800: "#2e2e2e", // borders — hsl(0 0% 18%)
          900: "#1f1f1f", // cards / elevated surfaces — hsl(0 0% 12.2%)
          950: "#121212", // app background — hsl(0 0% 7.1%)
        },
      },
      boxShadow: {
        // Supabase is a bordered UI; the only shadow is a very subtle card lift.
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.15)",
      },
      keyframes: {
        "pulse-subtle": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
