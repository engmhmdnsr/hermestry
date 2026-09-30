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
  dark: PaletteColors;
  light: PaletteColors;
}

/**
 * The complete token set. Every field is required and must be defined for BOTH
 * modes, so a palette can never be dark-only (that was the root cause of the
 * unusable light theme). Field -> CSS variable mapping lives in
 * applyThemeToDom; the same variable names are the dark pre-paint defaults in
 * src/index.css with a light mirror under [data-mode="light"].
 */
export interface PaletteColors {
  bg: string;
  sidebar: string;
  /** Raised surface. Target contrast against bg: 1.25:1. */
  card: string;
  /** Quiet fill (neutral pills, disabled buttons). Target 1.35:1 on bg. */
  cardSubtle: string;
  /** Hover and selected fill. Target 1.44:1 on bg, and the luminance
      ceiling: textDim must still clear 4.5:1 on it in that mode. */
  cardHover: string;
  /** The .edge border. Dark mode uses an alpha so it composites onto the
      surface below; target about 1.6:1 on bg. */
  border: string;
  borderSubtle: string;
  /** Solid accent FILL: primary buttons, progress bars, rings, active dots.
      Never used as a text color; pair with onAccent for its label. */
  accent: string;
  /** One step deeper fill for the accent hover and active state. */
  accentHover: string;
  /** Tint fill for accent surfaces (icon tiles, selected cards, focus). */
  accentSubtle: string;
  /** Border color for accent surfaces (pills, selected chips, focus fills). */
  accentBorder: string;
  /** Accent used as TEXT and for active nav on dark surfaces, so the
      accent role stays readable without a fill behind it (AA 4.5:1). */
  accentText: string;
  text: string;
  textMuted: string;
  /** Tertiary text: must clear 4.5:1 on bg AND on every surface token that
      can sit behind it, cardHover included. */
  textDim: string;
  inputBg: string;
  /**
   * Text or icon color that sits ON an accent fill (solid primary buttons,
   * selected chips, the user message bubble). #FFFFFF wherever white clears
   * 4.5:1 on that palette's accent, otherwise a dark ink, because several
   * accents (Catppuccin lavender, Everforest green, Nous Alt amber, Ember
   * orange, Mono white, Solarized teal) are far too light to carry white text.
   */
  onAccent: string;
  /** Solid danger surface (destructive buttons, error toast). */
  dangerSolid: string;
  /** Text or icon on --app-danger-solid. */
  onDanger: string;
  /** Solid success surface (success toast). */
  successSolid: string;
  /** Text or icon on --app-success-solid. */
  onSuccess: string;
  /** Solid info surface. */
  infoSolid: string;
  /** Text or icon on --app-info-solid. */
  onInfo: string;
  /** Solid warning surface. */
  warningSolid: string;
  /** Text or icon on --app-warning-solid. */
  onWarning: string;
  /** Modal backdrop wash: darker neutral on dark surfaces, stronger slightly
      blue-black on light pages. */
  scrim: string;
}

export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Solid status surfaces plus the text/icon that sits on them. Shared by both
 * modes and by every palette for the same reason STATUS_TOKENS is shared: a
 * destructive action must read destructive and a success toast must read
 * success no matter which palette or mode is active. Defined once here and
 * spread into every palette and mode, so the PaletteColors type still forces
 * each palette to define them. WCAG contrast of the on-* text on its own
 * fill: #FFFFFF on #E11D48 = 4.70, on #047857 = 5.48, on #0369A1 = 5.93, on
 * #B45309 = 5.02, all clear 4.5:1 in both modes, which is why the light and
 * dark halves are intentionally identical.
 */
const SOLID_STATUS_SURFACE = {
  dangerSolid: '#E11D48',
  onDanger: '#FFFFFF',
  successSolid: '#047857',
  onSuccess: '#FFFFFF',
  infoSolid: '#0369A1',
  onInfo: '#FFFFFF',
  warningSolid: '#B45309',
  onWarning: '#FFFFFF',
} as const;

