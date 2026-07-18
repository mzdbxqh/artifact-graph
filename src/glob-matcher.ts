/**
 * Match a normalized project-relative path against the runner glob subset used
 * by artifact-graph. A double-star directory prefix matches zero or more path
 * segments, while `*` and
 * `?` never cross a path separator.
 */
export function matchesRunnerGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeGlobValue(filePath);
  const normalizedPattern = normalizeGlobValue(pattern);
  let expression = '^';

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === '*') {
      if (normalizedPattern[index + 1] === '*') {
        while (normalizedPattern[index + 1] === '*') {
          index += 1;
        }
        if (normalizedPattern[index + 1] === '/') {
          index += 1;
          expression += '(?:[^/]+/)*';
        } else {
          expression += '.*';
        }
      } else {
        expression += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      expression += '[^/]';
      continue;
    }
    expression += escapeRegexCharacter(character);
  }

  expression += '$';
  return new RegExp(expression).test(normalizedPath);
}

function normalizeGlobValue(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegexCharacter(character: string): string {
  return '\\^$+?.()|{}[]'.includes(character)
    ? String.fromCharCode(92) + character
    : character;
}
