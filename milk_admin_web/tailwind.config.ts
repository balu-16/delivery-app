import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
          soft: 'hsl(var(--primary-soft) / <alpha-value>)',
          softer: 'hsl(var(--primary-softer) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          soft: 'hsl(var(--destructive-soft) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          soft: 'hsl(var(--warning-soft) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'hsl(var(--info) / <alpha-value>)',
          soft: 'hsl(var(--info-soft) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          soft: 'hsl(var(--success-soft) / <alpha-value>)',
        },
        brand: {
          50: '#F4FAEE',
          100: '#E7F4DC',
          200: '#CBEBB4',
          300: '#A8DC8B',
          400: '#7FCB62',
          500: '#5DAE2B',
          600: '#43961E',
          700: '#2E7D1A',
          800: '#266616',
          900: '#1F5213',
        },
        cream: '#FFFBF2',
      },
      fontFamily: {
        sans: ['Poppins', 'Plus Jakarta Sans', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        'display': ['2rem', { lineHeight: '1.15', letterSpacing: '-0.02em', fontWeight: '800' }],
      },
      borderRadius: {
        card: '1.25rem',
        xl2: '1.25rem',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(23,37,26,0.05), 0 12px 32px -14px rgba(23,37,26,0.10)',
        lift: '0 2px 6px rgba(23,37,26,0.06), 0 24px 48px -16px rgba(23,37,26,0.18)',
        pill: '0 6px 16px -6px rgba(46,125,26,0.55)',
        innersoft: 'inset 0 1px 0 rgba(255,255,255,0.6)',
      },
      keyframes: {
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        floaty: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-8px)' } },
        bob: { '0%,100%': { transform: 'translateY(0) rotate(0deg)' }, '50%': { transform: 'translateY(-3px) rotate(-1.5deg)' } },
        sway: { '0%,100%': { transform: 'rotate(-4deg)' }, '50%': { transform: 'rotate(5deg)' } },
        drift: { '0%': { transform: 'translateX(-10%)' }, '100%': { transform: 'translateX(120%)' } },
        'spin-slow': { to: { transform: 'rotate(360deg)' } },
        'pulse-soft': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.45' } },
        'bounce-pin': { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-6px)' } },
        wiggle: { '0%,100%': { transform: 'rotate(-3deg)' }, '50%': { transform: 'rotate(3deg)' } },
        shine: { '0%': { transform: 'translateX(-120%) skewX(-18deg)' }, '100%': { transform: 'translateX(220%) skewX(-18deg)' } },
        'ring-shake': {
          '0%,100%': { transform: 'rotate(0)' },
          '10%': { transform: 'rotate(14deg)' },
          '20%': { transform: 'rotate(-12deg)' },
          '30%': { transform: 'rotate(10deg)' },
          '40%': { transform: 'rotate(-8deg)' },
          '50%': { transform: 'rotate(6deg)' },
          '60%': { transform: 'rotate(0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.8s linear infinite',
        floaty: 'floaty 5s ease-in-out infinite',
        bob: 'bob 3.2s ease-in-out infinite',
        sway: 'sway 4.5s ease-in-out infinite',
        drift: 'drift 26s linear infinite',
        'spin-slow': 'spin-slow 3s linear infinite',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'bounce-pin': 'bounce-pin 1.6s ease-in-out infinite',
        wiggle: 'wiggle 3s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
