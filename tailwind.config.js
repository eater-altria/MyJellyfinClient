/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: 'var(--accent, #0a84ff)',
        'accent-soft': 'var(--accent-soft, rgba(10,132,255,0.12))',
        'page-bg': 'rgb(var(--page-bg-rgb) / <alpha-value>)',
        'sidebar-bg': 'var(--glass-tint)',
        'card-bg': 'var(--glass-tint)',
        'text-primary': 'rgb(var(--text-primary-rgb) / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary-rgb) / <alpha-value>)',
      },
      borderRadius: {
        xl2: '1rem',
      },
      boxShadow: {
        card: '0 2px 6px rgba(35,54,85,0.04), 0 10px 28px rgba(35,54,85,0.08)',
        'card-hover': '0 4px 10px rgba(35,54,85,0.08), 0 16px 36px rgba(35,54,85,0.14)',
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
