import { describe, it, expect } from 'vitest';
import { spineToHtml, type Block, type AttachmentContent } from '../src/index.js';

/**
 * spineToHtml is the read-only render core for the PUBLIC URL-share surface (ROAD-0011 P2 §3). It is
 * unauthenticated OUTPUT, so the bar is: (1) every core block type + inline mark renders to semantic HTML,
 * (2) ALL content is HTML-escaped — a note body can never inject markup/script, (3) link hrefs are
 * scheme-gated (javascript:/data: degrade to inert text), (4) attachments resolve through the injected
 * token-scoped URL resolver, (5) output is deterministic.
 */

const p = (text: string): Block => ({ id: 'b', type: 'paragraph', content: { segments: [{ text }] } });

describe('spineToHtml — core block types', () => {
  it('renders headings at their level', () => {
    const blocks: Block[] = [
      { id: '1', type: 'heading', content: { level: 1, segments: [{ text: 'Title' }] } },
      { id: '2', type: 'heading', content: { level: 3, segments: [{ text: 'Sub' }] } },
    ];
    expect(spineToHtml(blocks)).toBe('<h1>Title</h1><h3>Sub</h3>');
  });

  it('clamps an out-of-range / missing heading level to 1', () => {
    expect(spineToHtml([{ id: '1', type: 'heading', content: { level: 9, segments: [{ text: 'X' }] } }])).toBe('<h1>X</h1>');
    expect(spineToHtml([{ id: '1', type: 'heading', content: { segments: [{ text: 'X' }] } }])).toBe('<h1>X</h1>');
  });

  it('renders paragraphs', () => {
    expect(spineToHtml([p('hello world')])).toBe('<p>hello world</p>');
  });

  it('renders a divider', () => {
    expect(spineToHtml([{ id: '1', type: 'divider' }])).toBe('<hr>');
  });

  it('renders a code block, escaping its contents and carrying the language class', () => {
    const b: Block = { id: '1', type: 'code', content: { code: 'const x = 1 < 2 && a > b;', language: 'ts' } };
    expect(spineToHtml([b])).toBe('<pre><code class="language-ts">const x = 1 &lt; 2 &amp;&amp; a &gt; b;</code></pre>');
  });

  it('renders a quote with a first line and child blocks', () => {
    const b: Block = {
      id: '1',
      type: 'quote',
      content: { segments: [{ text: 'first' }] },
      children: [p('second')],
    };
    expect(spineToHtml([b])).toBe('<blockquote><p>first</p><p>second</p></blockquote>');
  });

  it('renders a top-level todo with a disabled checkbox reflecting checked state', () => {
    const done: Block = { id: '1', type: 'todo', content: { checked: true, segments: [{ text: 'done' }] } };
    const open: Block = { id: '2', type: 'todo', content: { checked: false, segments: [{ text: 'todo' }] } };
    expect(spineToHtml([done])).toContain('<input type="checkbox" disabled checked>');
    expect(spineToHtml([open])).toContain('<input type="checkbox" disabled>');
    expect(spineToHtml([open])).toContain('<span class="dltos-todo__label">todo</span>');
  });

  it('renders bullet + ordered lists with items, including nested lists and todo items', () => {
    const list: Block = {
      id: 'l',
      type: 'list',
      content: { ordered: false },
      children: [
        {
          id: 'i1',
          type: 'paragraph',
          content: { segments: [{ text: 'one' }] },
          children: [
            { id: 'sub', type: 'list', content: { ordered: true }, children: [
              { id: 's1', type: 'paragraph', content: { segments: [{ text: 'a' }] } },
            ] },
          ],
        },
        { id: 'i2', type: 'todo', content: { checked: true, segments: [{ text: 'two' }] } },
      ],
    };
    const html = spineToHtml([list]);
    expect(html).toBe(
      '<ul><li>one<ol><li>a</li></ol></li><li><input type="checkbox" disabled checked> <span class="dltos-todo__label">two</span></li></ul>',
    );
  });
});

