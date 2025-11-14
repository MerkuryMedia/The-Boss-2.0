import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        table: '#0c4f30',
      },
      fontFamily: {
        headline: ['\"Cinzel\"', 'serif'],
      },
    },
  },
  plugins: [],
};

export default config;