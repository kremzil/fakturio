import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}", "../../packages/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17201b",
        paper: "#f6f3ed",
        zincLine: "#d8d2c6",
        ledger: "#dff07b",
        steel: "#52605a",
        warn: "#b04f32"
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "Arial", "sans-serif"]
      },
      boxShadow: {
        panel: "0 16px 45px rgba(23, 32, 27, 0.12)"
      }
    }
  },
  plugins: [require("@tailwindcss/forms")]
};

export default config;
