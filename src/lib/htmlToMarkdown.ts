// Converts pasted clipboard HTML (Google Docs, Word, browsers, etc.) into the lightweight
// Markdown-ish plain text Second Brain notes are stored as — paragraphs, nested bullet/
// numbered lists (indentation), headings, blockquotes, and bold/italic/strikethrough/links —
// so formatting survives a paste instead of collapsing into one run-on line. Notes stay plain
// text (not HTML) because [[wikilinks]], PARA templates, and backlink parsing all operate on
// the raw string.

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
  'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'TR', 'TABLE', 'THEAD', 'TBODY'
]);

function containsBlockChild(el: Element): boolean {
  return Array.from(el.children).some(c => BLOCK_TAGS.has(c.tagName));
}

function inlineToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === 'BR') return '\n';
  if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'STYLE') return '';

  const inner = Array.from(el.childNodes).map(inlineToMarkdown).join('');

  if (tag === 'CODE') return `\`${inner}\``;
  if (tag === 'A') {
    const href = el.getAttribute('href');
    return href && /^https?:\/\//i.test(href) && inner.trim() ? `[${inner}](${href})` : inner;
  }

  const bold = tag === 'B' || tag === 'STRONG' || el.style.fontWeight === 'bold' ||
    (el.style.fontWeight !== '' && Number(el.style.fontWeight) >= 600);
  const italic = tag === 'I' || tag === 'EM' || el.style.fontStyle === 'italic';
  const strike = tag === 'S' || tag === 'STRIKE' || tag === 'DEL' ||
    /line-through/.test(el.style.textDecorationLine || el.style.textDecoration || '');

  let text = inner;
  if (strike) text = `~~${text}~~`;
  if (italic) text = `*${text}*`;
  if (bold) text = `**${text}**`;
  return text;
}

function inlineText(node: ParentNode): string {
  return Array.from(node.childNodes).map(inlineToMarkdown).join('').replace(/[ \t]+/g, ' ').trim();
}

function listToMarkdown(listEl: HTMLElement, depth: number): string {
  const ordered = listEl.tagName === 'OL';
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  let index = 0;
  for (const li of Array.from(listEl.children)) {
    if (li.tagName !== 'LI') continue;
    index++;
    const nestedLists = Array.from(li.children).filter(c => c.tagName === 'UL' || c.tagName === 'OL');
    const clone = li.cloneNode(true) as HTMLElement;
    Array.from(clone.children).forEach(c => { if (c.tagName === 'UL' || c.tagName === 'OL') clone.removeChild(c); });
    const text = inlineText(clone);
    const marker = ordered ? `${index}.` : '-';
    lines.push(`${indent}${marker} ${text}`);
    for (const nested of nestedLists) {
      const nestedMd = listToMarkdown(nested as HTMLElement, depth + 1);
      if (nestedMd) lines.push(nestedMd);
    }
  }
  return lines.join('\n');
}

function blockToMarkdown(node: ParentNode): string {
  let out = '';
  let buffer = '';
  const flush = () => {
    const t = buffer.replace(/[ \t]+/g, ' ').trim();
    if (t) out += `${t}\n\n`;
    buffer = '';
  };

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) continue;
    if (child.nodeType === Node.TEXT_NODE) { buffer += child.textContent ?? ''; continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName;

    if (tag === 'UL' || tag === 'OL') {
      flush();
      out += `${listToMarkdown(el, 0)}\n\n`;
    } else if (tag === 'BLOCKQUOTE') {
      flush();
      const inner = (containsBlockChild(el) ? blockToMarkdown(el) : inlineText(el)).trim();
      if (inner) out += `${inner.split('\n').map(l => `> ${l}`).join('\n')}\n\n`;
    } else if (/^H[1-6]$/.test(tag)) {
      flush();
      const text = inlineText(el);
      if (text) out += `${'#'.repeat(Number(tag[1]))} ${text}\n\n`;
    } else if (tag === 'PRE') {
      flush();
      out += `\`\`\`\n${el.textContent ?? ''}\n\`\`\`\n\n`;
    } else if (tag === 'BR') {
      buffer += '\n';
    } else if (containsBlockChild(el)) {
      flush();
      out += blockToMarkdown(el);
    } else if (BLOCK_TAGS.has(tag)) {
      flush();
      const text = inlineText(el);
      if (text) out += `${text}\n\n`;
    } else {
      buffer += inlineToMarkdown(el);
    }
  }
  flush();
  return out;
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style, script, meta, link, img, table').forEach(n => n.remove());
  return blockToMarkdown(doc.body).trim().replace(/\n{3,}/g, '\n\n');
}
