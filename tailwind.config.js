/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'meter-green': '#22c55e',
        'meter-yellow': '#eab308',
        'meter-red': '#ef4444',
        'meter-bg': '#1e293b',
      },
      animation: {
        'peak-flash': 'peak-flash 0.1s ease-out',
      },
      keyframes: {
        'peak-flash': {
          '0%': { opacity: '1' },
          '100%': { opacity: '0.7' },
        },
      },
    },
  },
  plugins: [],
};
