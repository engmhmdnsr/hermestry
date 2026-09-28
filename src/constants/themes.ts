export interface ThemePalette {
  id: string;
  name: string;
  description: string;
  preview: {
    bg: string;
    sidebar: string;
    bar1: string;
    bar2: string;
    pill: string;
  };
  dark: {
    bg: string;
    sidebar: string;
    card: string;
    cardSubtle: string;
    cardHover: string;
    border: string;
    borderSubtle: string;
    accent: string;
    accentHover: string;
    accentSubtle: string;
    accentText: string;
    text: string;
    textMuted: string;
    textDim: string;
    inputBg: string;
  };
  light: {
    bg: string;
    sidebar: string;
    card: string;
    cardSubtle: string;
    cardHover: string;
    border: string;
    borderSubtle: string;
    accent: string;
    accentHover: string;
    accentSubtle: string;
    accentText: string;
    text: string;
    textMuted: string;
    textDim: string;
    inputBg: string;
  };
}

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_PALETTES: ThemePalette[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep blue-violet with rich indigo accents',
    preview: {
      bg: '#0E1322',
      sidebar: '#070913',
      bar1: '#C4B5FD',
      bar2: '#818CF8',
      pill: '#6366F1',
    },
    dark: {
      bg: '#090B14',
      sidebar: '#06070E',
      card: '#0E1222',
      cardSubtle: '#14182E',
      cardHover: '#1B203C',
      border: 'rgba(129, 140, 248, 0.16)',
      borderSubtle: 'rgba(255, 255, 255, 0.06)',
      accent: '#6366F1',
      accentHover: '#4F46E5',
      accentSubtle: 'rgba(99, 102, 241, 0.16)',
      accentText: '#A5B4FC',
      text: '#F8FAFC',
      textMuted: '#94A3B8',
      textDim: '#64748B',
      inputBg: '#101426',
    },
    light: {
      bg: '#F1F5F9',
      sidebar: '#E2E8F0',
      card: '#FFFFFF',
      cardSubtle: '#F8FAFC',
      cardHover: '#EDF2F7',
      border: '#CBD5E1',
      borderSubtle: '#E2E8F0',
      accent: '#4F46E5',
      accentHover: '#4338CA',
      accentSubtle: 'rgba(79, 70, 229, 0.12)',
      accentText: '#4338CA',
      text: '#0F172A',
      textMuted: '#475569',
      textDim: '#94A3B8',
      inputBg: '#FFFFFF',
    },
  },
  {
    id: 'nous',
    name: 'Nous',
    description: 'Engineering dark slate, electric blue accents',
    preview: {
      bg: '#0D1117',
      sidebar: '#010409',
      bar1: '#E6EDF3',
      bar2: '#8B949E',
      pill: '#2563EB',
    },
    dark: {
      bg: '#0B0F17',
      sidebar: '#06090F',
      card: '#111827',
      cardSubtle: '#1A2234',
      cardHover: '#222D42',
      border: 'rgba(59, 130, 246, 0.18)',
      borderSubtle: 'rgba(255, 255, 255, 0.06)',
      accent: '#2563EB',
      accentHover: '#1D4ED8',
      accentSubtle: 'rgba(37, 99, 235, 0.15)',
      accentText: '#93C5FD',
      text: '#F9FAFB',
      textMuted: '#9CA3AF',
      textDim: '#6B7280',
      inputBg: '#141D2E',
    },
    light: {
      bg: '#F8FAFC',
      sidebar: '#F1F5F9',
      card: '#FFFFFF',
      cardSubtle: '#F1F5F9',
      cardHover: '#E2E8F0',
      border: '#E2E8F0',
      borderSubtle: '#F1F5F9',
      accent: '#2563EB',
      accentHover: '#1D4ED8',
      accentSubtle: 'rgba(37, 99, 235, 0.1)',
      accentText: '#1D4ED8',
      text: '#0F172A',
      textMuted: '#475569',
      textDim: '#94A3B8',
      inputBg: '#FFFFFF',
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Authentic GitHub Dark and Light with classic green',
    preview: {
      bg: '#0D1117',
      sidebar: '#010409',
      bar1: '#F0F6FC',
      bar2: '#8B949E',
      pill: '#238636',
    },
    dark: {
      bg: '#0D1117',
      sidebar: '#010409',
      card: '#161B22',
      cardSubtle: '#21262D',
      cardHover: '#30363D',
      border: '#30363D',
      borderSubtle: '#21262D',
      accent: '#238636',
      accentHover: '#2EA043',
      accentSubtle: 'rgba(35, 134, 54, 0.18)',
      accentText: '#7EE787',
      text: '#F0F6FC',
      textMuted: '#8B949E',
      textDim: '#6E7681',
      inputBg: '#0D1117',
    },
    light: {
      bg: '#FFFFFF',
      sidebar: '#F6F8FA',
      card: '#FFFFFF',
      cardSubtle: '#F6F8FA',
      cardHover: '#EAEEF2',
      border: '#D0D7DE',
      borderSubtle: '#EAEEF2',
      accent: '#1F883D',
      accentHover: '#1A7F37',
      accentSubtle: 'rgba(31, 136, 61, 0.12)',
      accentText: '#1F883D',
      text: '#1F2328',
      textMuted: '#656D76',
      textDim: '#8C959F',
      inputBg: '#F6F8FA',
    },
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    description: 'Soothing pastels, Mocha and Latte with lavender',
    preview: {
      bg: '#1E1E2E',
      sidebar: '#181825',
      bar1: '#CDD6F4',
      bar2: '#A6ADC8',
      pill: '#CBA6F7',
    },
    dark: {
      bg: '#1E1E2E',
      sidebar: '#181825',
      card: '#252538',
      cardSubtle: '#313244',
      cardHover: '#3B3D54',
      border: 'rgba(203, 166, 247, 0.22)',
      borderSubtle: 'rgba(255, 255, 255, 0.08)',
      accent: '#CBA6F7',
      accentHover: '#B4BEFE',
      accentSubtle: 'rgba(203, 166, 247, 0.18)',
      accentText: '#CBA6F7',
      text: '#CDD6F4',
      textMuted: '#A6ADC8',
      textDim: '#7F849C',
      inputBg: '#181825',
    },
    light: {
      bg: '#EFF1F5',
      sidebar: '#E6E9EF',
      card: '#FFFFFF',
      cardSubtle: '#E6E9EF',
      cardHover: '#DCE0E8',
      border: '#CCD0DA',
      borderSubtle: '#DCE0E8',
      accent: '#8839EF',
      accentHover: '#7287FD',
      accentSubtle: 'rgba(136, 57, 239, 0.12)',
      accentText: '#8839EF',
      text: '#4C4F69',
      textMuted: '#6C6F85',
      textDim: '#9CA0B0',
      inputBg: '#FFFFFF',
    },
  },
  {
    id: 'everforest',
    name: 'Everforest',
    description: 'Warm, low-contrast forest greens and earth tones',
    preview: {
      bg: '#272E33',
      sidebar: '#1E2326',
      bar1: '#DBBC7F',
      bar2: '#7FBBB3',
      pill: '#A7C080',
    },
    dark: {
      bg: '#1E2326',
      sidebar: '#171B1D',
      card: '#272E33',
      cardSubtle: '#323C41',
      cardHover: '#3D484D',
      border: 'rgba(167, 192, 128, 0.22)',
      borderSubtle: 'rgba(255, 255, 255, 0.07)',
      accent: '#A7C080',
      accentHover: '#83C092',
      accentSubtle: 'rgba(167, 192, 128, 0.16)',
      accentText: '#D3C6AA',
      text: '#D3C6AA',
      textMuted: '#9DA9A0',
      textDim: '#7A8478',
      inputBg: '#232A2E',
    },
    light: {
      bg: '#FDF6E3',
      sidebar: '#F4E8D1',
      card: '#FFFFFF',
      cardSubtle: '#EDE0C8',
      cardHover: '#E0D4BA',
      border: '#D8CBB2',
      borderSubtle: '#E8DDC6',
      accent: '#8DA101',
      accentHover: '#3A944C',
      accentSubtle: 'rgba(141, 161, 1, 0.14)',
      accentText: '#4A5528',
      text: '#3C4841',
      textMuted: '#5C6A72',
      textDim: '#829181',
      inputBg: '#FFFFFF',
    },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    description: 'Precision teal contrast with cyan and blue accents',
    preview: {
      bg: '#002B36',
      sidebar: '#073642',
      bar1: '#93A1A1',
      bar2: '#2AA198',
      pill: '#268BD2',
    },
    dark: {
      bg: '#00212B',
      sidebar: '#00181F',
      card: '#002B36',
      cardSubtle: '#073642',
      cardHover: '#0B414E',
      border: 'rgba(42, 161, 152, 0.28)',
      borderSubtle: 'rgba(255, 255, 255, 0.08)',
      accent: '#2AA198',
      accentHover: '#268BD2',
      accentSubtle: 'rgba(42, 161, 152, 0.18)',
      accentText: '#93A1A1',
      text: '#93A1A1',
      textMuted: '#657B83',
      textDim: '#586E75',
      inputBg: '#002630',
    },
    light: {
      bg: '#FDF6E3',
      sidebar: '#EEE8D5',
      card: '#FFFFFF',
      cardSubtle: '#F4ECCF',
      cardHover: '#E9E2C7',
      border: '#D3C9A9',
      borderSubtle: '#E3DABE',
      accent: '#268BD2',
      accentHover: '#2AA198',
      accentSubtle: 'rgba(38, 139, 210, 0.14)',
      accentText: '#073642',
      text: '#073642',
      textMuted: '#586E75',
      textDim: '#93A1A1',
      inputBg: '#FFFFFF',
    },
  },
  {
    id: 'nous-alt',
    name: 'Nous Alt',
    description: 'Vibrant deep ocean blue with amber-gold highlights',
    preview: {
      bg: '#0369A1',
      sidebar: '#075985',
      bar1: '#FEF3C7',
      bar2: '#F59E0B',
      pill: '#F59E0B',
    },
    dark: {
      bg: '#03254C',
      sidebar: '#011730',
      card: '#063768',
      cardSubtle: '#0B4A87',
      cardHover: '#1059A0',
      border: 'rgba(245, 158, 11, 0.3)',
      borderSubtle: 'rgba(56, 189, 248, 0.15)',
      accent: '#F59E0B',
      accentHover: '#D97706',
      accentSubtle: 'rgba(245, 158, 11, 0.18)',
      accentText: '#FDE68A',
      text: '#F0F9FF',
      textMuted: '#BAE6FD',
      textDim: '#7DD3FC',
      inputBg: '#042D59',
    },
    light: {
      bg: '#F0F9FF',
      sidebar: '#E0F2FE',
      card: '#FFFFFF',
      cardSubtle: '#E0F2FE',
      cardHover: '#BAE6FD',
      border: '#BAE6FD',
      borderSubtle: '#E0F2FE',
      accent: '#D97706',
      accentHover: '#B45309',
      accentSubtle: 'rgba(217, 119, 6, 0.12)',
      accentText: '#92400E',
      text: '#082F49',
      textMuted: '#0369A1',
      textDim: '#0284C7',
      inputBg: '#FFFFFF',
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Dark warm bonfire coals with blazing fiery orange',
    preview: {
      bg: '#1C1008',
      sidebar: '#0F0905',
      bar1: '#FED7AA',
      bar2: '#FB923C',
      pill: '#EA580C',
    },
    dark: {
      bg: '#140C08',
      sidebar: '#0C0704',
      card: '#21140E',
      cardSubtle: '#301D14',
      cardHover: '#42281D',
      border: 'rgba(249, 115, 22, 0.25)',
      borderSubtle: 'rgba(255, 255, 255, 0.07)',
      accent: '#F97316',
      accentHover: '#EA580C',
      accentSubtle: 'rgba(249, 115, 22, 0.18)',
      accentText: '#FDBA74',
      text: '#FFF7ED',
      textMuted: '#FDBA74',
      textDim: '#9A3412',
      inputBg: '#1B100B',
    },
    light: {
      bg: '#FFF7ED',
      sidebar: '#FFEDD5',
      card: '#FFFFFF',
      cardSubtle: '#FED7AA',
      cardHover: '#FDBA74',
      border: '#FDBA74',
      borderSubtle: '#FED7AA',
      accent: '#EA580C',
      accentHover: '#C2410C',
      accentSubtle: 'rgba(234, 88, 12, 0.12)',
      accentText: '#9A3412',
      text: '#431407',
      textMuted: '#9A3412',
      textDim: '#C2410C',
      inputBg: '#FFFFFF',
    },
  },
  {
    id: 'mono',
    name: 'Mono',
    description: 'High-contrast stark minimal black and white studio',
    preview: {
      bg: '#121212',
      sidebar: '#000000',
      bar1: '#FFFFFF',
      bar2: '#737373',
      pill: '#FFFFFF',
    },
    dark: {
      bg: '#080808',
      sidebar: '#000000',
      card: '#141414',
      cardSubtle: '#202020',
      cardHover: '#2B2B2B',
      border: 'rgba(255, 255, 255, 0.14)',
      borderSubtle: 'rgba(255, 255, 255, 0.08)',
      accent: '#E5E5E5',
      accentHover: '#FFFFFF',
      accentSubtle: 'rgba(255, 255, 255, 0.12)',
      accentText: '#FFFFFF',
      text: '#FAFAFA',
      textMuted: '#A3A3A3',
      textDim: '#737373',
      inputBg: '#101010',
    },
    light: {
      bg: '#FFFFFF',
      sidebar: '#F5F5F5',
      card: '#FFFFFF',
      cardSubtle: '#F5F5F5',
      cardHover: '#E5E5E5',
      border: '#D4D4D4',
      borderSubtle: '#E5E5E5',
      accent: '#171717',
      accentHover: '#000000',
      accentSubtle: 'rgba(0, 0, 0, 0.08)',
      accentText: '#000000',
      text: '#171717',
      textMuted: '#525252',
      textDim: '#737373',
      inputBg: '#FAFAFA',
    },
  },
];

export const applyThemeToDom = (paletteId: string, mode: ThemeMode) => {
  const palette = THEME_PALETTES.find((p) => p.id === paletteId) || THEME_PALETTES[0];
  
  let resolvedDark = true;
  if (mode === 'light') {
    resolvedDark = false;
  } else if (mode === 'system') {
    resolvedDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  const themeColors = resolvedDark ? palette.dark : palette.light;
  const root = document.documentElement;

  root.style.setProperty('--app-bg', themeColors.bg);
  root.style.setProperty('--app-sidebar', themeColors.sidebar);
  root.style.setProperty('--app-card', themeColors.card);
  root.style.setProperty('--app-card-subtle', themeColors.cardSubtle);
  root.style.setProperty('--app-card-hover', themeColors.cardHover);
  root.style.setProperty('--app-border', themeColors.border);
  root.style.setProperty('--app-border-subtle', themeColors.borderSubtle);
  root.style.setProperty('--app-accent', themeColors.accent);
  root.style.setProperty('--app-accent-hover', themeColors.accentHover);
  root.style.setProperty('--app-accent-subtle', themeColors.accentSubtle);
  root.style.setProperty('--app-accent-text', themeColors.accentText);
  root.style.setProperty('--app-text', themeColors.text);
  root.style.setProperty('--app-text-muted', themeColors.textMuted);
  root.style.setProperty('--app-text-dim', themeColors.textDim);
  root.style.setProperty('--app-input-bg', themeColors.inputBg);

  root.setAttribute('data-theme', palette.id);
  root.setAttribute('data-mode', resolvedDark ? 'dark' : 'light');
  if (resolvedDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
};
