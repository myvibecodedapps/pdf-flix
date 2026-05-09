/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0a0a0a",
        panel: "#141414",
        panel2: "#1f1f1f",
        accent: "#e50914",
        accent2: "#f40612",
        muted: "#8c8c8c",
      },
      fontFamily: {
        sans: ['"Inter"', "system-ui", "ui-sans-serif", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 28px rgba(229,9,20,0.45)",
      },
    },
  },
  plugins: [],
};
