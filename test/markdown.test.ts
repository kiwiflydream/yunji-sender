import { describe, expect, it } from 'vitest'
import { markdownToHtml, markdownToPlain, markdownToSlack, markdownToTelegramHtml } from '../src/lib/markdown'

const SAMPLE = `# 部署失败

服务 **api** 在 _prod_ 回滚，详情见 [日志](https://logs.test/1)。
运行 \`kubectl get pods\`

- 第一项
- 第二项 ~~旧~~

\`\`\`
a < b && c
\`\`\`

> 引用`

describe('markdown', () => {
  it('matches complete code delimiters and preserves unmatched runs', () => {
    expect(markdownToHtml('x ``a ` b`` y')).toBe('<p>x <code>a ` b</code> y</p>')
    expect(markdownToHtml('**before `x` after**')).toBe('<p><strong>before <code>x</code> after</strong></p>')
    expect(markdownToHtml('x ` a `')).toBe('<p>x <code>a</code></p>')
    expect(markdownToHtml('x `  `')).toBe('<p>x <code>  </code></p>')
    expect(markdownToPlain('x `` unmatched `')).toBe('x `` unmatched `')
  })

  it('renders HTML with escaping', () => {
    const html = markdownToHtml(SAMPLE)
    expect(html).toContain('<h1>部署失败</h1>')
    expect(html).toContain('<strong>api</strong>')
    expect(html).toContain('<em>prod</em>')
    expect(html).toContain('<a href="https://logs.test/1">日志</a>')
    expect(html).toContain('<code>kubectl get pods</code>')
    expect(html).toContain('<ul><li>第一项</li><li>第二项 <s>旧</s></li></ul>')
    expect(html).toContain('<pre><code>a &lt; b &amp;&amp; c</code></pre>')
    expect(html).toContain('<blockquote>引用</blockquote>')
  })

  it('renders Telegram HTML with only supported tags', () => {
    const tg = markdownToTelegramHtml(SAMPLE)
    expect(tg).toContain('<b>部署失败</b>')
    expect(tg).toContain('<b>api</b>')
    expect(tg).toContain('<i>prod</i>')
    expect(tg).toContain('• 第一项')
    expect(tg).toContain('<pre>a &lt; b &amp;&amp; c</pre>')
    expect(tg).not.toMatch(/<(h1|p|ul|li|strong|em)>/)
  })

  it('renders Slack mrkdwn', () => {
    const s = markdownToSlack(SAMPLE)
    expect(s).toContain('*部署失败*')
    expect(s).toContain('*api*')
    expect(s).toContain('_prod_')
    expect(s).toContain('<https://logs.test/1|日志>')
    expect(s).toContain('~旧~')
    expect(s).toContain('a &lt; b &amp;&amp; c')
  })

  it('strips to plain text', () => {
    const p = markdownToPlain(SAMPLE)
    expect(p).toContain('部署失败')
    expect(p).toContain('服务 api 在 prod 回滚，详情见 日志 (https://logs.test/1)。')
    expect(p).not.toContain('**')
  })

  it('does not link unsafe schemes or treat snake_case as italic', () => {
    expect(markdownToHtml('[x](javascript:alert(1))')).not.toContain('<a')
    expect(markdownToHtml('a snake_case_name here')).toBe('<p>a snake_case_name here</p>')
    expect(markdownToHtml('<script>')).toBe('<p>&lt;script&gt;</p>')
  })
})
