import { tokenTypes, unitMatch, easingMatch } from './constants';
import {
  ATOM,
  IAtom,
  IBreakpoints,
  IComposedAtom,
  ICssPropToToken,
  IKeyframesAtom,
  ISheet,
  IThemeAtom,
  ITokensDefinition,
  TConfig,
  TCss,
} from './types';
import { unitlessKeys } from './unitless';
import {
  MAIN_BREAKPOINT_ID,
  createSheets,
  cssPropToToken,
  getVendorPrefixAndProps,
  hashString,
  specificityProps,
  matchString,
} from './utils';
export * from './types';
export * from './css-types';
export * from './utils';

export const _ATOM = ATOM;

export const hotReloadingCache = new Map<string, any>();

const cleanSSRClass = (s: string) => {
  // removes the atom class marker & removes any escaping that was done on the server for the class
  return s.replace(/(\/\*X\*\/|\\([^-_a-zA-Z\d]*))/g, '$2');
};
const createSSRCssRuleClass = (s: string) => {
  return `/*X*/${s.replace(/[^-_a-zA-Z\d]/g, `\\$&`)}/*X*/`;
};

const createSelector = (className: string, selector: string) => {
  const cssRuleClassName = className ? `.${className}` : '';
  if (selector && selector.includes('&')) return selector.replace(/&/gi, cssRuleClassName);
  if (selector) {
    return `${cssRuleClassName}${selector}`;
  }
  return cssRuleClassName;
};

/**
 * Resolves a token to its css value in the context of the passed css prop:
 */
const resolveTokens = (cssProp: string, value: any, tokens: any) => {
  const token: any = cssPropToToken[cssProp as keyof ICssPropToToken<any>];
  let tokenValue: any;
  if (token) {
    if (Array.isArray(token) && Array.isArray(value)) {
      tokenValue = token.map((tokenName, index) =>
        token && (tokens as any)[tokenName] && (tokens as any)[tokenName][value[index]]
          ? (tokens as any)[tokenName][value[index]]
          : value[index]
      );
    } else {
      tokenValue =
        token && (tokens as any)[token] && (tokens as any)[token][value] ? (tokens as any)[token][value] : value;
    }
  } else {
    tokenValue = value;
  }
  return tokenValue;
};

/**
 * iterates over a style object keys and values,
 * resolving them to their final form then calls the value callback with the prop, value
 * and the current value nesting path in the style object:
 * - handles utilities
 * - handles specificity props
 * - handles nesting
 * - TODO: also handle the things below once we handle envs differently (to avoid passing a lot of props around):
 * - handles tokens
 * - handles vendor prefixing
 */
const processStyleObject = (
  obj: any,
  config: TConfig<true>,
  valueMiddleware: (prop: string, value: string, currentNestingPath: string[]) => void,
  currentNestingPath: string[] = [],
  shouldHandleUtils = true,
  shouldHandleSpecificityProps = true
) => {
  // key: css prop or override or a selector
  // value is: cssValue, a util, specificity prop, or
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const isUtilProp = shouldHandleUtils && key in config.utils;
    const isSpecificityProp = shouldHandleSpecificityProps && !isUtilProp && key in specificityProps;
    /** Nested styles: */
    if (typeof val === 'object' && !isSpecificityProp && !isUtilProp) {
      // Atom value:
      if (val[ATOM]) {
        valueMiddleware(key, val, currentNestingPath);
        continue;
      }
      // handle the value object
      processStyleObject(val, config, valueMiddleware, [...currentNestingPath, key]);
      continue;
    }

    /** Utils: */
    if (isUtilProp) {
      // Resolve the util from the util function:
      const resolvedUtils = config.utils[key](config)(val);
      processStyleObject(resolvedUtils, config, valueMiddleware, [...currentNestingPath], false);
      continue;
    }

    /** Specificity Props: */
    // shorthand css props or css props that has baked in handling:
    // see specificityProps in ./utils
    if (isSpecificityProp) {
      const resolvedSpecificityProps = specificityProps[key](config.tokens, val);
      processStyleObject(resolvedSpecificityProps, config, valueMiddleware, [...currentNestingPath], false, false);
      continue;
    }
    if (typeof val === 'number') {
      // handle unitless numbers:
      valueMiddleware(
        key,
        // tslint:disable-next-line: prefer-template
        `${unitlessKeys[key] ? val : val + 'px'}`,
        currentNestingPath
      );
    } else if (val !== undefined) {
      valueMiddleware(key, resolveTokens(key, val, config.tokens), currentNestingPath);
    }
  }
};

