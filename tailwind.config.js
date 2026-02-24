/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/views/**/*.ejs',
    './public/**/*.js'
  ],
  theme: {
    extend: {
      colors: {
        throne: {
          gold: '#FFD700',
          dark: '#1a1a2e',
          darker: '#0f0f1a',
          purple: '#4a0e8f',
          red: '#e63946',
          green: '#2ecc71',
        }
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'crown-bounce': 'bounce 1s ease-in-out 3',
      }
    },
  },
  plugins: [],
}