describe('spineToHtml — inline marks', () => {
  const one = (seg: Record<string, unknown>): string => spineToHtml([{ id: '1', type: 'paragraph', content: { segments: [seg] } }]);

  it('renders bold/italic/code/strike/highlight/underline', () => {
    expect(one({ text: 'x', bold: true })).toBe('<p><strong>x</strong></p>');
    expect(one({ text: 'x', italic: true })).toBe('<p><em>x</em></p>');
    expect(one({ text: 'x', code: true })).toBe('<p><code>x</code></p>');
    expect(one({ text: 'x', strike: true })).toBe('<p><s>x</s></p>');
    expect(one({ text: 'x', highlight: true })).toBe('<p><mark>x</mark></p>');
    expect(one({ text: 'x', underline: true })).toBe('<p><u>x</u></p>');
  });

  it('nests multiple marks deterministically (link outermost)', () => {
    expect(one({ text: 'x', bold: true, italic: true, link: 'https://e.com' })).toBe(
      '<p><a href="https://e.com" rel="noopener nofollow ugc" target="_blank"><strong><em>x</em></strong></a></p>',
    );
  });

  it('renders a hard-break segment as <br>', () => {
    expect(one({ text: '\n' })).toBe('<p><br></p>');
  });

  it('renders a formula/compute atom as its source spec text', () => {
    expect(one({ text: '2+2', formula: { type: 'math', state: null } })).toBe('<p><span class="dltos-formula">2+2</span></p>');
  });
});

describe('spineToHtml — escaping + link safety (security)', () => {
  it('escapes HTML metacharacters in text content', () => {
    expect(spineToHtml([p('<script>alert(1)</script> & "quotes"')])).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quotes"</p>',
    );
  });

  it('drops a javascript: link, keeping the (escaped) text inert', () => {
    const seg = { text: 'click <me>', link: 'javascript:alert(1)' };
    expect(spineToHtml([{ id: '1', type: 'paragraph', content: { segments: [seg] } }])).toBe('<p>click &lt;me&gt;</p>');
  });

  it('drops a data: link but keeps an http(s)/mailto/relative link', () => {
    const mk = (link: string) => spineToHtml([{ id: '1', type: 'paragraph', content: { segments: [{ text: 't', link }] } }]);
    expect(mk('data:text/html,<x>')).toBe('<p>t</p>');
    expect(mk('mailto:a@b.com')).toContain('href="mailto:a@b.com"');
    expect(mk('/relative/path')).toContain('href="/relative/path"');
  });

  it('escapes a quote-injection attempt in an href attribute', () => {
    const html = spineToHtml([{ id: '1', type: 'paragraph', content: { segments: [{ text: 't', link: 'https://e.com/"><img>' }] } }]);
    expect(html).toContain('href="https://e.com/&quot;&gt;&lt;img&gt;"');
    expect(html).not.toContain('<img>');
  });
});

describe('spineToHtml — attachments', () => {
  const img: Block = { id: '1', type: 'attachment', content: { hash: 'abc', name: 'pic.png', mime: 'image/png', size: 10 } as AttachmentContent };
  const file: Block = { id: '2', type: 'attachment', content: { hash: 'def', name: 're<p>ort.pdf', mime: 'application/pdf', size: 20 } as AttachmentContent };

  it('renders an image attachment as <img> pointing at the resolved token-scoped URL', () => {
    const html = spineToHtml([img], { attachmentUrl: (a) => `/s/TOK/blob/${a.hash}` });
    expect(html).toBe('<figure class="dltos-attachment dltos-attachment--image"><img src="/s/TOK/blob/abc" alt="pic.png" loading="lazy"></figure>');
  });

  it('renders a non-image attachment as a download link, escaping the filename', () => {
    const html = spineToHtml([file], { attachmentUrl: (a) => `/s/TOK/blob/${a.hash}` });
    expect(html).toBe('<p class="dltos-attachment dltos-attachment--file"><a href="/s/TOK/blob/def" download>re&lt;p&gt;ort.pdf</a></p>');
  });

  it('renders inert filename text when no URL resolver is supplied', () => {
    expect(spineToHtml([img])).toBe('<p class="dltos-attachment"><span class="dltos-attachment__name">pic.png</span></p>');
  });

  it('degrades a malformed attachment block gracefully', () => {
    expect(spineToHtml([{ id: '1', type: 'attachment', content: { junk: true } }])).toBe(
      '<p class="dltos-attachment dltos-attachment--broken">[attachment]</p>',
    );
  });
});

describe('spineToHtml — determinism', () => {
  it('produces identical output across repeated calls', () => {
    const blocks: Block[] = [p('a'), { id: '2', type: 'divider' }, p('b')];
    expect(spineToHtml(blocks)).toBe(spineToHtml(blocks));
  });
});