/**
 * Resolves a css prop nesting path to a css selector and the breakpoint the css prop is meant to be injected to
 */
const resolveBreakpointAndSelectorAndInlineMedia = (nestingPath: string[], config: TConfig<true>) =>
  nestingPath.reduce(
    (acc, breakpointOrSelector, i) => {
      // utilityFirst selector specific resolution:
      const isOverride = config.utilityFirst && breakpointOrSelector === 'override';
      if (isOverride) {
        // any level above 0
        if (i) {
          throw new Error(
            `@stitches/core - You can not override at this level [${nestingPath
              .slice(0, i - 1)
              .join(', ')}, -> ${breakpointOrSelector}], only at the top level definition`
          );
        }
        return acc;
      }
      // breakpoints handling:
      if (breakpointOrSelector in config.breakpoints || breakpointOrSelector === MAIN_BREAKPOINT_ID) {
        if (acc.breakpoint !== MAIN_BREAKPOINT_ID) {
          throw new Error(
            `@stitches/core - You are nesting the breakpoint "${breakpointOrSelector}" into "${acc.breakpoint}", that makes no sense? :-)`
          );
        }
        acc.breakpoint = breakpointOrSelector;
        return acc;
      }

      if (breakpointOrSelector[0] === '@') {
        acc.inlineMediaQueries.push(breakpointOrSelector);
        return acc;
      }
      // Normal css nesting selector:
      acc.nestingPath =
        acc.nestingPath +
        // If you manually prefix with '&' we remove it for identity consistency
        // only for pseudo selectors and nothing else
        (breakpointOrSelector[0] === '&' && breakpointOrSelector[1] === ':'
          ? breakpointOrSelector.substr(1)
          : // pseudo elements/class
          // don't prepend with a whitespace
          breakpointOrSelector[0] === ':'
          ? breakpointOrSelector
          : // else just nest with a space
            // tslint:disable-next-line: prefer-template
            ' ' + breakpointOrSelector);
      return acc;
    },
    {
      breakpoint: MAIN_BREAKPOINT_ID,
      nestingPath: '',
      inlineMediaQueries: [] as string[],
    }
  );

/**
 * converts an object style css prop to its normal css style object prop and handles prefixing:
 * borderColor => border-color
 */
const hyphenAndVendorPrefixCssProp = (cssProp: string, vendorProps: any[], vendorPrefix: string) => {
  const isVendorPrefixed = cssProp[0] === cssProp[0].toUpperCase();
  let cssHyphenProp = cssProp
    .split(/(?=[A-Z])/)
    .map((g) => g.toLowerCase())
    .join('-');

  if (isVendorPrefixed) {
    cssHyphenProp = `-${cssHyphenProp}`;
  } else if (vendorProps.includes(`${vendorPrefix}${cssHyphenProp}`)) {
    cssHyphenProp = `${vendorPrefix}${cssHyphenProp}`;
  }
  return cssHyphenProp;
};

const toStringCachedAtom = function (this: IAtom) {
  return this._className!;
};

const toStringCompose = function (this: IComposedAtom) {
  const className = this.atoms.map((atom) => atom.toString()).join(' ');
  // cache the className on this instance
  // @ts-ignore
  this._className = className;
  // @ts-ignore
  this.toString = toStringCachedAtom;
  return className;
};

const createCssRule = (breakpoints: IBreakpoints, atom: IAtom, className: string) => {
  let cssRule = '';
  if (atom.inlineMediaQueries && atom.inlineMediaQueries.length) {
    let allMediaQueries = '';
    let endBrackets = '';
    atom.inlineMediaQueries.forEach((breakpoint) => {
      allMediaQueries += `${breakpoint}{`;
      endBrackets += '}';
    });

    cssRule = `${allMediaQueries}${createSelector(className, atom.selector)}{${atom.cssHyphenProp}:${
      atom.value
    };}${endBrackets}`;
  } else {
    cssRule = `${createSelector(className, atom.selector)}{${atom.cssHyphenProp}:${atom.value};}`;
  }

  return atom.breakpoint !== MAIN_BREAKPOINT_ID ? breakpoints[atom.breakpoint](cssRule) : cssRule;
};

