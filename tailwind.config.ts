import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Noto Sans JP"', 'system-ui', 'sans-serif'], mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'] },
      colors: { ink: '#14161a', teal: { DEFAULT: '#0b5d63', light: '#e6f1f1' }, signal: '#e4002b' },
    },
  },
  plugins: [],
};
export default config;
