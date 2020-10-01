export const tokenTypes = [
  'colors',
  'space',
  'fontSizes',
  'fonts',
  'fontWeights',
  'lineHeights',
  'letterSpacings',
  'sizes',
  'borderWidths',
  'borderStyles',
  'radii',
  'shadows',
  'zIndices',
  'transitions',
] as const;
// Note: when running Jest tests, make sure that the test file is running in node env
// if this constant was giving incorrect results.
export const isServer = typeof window === 'undefined';

export const unitMatch = /^[0-9.]+[a-z|%]/;
export const easingMatch = /(cubic-bezier|steps)\(.*\)|ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end/;