const createToString = (
  sheets: { [breakpoint: string]: ISheet },
  breakpoints: IBreakpoints = {},
  cssClassnameProvider: (atom: IAtom) => string, // [className, pseudo]
  preInjectedRules: Set<string>
) => {
  return function toString(this: IAtom) {
    const className = cssClassnameProvider(this);
    const shouldInject = !preInjectedRules.size || !preInjectedRules.has(`.${className}`);

    if (shouldInject) {
      const sheet = sheets[this.breakpoint];
      sheet.insertRule(
        createCssRule(breakpoints, this, className),
        this.inlineMediaQueries.length ? sheet.cssRules.length : 0
      );
    }

    // We are switching this atom from IAtom simpler representation
    // 1. delete everything but `id` for specificity check

    // @ts-ignore
    this.cssHyphenProp = this.value = this.pseudo = this.breakpoint = this.inlineMediaQueries = undefined;

    // 2. put on a _className
    this._className = className;

    // 3. switch from this `toString` to a much simpler one
    this.toString = toStringCachedAtom;

    return className;
  };
};

const createServerToString = (
  sheets: { [mediaQuery: string]: ISheet },
  breakpoints: IBreakpoints = {},
  cssClassnameProvider: (atom: IAtom) => string
) => {
  return function toString(this: IAtom) {
    const className = cssClassnameProvider(this);

    const sheet = sheets[this.breakpoint];
    sheets[this.breakpoint].insertRule(
      createCssRule(breakpoints, this, className.length ? createSSRCssRuleClass(className) : ''),
      this.inlineMediaQueries.length ? sheet.cssRules.length : 0
    );

    // We do not clean out the atom here, cause it will be reused
    // to inject multiple times for each request

    // 1. put on a _className
    this._className = className;

    // 2. switch from this `toString` to a much simpler one
    this.toString = toStringCachedAtom;

    return className;
  };
};

const createThemeToString = (classPrefix: string, variablesSheet: ISheet) =>
  function toString(this: IThemeAtom) {
    const themeClassName = `${classPrefix ? `${classPrefix}-` : ''}theme-${this.name}`;

    // @ts-ignore
    variablesSheet.insertRule(
      `.${themeClassName}{${Object.keys(this.definition).reduce((aggr, tokenType) => {
        // @ts-ignore
        return `${aggr}${Object.keys(this.definition[tokenType]).reduce((subAggr, tokenKey) => {
          return `${subAggr}--${tokenType}-${tokenKey.replace(/[^\w\s-]/gi, '')}:${
            // @ts-ignore
            this.definition[tokenType][tokenKey]
          };`;
        }, aggr)}`;
      }, '')}}`
    );

    this.toString = () => themeClassName;

    return themeClassName;
  };

const createKeyframesToString = (sheet: ISheet) =>
  function toString(this: IKeyframesAtom) {
    if (this._cssRuleString) {
      sheet.insertRule(this._cssRuleString);
    }

    this.toString = () => this.id;

    return this.id;
  };

const composeIntoMap = (map: Map<string, IAtom>, atoms: (IAtom | IComposedAtom)[]) => {
  let i = atoms.length - 1;
  for (; i >= 0; i--) {
    const item = atoms[i];
    // atoms can be undefined, null, false or '' using ternary like
    // expressions with the properties
    if (item && item[ATOM] && 'atoms' in item) {
      composeIntoMap(map, item.atoms);
    } else if (item && item[ATOM]) {
      if (!map.has((item as IAtom).id)) {
        map.set((item as IAtom).id, item as IAtom);
      }
    } else if (item) {
      map.set((item as unknown) as string, item as IAtom);
    }
  }
};

