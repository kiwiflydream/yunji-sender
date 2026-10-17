// A deliberately small Markdown subset for notification bodies: headings,
// paragraphs, fenced code, lists, blockquotes, and inline code / bold / italic /
// strikethrough / links. Rendered to HTML (email), Telegram HTML, Slack mrkdwn
// and plain text. Anything else passes through as text.

type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold' | 'italic' | 'strike'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }

type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'para'; lines: Inline[][] }
  | { t: 'code'; v: string }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; lines: Inline[][] }

const INLINE_RE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_(?![\p{L}\p{N}])|\[([^\]]+)\]\(([^)\s]+)\)/gu

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of src.matchAll(INLINE_RE)) {
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) })
    if (m[1]) out.push({ t: 'code', v: m[2].trim() === '' ? m[2] : m[2].replace(/^ (.*) $/, '$1') })
    else if (m[3] ?? m[4]) out.push({ t: 'bold', c: parseInline(m[3] ?? m[4]) })
    else if (m[5]) out.push({ t: 'strike', c: parseInline(m[5]) })
    else if (m[6] ?? m[7]) out.push({ t: 'italic', c: parseInline(m[6] ?? m[7]) })
    else out.push({ t: 'link', href: m[9], c: parseInline(m[8]) })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) })
  return out
}

const LIST_RE = /^\s{0,3}(?:[-*+]|(\d+)[.)])\s+(.*)$/

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: Inline[][] = []
  const flush = () => {
    if (para.length) blocks.push({ t: 'para', lines: para })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s{0,3}(```|~~~)/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) code.push(lines[i])
      blocks.push({ t: 'code', v: code.join('\n') })
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ t: 'heading', level: heading[1].length, c: parseInline(heading[2]) })
      continue
    }
    const item = LIST_RE.exec(line)
    if (item) {
      flush()
      const ordered = item[1] !== undefined
      const items: Inline[][] = []
      for (; i < lines.length; i++) {
        const m = LIST_RE.exec(lines[i])
        if (!m || (m[1] !== undefined) !== ordered) break
        items.push(parseInline(m[2]))
      }
      i--
      blocks.push({ t: 'list', ordered, items })
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      flush()
      const quote: Inline[][] = []
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) {
        quote.push(parseInline(lines[i].replace(/^\s{0,3}>\s?/, '')))
      }
      i--
      blocks.push({ t: 'quote', lines: quote })
      continue
    }
    para.push(parseInline(line))
  }
  flush()
  return blocks
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const SAFE_HREF = /^(https?:|mailto:|tg:)/i

interface InlineRenderer {
  text(v: string): string
  code(v: string): string
  bold(inner: string): string
  italic(inner: string): string
  strike(inner: string): string
  link(href: string, inner: string, plainInner: string): string
}

function renderInline(nodes: Inline[], r: InlineRenderer): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return r.text(n.v)
        case 'code':
          return r.code(n.v)
        case 'bold':
        case 'italic':
        case 'strike':
          return r[n.t](renderInline(n.c, r))
        case 'link':
          return SAFE_HREF.test(n.href)
            ? r.link(n.href, renderInline(n.c, r), renderInline(n.c, PLAIN))
            : renderInline(n.c, r)
      }
    })
    .join('')
}

const PLAIN: InlineRenderer = {
  text: (v) => v,
  code: (v) => v,
  bold: (s) => s,
  italic: (s) => s,
  strike: (s) => s,
  link: (href, inner) => (inner === href ? href : `${inner} (${href})`),
}

const HTML: InlineRenderer = {
  text: escapeHtml,
  code: (v) => `<code>${escapeHtml(v)}</code>`,
  bold: (s) => `<strong>${s}</strong>`,
  italic: (s) => `<em>${s}</em>`,
  strike: (s) => `<s>${s}</s>`,
  link: (href, inner) => `<a href="${escapeHtml(href)}">${inner}</a>`,
}

// Telegram's HTML parse mode only knows b/i/s/u/code/pre/a/blockquote.
const TELEGRAM: InlineRenderer = {
  ...HTML,
  bold: (s) => `<b>${s}</b>`,
  italic: (s) => `<i>${s}</i>`,
}

const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const SLACK: InlineRenderer = {
  text: escapeSlack,
  code: (v) => `\`${escapeSlack(v)}\``,
  bold: (s) => `*${s}*`,
  italic: (s) => `_${s}_`,
  strike: (s) => `~${s}~`,
  link: (href, _inner, plain) => `<${href}|${escapeSlack(plain).replace(/\|/g, '¦')}>`,
}

/** Line-oriented targets (everything except HTML). */
function renderLines(blocks: Block[], r: InlineRenderer, wrap: { heading(s: string): string; code(v: string): string; quote(s: string): string }) {
  return blocks
    .map((b) => {
      switch (b.t) {
        case 'heading':
          return wrap.heading(renderInline(b.c, r))
        case 'para':
          return b.lines.map((l) => renderInline(l, r)).join('\n')
        case 'code':
          return wrap.code(b.v)
        case 'list':
          return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '•'} ${renderInline(it, r)}`).join('\n')
        case 'quote':
          return wrap.quote(b.lines.map((l) => renderInline(l, r)).join('\n'))
      }
    })
    .join('\n\n')
}

export function markdownToPlain(src: string): string {
  return renderLines(parseMarkdown(src), PLAIN, {
    heading: (s) => s,
    code: (v) => v,
    quote: (s) => s.split('\n').map((l) => `> ${l}`).join('\n'),
  })
}

export function markdownToTelegramHtml(src: string): string {
  return renderLines(parseMarkdown(src), TELEGRAM, {
    heading: (s) => `<b>${s}</b>`,
    code: (v) => `<pre>${escapeHtml(v)}</pre>`,
    quote: (s) => `<blockquote>${s}</blockquote>`,
  })
}

export function markdownToSlack(src: string): string {
  return renderLines(parseMarkdown(src), SLACK, {
    heading: (s) => `*${s}*`,
    code: (v) => `\`\`\`${escapeSlack(v)}\`\`\``,
    quote: (s) => s.split('\n').map((l) => `> ${l}`).join('\n'),
  })
}

export function markdownToHtml(src: string): string {
  return parseMarkdown(src)
    .map((b) => {
      switch (b.t) {
        case 'heading':
          return `<h${b.level}>${renderInline(b.c, HTML)}</h${b.level}>`
        case 'para':
          return `<p>${b.lines.map((l) => renderInline(l, HTML)).join('<br>')}</p>`
        case 'code':
          return `<pre><code>${escapeHtml(b.v)}</code></pre>`
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul'
          return `<${tag}>${b.items.map((it) => `<li>${renderInline(it, HTML)}</li>`).join('')}</${tag}>`
        }
        case 'quote':
          return `<blockquote>${b.lines.map((l) => renderInline(l, HTML)).join('<br>')}</blockquote>`
      }
    })
    .join('\n')
}
