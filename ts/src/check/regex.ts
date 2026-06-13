// check/regex.ts — translate POSIX bracket expressions to JS RegExp equivalents.
//
// Oniguruma/jq patterns use POSIX character classes like [:space:] inside bracket
// expressions, e.g. [[:space:]], [^[:alnum:]_]. JS RegExp does NOT understand
// these — it silently treats `[:space:]` as a character set of literal chars.
//
// posixToJsRegex() replaces each `[:name:]` token (the inner POSIX class token)
// with its JS character class content before constructing the RegExp.
//
// Examples:
//   [[:space:]]   → [\s]
//   [^[:alnum:]_] → [^A-Za-z0-9_]
//   git[[:space:]]+commit → git[\s]+commit

/** Map of POSIX class names to their JS bracket-content equivalents. */
const POSIX_MAP: Record<string, string> = {
  space: "\\s",
  alnum: "A-Za-z0-9",
  alpha: "A-Za-z",
  digit: "0-9",
  upper: "A-Z",
  lower: "a-z",
  blank: " \\t",
  punct: "!-/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
};

/**
 * Translate POSIX bracket expressions in `pattern` to JS RegExp equivalents,
 * then return a new RegExp constructed from the translated pattern.
 *
 * Each `[:name:]` token inside a bracket expression is replaced with its JS
 * character class content string. Unknown POSIX class names are left as-is
 * so the caller still gets a useful error from the RegExp constructor.
 */
export function posixToJsRegex(pattern: string): RegExp {
  const translated = pattern.replace(/\[:(\w+):\]/g, (_match, name: string) => {
    return POSIX_MAP[name] ?? _match;
  });
  return new RegExp(translated);
}
