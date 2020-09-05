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

export const unitMatch = /^[0-9.]+[a-z|%]/;
export const easingMatch = /(cubic-bezier|steps)\(.*\)|ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end/;
