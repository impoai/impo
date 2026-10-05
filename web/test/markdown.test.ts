import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMath } from "../src/markdown.ts";

const render = (text: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkMath],
      rehypePlugins: [[rehypeKatex, { trust: false }]],
      children: normalizeMath(text),
    }),
  );

test("shopping prices remain readable while native TeX delimiters render equations", () => {
  const html = render(
    "Compare **$141.99** with **$249.95**, or save $20. Use $x^2$ and \\(a+b\\).\n\\[x=2\\]",
  );
  assert.match(html, /<strong>\$141\.99<\/strong>/);
  assert.match(html, /<strong>\$249\.95<\/strong>/);
  assert.match(html, /save \$20/);
  assert.equal((html.match(/class="katex"/g) || []).length, 3);
  assert.match(html, /class="katex-display"/);
});

test("code and incomplete streamed math are literal until the closing delimiter arrives", () => {
  const code = "`$x$`\n\n```tex\n\\(x\\) and $5\n```\n\n    $z$\n";
  assert.equal(normalizeMath(code), code);
  assert.doesNotMatch(render(code), /class="katex/);
  assert.doesNotMatch(render("Working: \\(x+1"), /class="katex/);
  assert.match(render("Working: \\(x+1\\)"), /class="katex"/);
  assert.doesNotMatch(render("\\$5 and \\$10; $20 and $30"), /class="katex/);
});
