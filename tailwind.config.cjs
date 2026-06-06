/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Calm/clean palette (sRGB of the oklch design: cool blue-black neutrals,
        // soft blue accent). Static hex so /opacity utilities keep working; the
        // shell CSS also tracks these via oklch vars (enables light mode there).
        bg: {
          DEFAULT: '#14161b', // window — outermost
          rail: '#181a20', // dock + topbar chrome frame
          panel: '#25272e', // floating page card backdrop (clearly lighter)
          elevated: '#2e3038'
        },
        line: 'rgba(255,255,255,0.09)',
        accent: {
          DEFAULT: '#5b8cff',
          soft: 'rgba(91,140,255,0.16)',
          ring: 'rgba(91,140,255,0.34)'
        },
        live: '#d65bbf',
        ok: '#3fcf8f',
        warn: '#e0a23a',
        err: '#e85544',
        txt: {
          1: '#f3f4f6',
          2: '#b4b9c2',
          3: '#868c98',
          4: '#636873'
        }
      },
      fontFamily: {
        sans: ['Manrope', 'system-ui', 'sans-serif'],
        display: ['Manrope', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace']
      },
      borderRadius: {
        xl2: '14px',
        card: '20px'
      }
    }
  },
  plugins: []
}
