/**
 * Models with web search can emit private-use source markers, for example
 * U+E200 "cite" U+E202 <source> U+E202 <source> U+E201. No client can render them, so a
 * complete citation becomes Markdown source links and other marker kinds keep only their
 * readable text. The result stays append-only while streaming: an unfinished marker is
 * withheld until it closes, or stripped once the answer is final.
 */
const open = '\uE200', close = '\uE201', separator = '\uE202';
const privateMarkers = /[\uE200-\uE2FF]/g;

function sourceLink(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.replace(/^www\./, '');
  // Parentheses and spaces would end a Markdown link destination early.
  const href = url.href.replace(/[()\s]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  return `[${host}](${href})`;
}

function readable(kind: string, values: string[]): string {
  if (kind === 'cite' || kind === 'filecite') {
    const links = [...new Set(values.map(sourceLink).filter((link): link is string => !!link))];
    return links.length ? `(${links.join(', ')})` : '';
  }
  // e.g. entity: ["city","Shanghai",...] — show the display name.
  try {
    const parsed: unknown = JSON.parse(values[0] ?? '');
    if (Array.isArray(parsed) && typeof parsed[1] === 'string') return parsed[1];
  } catch { /* not a structured entity */ }
  return '';
}

export function normalizeAnswerText(text: string, options: { final: boolean }): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(open, index);
    if (start < 0) { output += text.slice(index).replace(privateMarkers, ''); break; }
    output += text.slice(index, start).replace(privateMarkers, '');
    let end = text.indexOf(close, start + 1);
    if (end < 0) {
      if (!options.final) break;
      end = text.length; // A final answer closes its trailing marker.
    }
    const [kind = '', ...values] = text.slice(start + 1, end).replace(/[\uE200\uE201\uE203-\uE2FF]/g, '').split(separator);
    const replacement = readable(kind.trim(), values);
    if (replacement) output += (output && !/\s$/.test(output) ? ' ' : '') + replacement;
    index = end + 1;
  }
  return output;
}
