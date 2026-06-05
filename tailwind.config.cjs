/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Futuristic redesign palette — deep cool-black void, cyan glow, magenta live.
        bg: {
          DEFAULT: '#07090e', // outermost void
          rail: '#0c0f16', // rail + topbar chrome frame
          panel: '#0f1118', // floating page card backdrop
          elevated: '#161b26'
        },
        line: 'rgba(255,255,255,0.07)',
        accent: {
          DEFAULT: '#35e3ff',
          soft: 'rgba(53,227,255,0.14)',
          ring: 'rgba(53,227,255,0.45)'
        },
        live: '#ff5bd0',
        ok: '#4ef0a6',
        warn: '#ffc25c',
        err: '#ff5d6c',
        txt: {
          1: '#eef2f8',
          2: '#aab3c4',
          3: '#6d7689',
          4: '#454d5e'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace']
      },
      borderRadius: {
        xl2: '14px',
        card: '18px'
      }
    }
  },
  plugins: []
}
