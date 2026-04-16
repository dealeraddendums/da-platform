import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: "#2a2b3c",
        orange: "#ffa500",
        "blue-primary": "#1976d2",
        "blue-light": "#2196f3",
        success: "#4caf50",
        error: "#ff5252",
        warning: "#ffa500",
        "bg-app": "#3a6897",
        "bg-surface": "#ffffff",
        "bg-subtle": "#f5f6f7",
        "text-primary": "#333333",
        "text-secondary": "#55595c",
        "text-muted": "#78828c",
        "text-inverse": "#ffffff",
        "text-on-orange": "#333333",
        border: "#e0e0e0",
        "border-strong": "#c0c0c0",
      },
      fontFamily: {
        sans: ["Roboto", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
      },
      fontSize: {
        "2xs": ["11px", "1.4"],
        xs: ["12px", "1.4"],
        sm: ["14px", "1.5"],
        base: ["14px", "1.5"],
        md: ["16px", "1.5"],
        lg: ["18px", "1.4"],
        xl: ["24px", "1.2"],
        "2xl": ["32px", "1.2"],
      },
      borderRadius: {
        none: "0",
        sm: "2px",
        DEFAULT: "4px",
        md: "4px",
        lg: "6px",
        full: "9999px",
      },
      boxShadow: {
        modal: "0 8px 32px rgba(0,0,0,0.18)",
        none: "none",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
    },
  },
  plugins: [],
};
export default config;