/**
 * Modal backdrop wash. rgba(4, 6, 12, 0.62) is a quiet neutral dim over dark
 * surfaces; light pages take a stronger, slightly blue-black
 * rgba(10, 14, 30, 0.72) so the cream and white palettes never sit behind a
 * washed out black scrim. Verified as a visible separation from every palette
 * background: the subtle dark dim separates from dark surfaces by 1.01:1
 * (Mono #080808, the darkest) up to 1.23:1 (Nous Alt), and the stronger light
 * wash separates from light pages by 7.34:1 (Catppuccin #EFF1F5, the lightest
 * wash result) up to 7.87:1 (GitHub and Mono #FFFFFF), so a cream or white
 * page always shows a real backdrop instead of a broken black rectangle.
 */
const SCRIM_DARK = 'rgba(4, 6, 12, 0.62)';
const SCRIM_LIGHT = 'rgba(10, 14, 30, 0.72)';

/**
 * Dark ink for accents too light to carry white text. #0B0F17 clears 4.5:1 on
 * every accent that uses it (dark: Catppuccin #CBA6F7 9.44, Everforest
 * #A7C080 9.58, Solarized #2AA198 6.07, Nous Alt #F59E0B 8.93, Ember #F97316
 * 6.84, Mono #E5E5E5 15.23; light: Everforest #8DA101 6.60, Solarized
 * #268BD2 5.21, Nous Alt #D97706 6.02, Ember #EA580C 5.39). Midnight keeps
 * white: white on its #4F46E5 accent is 6.29 and the dark ink there is worse
 * at 3.05, so white stays (unchanged from the old hardcoded text-white look).
 */
const ON_ACCENT_INK = '#0B0F17';

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
      pill: '#4F46E5',
    },
    /* Surface ladder and accent pair, WCAG contrast measured against bg:
       card 1.25, cardSubtle 1.35, cardHover 1.44, border (0.30 alpha) 1.59.
       cardHover is the lightest rung on purpose: --app-text-dim still clears
       4.5:1 on it (4.51), so every surface keeps secondary text at AA. accent
       is the FILL and accentText is the TEXT/active-nav role: white on the
       fill is 6.29 (AA for a 13px/600 label), accentText on card is 7.89.
       Mirrored by the pre-paint defaults in src/index.css. */
    dark: {
      bg: '#090B14',
      sidebar: '#06070E',
      card: '#1A2140',
      cardSubtle: '#1F2749',
      cardHover: '#232B52',
      border: 'rgba(129, 140, 248, 0.30)',
      borderSubtle: 'rgba(255, 255, 255, 0.06)',
      accent: '#4F46E5',
      accentHover: '#4338CA',
      accentSubtle: 'rgba(79, 70, 229, 0.16)',
      accentBorder: 'rgba(79, 70, 229, 0.5)',
      accentText: '#A5B4FC',
      onAccent: '#FFFFFF',
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_DARK,
      text: '#F8FAFC',
      textMuted: '#94A3B8',
      textDim: '#8296B1',
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
      accentBorder: '#C7D2FE',
      accentText: '#4338CA',
      onAccent: '#FFFFFF',
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_LIGHT,
      text: '#0F172A',
      textMuted: '#475569',
      /* Tertiary step, AA floor on bg: #5F6E85 is 4.73:1 on #F1F5F9 (5.18
         on card, 4.60 on cardHover) where #64748B was 4.34:1. It stays
         lighter than textMuted, so the text hierarchy keeps its order. */
      textDim: '#5F6E85',
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
      accentBorder: 'rgba(37, 99, 235, 0.45)',
      accentText: '#93C5FD',
      onAccent: '#FFFFFF',
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_DARK,
      text: '#F9FAFB',
      textMuted: '#9CA3AF',
      textDim: '#8B94A7',
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
      accentBorder: '#BFDBFE',
      accentText: '#1D4ED8',
      onAccent: '#FFFFFF',
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_LIGHT,
      text: '#0F172A',
      textMuted: '#475569',
      /* Floor on cardHover #E2E8F0: 4.59, was 3.86. */
      textDim: '#5A687D',
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
      accentBorder: 'rgba(35, 134, 54, 0.5)',
      accentText: '#7EE787',
      onAccent: '#FFFFFF',
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_DARK,
      text: '#F0F6FC',
      textMuted: '#8B949E',
      textDim: '#939BA5',
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
      accentBorder: '#B7E4C7',
      accentText: '#1C7B37',
      onAccent: '#FFFFFF',
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_LIGHT,
      text: '#1F2328',
      textMuted: '#646C75',
      textDim: '#646C75',
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
      accentBorder: 'rgba(203, 166, 247, 0.45)',
      accentText: '#CBA6F7',
      onAccent: ON_ACCENT_INK,
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_DARK,
      text: '#CDD6F4',
      textMuted: '#A6ADC8',
      textDim: '#8B91A9',
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
      accentBorder: '#DDD0F7',
      accentText: '#7F35DF',
      onAccent: '#FFFFFF',
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_LIGHT,
      text: '#4C4F69',
      textMuted: '#5E6174',
      textDim: '#5E6174',
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
      accentBorder: 'rgba(167, 192, 128, 0.45)',
      accentText: '#D3C6AA',
      onAccent: ON_ACCENT_INK,
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_DARK,
      text: '#D3C6AA',
      textMuted: '#9DA9A0',
      textDim: '#8B978D',
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
      accentBorder: '#C9D6A8',
      accentText: '#4A5528',
      onAccent: ON_ACCENT_INK,
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_LIGHT,
      text: '#3C4841',
      textMuted: '#515E65',
      textDim: '#515E65',
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
      accentBorder: 'rgba(42, 161, 152, 0.5)',
      accentText: '#93A1A1',
      onAccent: ON_ACCENT_INK,
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_DARK,
      text: '#93A1A1',
      textMuted: '#839496',
      textDim: '#759AA0',
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
      accentBorder: '#9FD5CE',
      accentText: '#073642',
      onAccent: ON_ACCENT_INK,
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_LIGHT,
      text: '#073642',
      textMuted: '#53676E',
      textDim: '#53676E',
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
      accentBorder: 'rgba(245, 158, 11, 0.5)',
      accentText: '#FDE68A',
      onAccent: ON_ACCENT_INK,
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_DARK,
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
      accentBorder: '#FCD9A0',
      accentText: '#92400E',
      onAccent: ON_ACCENT_INK,
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_LIGHT,
      text: '#082F49',
      textMuted: '#03679F',
      textDim: '#176897',
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
      accentBorder: 'rgba(249, 115, 22, 0.5)',
      accentText: '#FDBA74',
      onAccent: ON_ACCENT_INK,
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_DARK,
      text: '#FFF7ED',
      textMuted: '#FDBA74',
      textDim: '#EA580C',
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
      accentBorder: '#FDD0A2',
      accentText: '#943211',
      onAccent: ON_ACCENT_INK,
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_LIGHT,
      text: '#431407',
      textMuted: '#943211',
      textDim: '#943211',
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
      accentBorder: 'rgba(255, 255, 255, 0.28)',
      accentText: '#FFFFFF',
      onAccent: ON_ACCENT_INK,
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_DARK,
      text: '#FAFAFA',
      textMuted: '#A3A3A3',
      textDim: '#8F8F8F',
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
      accentBorder: '#C4C4C4',
      accentText: '#000000',
      onAccent: '#FFFFFF',
      ...SOLID_STATUS_SURFACE,
      scrim: SCRIM_LIGHT,
      text: '#171717',
      textMuted: '#525252',
      textDim: '#666666',
      inputBg: '#FAFAFA',
    },
  },
];

