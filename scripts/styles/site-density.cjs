'use strict';

// Apply once after Tailwind so authored rules and generated utilities use the same scale.
// Keep the rem base and all layout dimensions intact; only typography and spacing change.
const FONT_REDUCTION_PX = 2;
const SPACING_SCALE = 0.8;
const KEEP = new Set('inherit initial unset revert revert-layer auto normal'.split(' '));
const SPACING = new Set((
  'padding padding-top padding-right padding-bottom padding-left padding-block padding-block-start padding-block-end ' +
  'padding-inline padding-inline-start padding-inline-end margin margin-top margin-right margin-bottom margin-left ' +
  'margin-block margin-block-start margin-block-end margin-inline margin-inline-start margin-inline-end ' +
  'gap row-gap column-gap grid-gap grid-row-gap grid-column-gap'
).split(' '));
const LENGTH = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[a-z%]+$/i;
const ZERO = /^[+-]?0(?:\.0+)?(?:[a-z%]+)?$/i;
const FUNCTION = /^(?:calc|min|max|clamp|var)\(/i;
const PARENT_RELATIVE = /(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|ch|cap|ic|lh|rlh)\b|%/i;

function fontSize(value) {
  const size = value.trim();
  // Inheritance and parent-relative labels already follow the smaller parent.
  if (KEEP.has(size.toLowerCase()) || ZERO.test(size) || PARENT_RELATIVE.test(size)) return null;
  if (!LENGTH.test(size) && !FUNCTION.test(size)) return null;
  const px = /^([\d.]+)px$/i.exec(size);
  return px ? `${Math.max(0, Number(px[1]) - FONT_REDUCTION_PX)}px` : `calc(${size} - ${FONT_REDUCTION_PX}px)`;
}

function fontShorthand(value, list) {
  if (KEEP.has(value.trim().toLowerCase()) || /^var\(/i.test(value.trim())) return null;
  const tokens = list.space(value);
  for (let index = 0; index < tokens.length; index++) {
    // PostCSS splits outside functions/quotes, including calc(...)/line-height.
    const parts = list.split(tokens[index], ['/']);
    if (!LENGTH.test(parts[0]) && !FUNCTION.test(parts[0])) continue;
    const next = fontSize(parts[0]);
    if (next === null) return null;
    tokens[index] = next + tokens[index].slice(parts[0].length);
    return tokens.join(' ');
  }
  return null;
}

module.exports = () => {
  const completed = new WeakSet();
  return {
    postcssPlugin: 'site-density',
    OnceExit(root, { list }) {
      if (completed.has(root)) return;
      completed.add(root);
      root.walkDecls(decl => {
        const prop = decl.prop.toLowerCase();
        if (prop === 'font' || prop === 'font-size') {
          const rule = decl.parent;
          if (rule.type === 'rule' && list.comma(rule.selector).some(selector =>
            /^(?:html|:root|:host)(?![\w-])[^\s>+~]*$/i.test(selector))) return;
          const next = prop === 'font-size' ? fontSize(decl.value) : fontShorthand(decl.value, list);
          if (next !== null) decl.value = next;
        } else if (SPACING.has(prop)) {
          decl.value = list.space(decl.value).map(part => KEEP.has(part.toLowerCase()) || ZERO.test(part)
            ? part : `calc(${part} * ${SPACING_SCALE})`).join(' ');
        }
      });
    },
  };
};

module.exports.postcss = true;
