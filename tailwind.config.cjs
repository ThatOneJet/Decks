/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0e0e13',
          rail: '#141419',
          panel: '#16161d',
          elevated: '#1c1c25'
        },
        line: '#26262f',
        accent: {
          DEFAULT: '#7c5cff',
          soft: 'rgba(124,92,255,0.15)',
          ring: 'rgba(124,92,255,0.35)'
        },
        ok: '#3ddc97',
        warn: '#f5b342',
        err: '#ff5d6c',
        txt: {
          1: '#e7e7ee',
          2: '#a9a9b8',
          3: '#6f6f80',
          4: '#4a4a57'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace']
      },
      borderRadius: {
        xl2: '14px'
      }
    }
  },
  plugins: []
}
