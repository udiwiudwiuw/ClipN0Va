import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f3f1ff",
          100: "#e9e5ff",
          500: "#7c5cff",
          600: "#6a45f5",
          700: "#5a36dc",
        },
      },
    },
  },
  plugins: [],
};

export default config;
