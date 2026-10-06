/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: 'var(--accent, #0a84ff)',
        'accent-soft': 'var(--accent-soft, rgba(10,132,255,0.12))',
        'page-bg': '#f3f3f5',
        'sidebar-bg': 'rgba(250,250,252,0.85)',
        'card-bg': '#ffffff',
        'text-primary': '#1d1d1f',
        'text-secondary': '#86868b',
      },
      borderRadius: {
        xl2: '1rem',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.06), 0 4px 14px rgba(0,0,0,0.06)',
        'card-hover': '0 4px 12px rgba(0,0,0,0.10), 0 10px 30px rgba(0,0,0,0.12)',
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC',
          'Microsoft YaHei', 'Helvetica Neue', 'Arial', 'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
