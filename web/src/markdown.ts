/** Match native math boundaries before Markdown interprets TeX or currency. */
export function normalizeMath(source: string): string {
  let output = "";
  let i = 0;
  let fence: { marker: string; length: number } | undefined;
  const escaped = (at: number) => {
    let count = 0;
    while (at > 0 && source[--at] === "\\") count++;
    return count % 2 === 1;
  };
  const delimiters = [
    ["\\[", "\\]", true],
    ["\\(", "\\)", false],
    ["$$", "$$", true],
    ["$", "$", false],
  ] as const;
  while (i < source.length) {
    if (!i || source[i - 1] === "\n") {
      const newline = source.indexOf("\n", i);
      const end = newline < 0 ? source.length : newline;
      const line = source.slice(i, end);
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker) {
        if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
        else if (
          marker[1][0] === fence.marker &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        )
          fence = undefined;
      }
      if (marker || fence || /^(?: {4}|\t)/.test(line)) {
        output += source.slice(i, end + (newline < 0 ? 0 : 1));
        i = end + (newline < 0 ? 0 : 1);
        continue;
      }
    }
    if (source[i] === "`" && !escaped(i)) {
      const run = /^`+/.exec(source.slice(i))![0];
      let end = i + run.length;
      while (end < source.length) {
        if (source[end] !== "`") {
          end++;
          continue;
        }
        const closing = /^`+/.exec(source.slice(end))![0];
        end += closing.length;
        if (closing.length === run.length) break;
      }
      output += source.slice(i, end);
      i = end;
      continue;
    }
    let consumed = false;
    for (const [open, close, display] of delimiters) {
      if (!source.startsWith(open, i) || escaped(i)) continue;
      const start = i + open.length;
      if (
        start >= source.length ||
        (open === "$" && /[\s$]/.test(source[start]))
      )
        continue;
      let end = start;
      while (end < source.length) {
        if (!display && /[\n`]/.test(source[end])) break;
        if (source.startsWith(close, end) && !escaped(end)) {
          // A dollar followed by a digit starts the next price, not an equation's end.
          if (
            end === start ||
            (open === "$" &&
              (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] || "")))
          )
            break;
          const body = source.slice(start, end);
          output += display ? `\n$$\n${body}\n$$\n` : `$${body}$`;
          i = end + close.length;
          consumed = true;
          break;
        }
        end++;
      }
      if (consumed) break;
      if (open !== "$") {
        // Preserve unfinished streamed equations until a later snapshot closes them.
        output += source.slice(i, end).replace(/[$\\]/g, "\\$&");
        i = end;
        consumed = true;
        break;
      }
    }
    if (!consumed) {
      if (source[i] === "$" && !escaped(i)) output += "\\";
      output += source[i++];
    }
  }
  return output;
}
