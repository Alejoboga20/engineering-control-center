import { parse } from 'yaml';

export interface MarkdownDocument {
  frontmatter: 'none' | 'valid' | 'invalid';
  data: Record<string, unknown>;
  body: string;
}

/** Enough for real frontmatter. Also the most that listing reads from each file. */
export const MAX_FRONTMATTER_BYTES = 64 * 1024;

const OPENING = /^\uFEFF?---[ \t]*\r?\n/;
const CLOSING = /^---[ \t]*(?:\r?\n|$)/m;

/**
 * Claude Code accepts values that strict YAML rejects, such as `description: Use when: deploying`,
 * so one more attempt is made with plain top-level values quoted.
 */
function quotePlainValues(source: string): string {
  return source.replace(/^([A-Za-z][\w-]*):[ \t]+([^\s"'[{|>&*!#].*?)[ \t]*$/gm, (_line, key: string, value: string) =>
    `${key}: ${JSON.stringify(value)}`,
  );
}

function parseYaml(source: string): Record<string, unknown> | null {
  return parseStrictYaml(source) ?? parseStrictYaml(quotePlainValues(source));
}

function parseStrictYaml(source: string): Record<string, unknown> | null {
  try {
    // Not 'silent', which would also discard the parse errors that make a document invalid.
    const value: unknown = parse(source, { maxAliasCount: 16, logLevel: 'error' });
    if (value === null || value === undefined) return {};
    return typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Splits a Markdown file. Frontmatter can hold hook commands and MCP settings, so it never ends up
 * in the body. That includes frontmatter without a closing line, whose extent cannot be known, and
 * which therefore yields an empty body rather than a possible leak.
 */
export function parseMarkdownDocument(text: string): MarkdownDocument {
  const opening = OPENING.exec(text);
  if (!opening) return { frontmatter: 'none', data: {}, body: text.replace(/^\uFEFF/, '') };

  const rest = text.slice(opening[0].length);
  const closing = CLOSING.exec(rest);
  if (!closing) return { frontmatter: 'invalid', data: {}, body: '' };

  const body = rest.slice(closing.index + closing[0].length).replace(/^(?:\r?\n)+/, '');
  const source = rest.slice(0, closing.index);
  if (source.length > MAX_FRONTMATTER_BYTES) return { frontmatter: 'invalid', data: {}, body };

  const data = parseYaml(source);
  return data ? { frontmatter: 'valid', data, body } : { frontmatter: 'invalid', data: {}, body };
}