export interface StatusRole {
  /** Light-safe text/icon color for this status (>=4.5:1 on card in both modes). */
  fg: string;
  /** Tint background for alert banners and .pill-* badges. */
  subtleBg: string;
  /** Tint border for alert banners and .pill-* badges. */
  border: string;
}

export interface StatusTokens {
  success: StatusRole;
  warning: StatusRole;
  danger: StatusRole;
  info: StatusRole;
}

/**
 * Shared, palette-independent status tokens, defined for BOTH modes (the light
 * half is what makes light mode readable: dark translucent washes are
 * near-invisible on white, so light uses opaque tints with dark fg text).
 * Status hues intentionally do NOT vary per theme: success/warning/danger/info
 * must stay recognizable across palettes, and only the fg ramp switches per
 * mode so light-mode text keeps >=4.5:1 contrast on light cards. Components
 * must consume these through the .pill-* utilities or the --app-*-subtle /
 * --app-* / --app-*-border variables, never raw emerald/rose/amber/sky classes.
 */
export const STATUS_TOKENS: Record<'dark' | 'light', StatusTokens> = {
  dark: {
    success: { fg: '#34D399', subtleBg: 'rgba(52, 211, 153, 0.12)', border: 'rgba(52, 211, 153, 0.35)' },
    warning: { fg: '#FCD34D', subtleBg: 'rgba(252, 211, 77, 0.12)', border: 'rgba(252, 211, 77, 0.35)' },
    danger: { fg: '#FDA4AF', subtleBg: 'rgba(253, 164, 175, 0.12)', border: 'rgba(253, 164, 175, 0.35)' },
    info: { fg: '#7DD3FC', subtleBg: 'rgba(125, 211, 252, 0.12)', border: 'rgba(125, 211, 252, 0.35)' },
  },
  light: {
    success: { fg: '#047857', subtleBg: '#ECFDF5', border: '#A7F3D0' },
    warning: { fg: '#92400E', subtleBg: '#FFFBEB', border: '#FDE68A' },
    danger: { fg: '#BE123C', subtleBg: '#FFF1F2', border: '#FECDD3' },
    info: { fg: '#0369A1', subtleBg: '#F0F9FF', border: '#BAE6FD' },
  },
};

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
  root.style.setProperty('--app-accent-border', themeColors.accentBorder);
  root.style.setProperty('--app-accent-text', themeColors.accentText);
  root.style.setProperty('--app-text', themeColors.text);
  root.style.setProperty('--app-text-muted', themeColors.textMuted);
  root.style.setProperty('--app-text-dim', themeColors.textDim);
  root.style.setProperty('--app-input-bg', themeColors.inputBg);
  root.style.setProperty('--app-on-accent', themeColors.onAccent);
  root.style.setProperty('--app-danger-solid', themeColors.dangerSolid);
  root.style.setProperty('--app-on-danger', themeColors.onDanger);
  root.style.setProperty('--app-success-solid', themeColors.successSolid);
  root.style.setProperty('--app-on-success', themeColors.onSuccess);
  root.style.setProperty('--app-info-solid', themeColors.infoSolid);
  root.style.setProperty('--app-on-info', themeColors.onInfo);
  root.style.setProperty('--app-warning-solid', themeColors.warningSolid);
  root.style.setProperty('--app-on-warning', themeColors.onWarning);
  root.style.setProperty('--app-scrim', themeColors.scrim);

  const status = resolvedDark ? STATUS_TOKENS.dark : STATUS_TOKENS.light;
  root.style.setProperty('--app-success', status.success.fg);
  root.style.setProperty('--app-success-subtle', status.success.subtleBg);
  root.style.setProperty('--app-success-border', status.success.border);
  root.style.setProperty('--app-warning', status.warning.fg);
  root.style.setProperty('--app-warning-subtle', status.warning.subtleBg);
  root.style.setProperty('--app-warning-border', status.warning.border);
  root.style.setProperty('--app-danger', status.danger.fg);
  root.style.setProperty('--app-danger-subtle', status.danger.subtleBg);
  root.style.setProperty('--app-danger-border', status.danger.border);
  root.style.setProperty('--app-info', status.info.fg);
  root.style.setProperty('--app-info-subtle', status.info.subtleBg);
  root.style.setProperty('--app-info-border', status.info.border);

  root.setAttribute('data-theme', palette.id);
  root.setAttribute('data-mode', resolvedDark ? 'dark' : 'light');
  // NOTE: data-mode is the single source of truth for light/dark. The legacy
  // `.dark` class toggle was a dead path (the only `dark:` variant in the
  // tree is ChatTab's `dark:prose-invert`, and Tailwind v4 resolves `dark:`
  // from prefers-color-scheme, not from `.dark`), so it is intentionally not
  // toggled. index.html must also drop its hardcoded `class="dark"`.
};

// Live OS-theme tracking for `system` mode. Returns an unsubscribe function.
// The settings/theme owner (HermesContext) should call this when the user
// picks `system` and unsubscribe on mode change or unmount.
export const watchSystemThemePreference = (
  paletteId: string,
  onChange?: (dark: boolean) => void,
): (() => void) => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (dark: boolean) => {
    applyThemeToDom(paletteId, 'system');
    onChange?.(dark);
  };
  const listener = (e: MediaQueryListEvent) => apply(e.matches);
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', listener);
  } else {
    mq.addListener(listener);
  }
  // Sync once in case the OS theme changed since last apply.
  apply(mq.matches);
  return () => {
    if (typeof mq.removeEventListener === 'function') {
      mq.removeEventListener('change', listener);
    } else {
      mq.removeListener(listener);
    }
  };
};