export const createTokens = <T extends ITokensDefinition>(tokens: T) => {
  return tokens;
};
export const createCss = <T extends TConfig>(
  _config: T,
  env: Window | null = typeof window === 'undefined' ? null : window
): TCss<T> => {
  // pre-checked config to avoid checking these all the time
  // tslint:disable-next-line
  const config: TConfig<true> = Object.assign({ tokens: {}, utils: {}, breakpoints: {} }, _config);
  // prefill with empty token groups
  tokenTypes.forEach((tokenType) => (config.tokens[tokenType] = config.tokens[tokenType] || {}));
  const { tokens, breakpoints } = config;

  const showFriendlyClassnames =
    typeof config.showFriendlyClassnames === 'boolean'
      ? config.showFriendlyClassnames
      : process.env.NODE_ENV === 'development';
  const prefix = config.prefix || '';
  const { vendorPrefix, vendorProps } = env
    ? getVendorPrefixAndProps(env)
    : { vendorPrefix: '-node-', vendorProps: [] };

  if (env && hotReloadingCache.has(prefix)) {
    const instance = hotReloadingCache.get(prefix);
    instance.dispose();
  }

  // pre-compute class prefix
  const classPrefix = prefix ? (showFriendlyClassnames ? `${prefix}_` : prefix) : '';
  const cssClassnameProvider = (atom: IAtom): string => {
    if (atom._isGlobal) {
      return '';
    }
    const hash = hashString(
      `${atom.breakpoint || ''}${atom.cssHyphenProp.replace(/-(moz|webkit|ms)-/, '')}${atom.selector || ''}${
        atom.inlineMediaQueries?.join('') || ''
      }${atom.value}`
    );
    const name = showFriendlyClassnames
      ? // HTML has this weird treatment to css classes. it's ok if they start with everything except digits
        // where in CSS a class can only start with an underscore (_), a hyphen (-) or a letter (a-z)/(A-Z)
        // so we're prefixing the breakpoint with _ incase the user sets an invalid character at the start of the string
        `${atom.breakpoint ? `_${atom.breakpoint}_` : ''}${atom.cssHyphenProp
          .replace(/-(moz|webkit|ms)-/, '')
          .split('-')
          .map((part) => part[0])
          .join('')}_${hash}`
      : `_${hash}`;

    return `${classPrefix}${name}`;
  };

  const { tags, sheets } = createSheets(env, config.breakpoints);
  const preInjectedRules = new Set<string>();
  // tslint:disable-next-line
  for (const tag of tags) {
    ((tag.textContent || '').match(/\/\*\X\*\/.*?\/\*\X\*\//g) || []).forEach((rule) => {
      // tslint:disable-next-line
      preInjectedRules.add('.' + cleanSSRClass(rule));
    });
  }

  let toString = env
    ? createToString(sheets, config.breakpoints, cssClassnameProvider, preInjectedRules)
    : createServerToString(sheets, config.breakpoints, cssClassnameProvider);

  let themeToString = createThemeToString(classPrefix, sheets.__variables__);
  let keyframesToString = createKeyframesToString(sheets[MAIN_BREAKPOINT_ID]);
  const compose = (...atoms: IAtom[]): IComposedAtom => {
    const map = new Map<string, IAtom>();
    composeIntoMap(map, atoms);
    return {
      atoms: Array.from(map.values()),
      toString: toStringCompose,
      [ATOM]: true,
    };
  };
  const createAtom = (
    cssProp: string,
    value: any,
    breakpoint = MAIN_BREAKPOINT_ID,
    selectorString: string,
    inlineMediaQueries: string[],
    isGlobal?: boolean
  ) => {
    // generate id used for specificity check
    // two atoms are considered equal in regard to there specificity if the id is equal
    const inlineMediasAsString = inlineMediaQueries ? inlineMediaQueries.join('') : '';
    const id =
      cssProp.toLowerCase() + selectorString + (inlineMediaQueries ? inlineMediaQueries.join('') : '') + breakpoint;

    // make a uid accouting for different values
    const uid = id + value;

    // If this was created before return the cached atom
    if (atomCache.has(uid)) {
      // check if this has a breakpoint based media query
      if (inlineMediasAsString.match(/@media.*\((min|max)?.*(width|height).*\)/)) {
        // tslint:disable-next-line
        console.warn(
          `The property "${cssProp}" with media query ${inlineMediasAsString} can cause a specificity issue. You should create a breakpoint`
        );
      }
      return atomCache.get(uid)!;
    }

    // prepare the cssProp
    const cssHyphenProp = hyphenAndVendorPrefixCssProp(cssProp, vendorProps, vendorPrefix);

    // We want certain pseudo selectors to take presedence over other pseudo
    // selectors, so we increase specificity
    if (!selectorString?.match('&')) {
      if (selectorString?.match(/\:hover/)) {
        selectorString = `&&${selectorString}`;
      } else if (selectorString?.match(/\:active/)) {
        selectorString = `&&&${selectorString}`;
      } else if (selectorString?.match(/\:focus|\:focus-visible/)) {
        selectorString = `&&&&${selectorString}`;
      } else if (selectorString?.match(/\:read-only/)) {
        selectorString = `&&&&&${selectorString}`;
      } else if (selectorString?.match(/\:disabled/)) {
        selectorString = `&&&&&&${selectorString}`;
      }
    }

    // Create a new atom
    const atom: IAtom = {
      id,
      cssHyphenProp,
      value,
      selector: selectorString,
      inlineMediaQueries,
      breakpoint,
      toString,
      [ATOM]: true,
      _isGlobal: isGlobal,
    };

    // Cache it
    atomCache.set(uid, atom);

    return atom;
  };

  let baseTokens = ':root{';
  // tslint:disable-next-line
  for (const tokenType in tokens) {
    const isNumericScale = tokenType.match(/^(sizes|space|letterSpacings|zIndices)$/);
    const isMultiVarToken = tokenType.match(/^(transitions)$/);
    // @ts-ignore
    // tslint:disable-next-line
    const scaleTokenKeys = Object.keys(tokens[tokenType]);
    for (let index = 0; index < scaleTokenKeys.length; index++) {
      const token = scaleTokenKeys[index];
      // format token to remove special characters
      // https://stackoverflow.com/a/4374890
      const formattedToken = token.replace(/[^\w\s-]/gi, '');
      let cssVar = `--${tokenType}-${formattedToken}`;
      if (isMultiVarToken) {
        // @ts-ignore
        const values = tokens[tokenType][token].split(' ');
        let isDurationFound = false;
        values.forEach((value: string) => {
          if (matchString(value, unitMatch)) {
            if (isDurationFound) {
              cssVar = `--${tokenType}-${formattedToken}-delay`;
            } else {
              cssVar = `--${tokenType}-${formattedToken}-duration`;
              isDurationFound = true;
            }
          } else if (matchString(value, easingMatch)) {
            cssVar = `--${tokenType}-${formattedToken}-function`;
          } else {
            cssVar = `--${tokenType}-${formattedToken}-property`;
          }
          // @ts-ignore
          baseTokens += `${cssVar}:${value};`;
        });
      } else {
        // @ts-ignore
        baseTokens += `${cssVar}:${tokens[tokenType][token]};`;
        // @ts-ignore
        tokens[tokenType][token] = `var(${cssVar})`;
      }
      // Add negative tokens
      // tslint:disable-next-line: prefer-template
      const negativeTokenKey = '-' + token;
      // check that it's a numericScale and that the user didn't already set a negative token witht this name
      const isAlreadyANegativeToken =
        // @ts-ignore
        token[0] === '-' ? !!tokens[tokenType][token.substring(1)] : false;
      if (
        isNumericScale &&
        // @ts-ignore
        !tokens[tokenType][negativeTokenKey] &&
        !isAlreadyANegativeToken
      ) {
        // @ts-ignore
        tokens[tokenType][negativeTokenKey] = `calc(var(${cssVar}) * -1)`;
      }
    }
  }
  baseTokens += '}';

  if (!preInjectedRules.has(':root')) {
    sheets.__variables__.insertRule(baseTokens);
  }
  // Keeping track of all atoms for SSR
  const compositionsCache = new Set<IComposedAtom>();
  const atomCache = new Map<string, IAtom>();
  const keyFramesCache = new Map<string, IKeyframesAtom>();
  const themeCache = new Map<ITokensDefinition, IThemeAtom>();
  const cssInstance = ((...definitions: any[]) => {
    const args: any[] = [];
    let index = 0;

    for (let x = 0; x < definitions.length; x++) {
      if (!definitions[x]) {
        continue;
      }
      if (typeof definitions[x] === 'string' || definitions[x][ATOM]) {
        args[index++] = definitions[x];
      } else {
        processStyleObject(definitions[x], config, (prop, value, path) => {
          const { nestingPath, breakpoint, inlineMediaQueries } = resolveBreakpointAndSelectorAndInlineMedia(
            path,
            config
          );
          args[index++] = createAtom(prop, value, breakpoint, nestingPath, inlineMediaQueries);
        });
      }
    }
    // might cause memory leaks when doing css() inside a component
    // but we need this for now to fix SSR
    const composition = compose(...args);
    compositionsCache.add(composition);

    return composition;
  }) as any;

  cssInstance.dispose = () => {
    atomCache.clear();
    tags.forEach((tag) => {
      tag.parentNode?.removeChild(tag);
    });
  };
  cssInstance._config = () => config;
  cssInstance.theme = (definition: any): IThemeAtom => {
    if (themeCache.has(definition)) {
      return themeCache.get(definition)!;
    }

    const themeAtom = {
      // We could here also check if theme has been added from server,
      // though thinking it does not matter... just a simple rule
      name: String(themeCache.size),
      definition,
      toString: themeToString,
      [ATOM]: true as true,
    };

    themeCache.set(definition, themeAtom);

    return themeAtom;
  };

  cssInstance.global = (definitions: any) => {
    processStyleObject(definitions, config, (prop, value, path) => {
      const { nestingPath, breakpoint, inlineMediaQueries } = resolveBreakpointAndSelectorAndInlineMedia(path, config);
      if (!nestingPath.length) {
        throw new Error('Global styles need to be nested');
      }
      // Create a global atom and call toString() on it directly to inject it
      // as global atoms don't generate class names of their own
      createAtom(prop, value, breakpoint, nestingPath, inlineMediaQueries, true).toString();
    });
  };
  cssInstance.keyframes = (definition: any): IKeyframesAtom => {
    let cssRule = '';
    let currentTimeProp = '';
    processStyleObject(definition, config, (key, value, [timeProp]) => {
      if (timeProp !== currentTimeProp) {
        if (cssRule) {
          cssRule += `}`;
        }
        currentTimeProp = timeProp;
        cssRule += `${timeProp} {`;
      }
      cssRule += `${hyphenAndVendorPrefixCssProp(key, vendorProps, vendorPrefix)}: ${resolveTokens(
        key,
        value,
        tokens
      )};`;
    });

    const hash = hashString(cssRule);
    // Check if an atom exist with the same hash and return it if so
    const cachedAtom = keyFramesCache.get(hash);
    if (cachedAtom) {
      return cachedAtom;
    }
    // wrap it with the generated keyframes name
    cssRule = `@keyframes ${hash} {${cssRule}}`;
    const keyframesAtom = {
      id: String(hash),
      _cssRuleString: cssRule,
      toString: keyframesToString,
      [ATOM]: true as true,
    };
    keyFramesCache.set(hash, keyframesAtom);
    return keyframesAtom;
  };

  cssInstance.getStyles = (cb: any) => {
    // Reset the composition to avoid ssr issues
    compositionsCache.forEach((composition) => {
      composition.toString = toStringCompose;
    });
    // tslint:disable-next-line
    for (let sheet in sheets) {
      sheets[sheet].cssRules.length = 0;
    }
    if (baseTokens) {
      sheets.__variables__.insertRule(baseTokens);
    }

    // We have to reset our toStrings so that they will now inject again,
    // and still cache is it is being reused
    toString = createServerToString(sheets, config.breakpoints, cssClassnameProvider);
    keyframesToString = createKeyframesToString(sheets[MAIN_BREAKPOINT_ID]);
    themeToString = createThemeToString(classPrefix, sheets.__variables__);

    atomCache.forEach((atom) => {
      atom.toString = toString;
    });

    keyFramesCache.forEach((atom) => {
      atom.toString = keyframesToString;
    });

    themeCache.forEach((atom) => {
      atom.toString = themeToString;
    });

    const result = cb();

    return {
      result,
      styles: Object.keys(breakpoints).reduce(
        (aggr, key) => {
          return aggr.concat(`/* STITCHES:${key} */\n${sheets[key].cssRules.join('\n')}`);
        },
        [
          `/* STITCHES:__variables__ */\n${sheets.__variables__.cssRules.join('\n')}`,
          `/* STITCHES */\n${sheets[MAIN_BREAKPOINT_ID].cssRules.join('\n')}`,
        ]
      ),
    };
  };

  if (env) {
    hotReloadingCache.set(prefix, cssInstance);
  }

  return cssInstance;
};
