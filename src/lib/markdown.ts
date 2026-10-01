// A small, safe Markdown → HTML converter for assistant answers. Everything is HTML-escaped
// first, then only the handful of constructs below are turned into tags, so model output can
// never inject markup. Supports: headings, bold/italic, inline + fenced code, bullet and numbered
// lists, blockquotes, links (http/https only), horizontal rules and paragraphs.

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text: string): string {
  let out = escapeHtml(text);
  // Inline code first, so its contents aren't touched by the emphasis rules.
  const codes: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_, c: string) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

/** `copyButtons` adds a Copy button to each code block (for on-screen answers, not saved notes). */
export function markdownToHtml(markdown: string, options: { copyButtons?: boolean } = {}): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[]; start?: number } | null = null;
  let quote: string[] = [];

  const flushPara = () => { if (para.length) { html.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { html.push(`<${list.type}${list.start && list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { html.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```/);
    if (fence) {
      flushAll();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      html.push(`<pre>${options.copyButtons ? '<button type="button" class="research-copy-code" data-copy-code>Copy</button>' : ''}<code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushAll(); continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { flushAll(); const level = Math.min(4, heading[1].length + 2); html.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushAll(); html.push('<hr>'); continue; }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara(); flushQuote();
      const type = bullet ? 'ul' : 'ol';
      // A numbered list interrupted by bullets or a paragraph carries on from its own number.
      if (!list || list.type !== type) { flushList(); list = { type, items: [], start: numbered ? Number(numbered[1]) : undefined }; }
      list.items.push(bullet ? bullet[1] : numbered![2]);
      continue;
    }
    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) { flushPara(); flushList(); quote.push(quoted[1]); continue; }
    // An indented continuation of a list item stays with that item.
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList(); flushQuote();
    para.push(line);
  }
  flushAll();
  return html.join('');
}

/** The bullet / numbered list items in an answer, as plain text — what "Add to Tasks" offers. */
export function listItemsOf(markdown: string): string[] {
  const items: string[] = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (!m) continue;
    const text = m[1].replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
    if (text) items.push(text.length > 140 ? `${text.slice(0, 137).trimEnd()}…` : text);
  }
  return items;
}

export { escapeHtml };
