import { describe, it, expect } from 'vitest';
import {
  spineToMarkdown,
  markdownToBody,
  buildAttachmentBlock,
  type Block,
} from '../src/index.js';

/**
 * spineToMarkdown is the OUTBOUND sibling of {@link markdownToBody} (the inbound parse) and the pure
 * Block[]→markdown emitter behind ROAD-0017 "Export as Markdown". Its emission MUST match the client's
 * copy serializer (client/src/editor/clipboard.ts nodeToText) conventions so the two never drift.
 *
 * The strong correctness check is ROUND-TRIP: for core block types + inline marks,
 * `markdownToBody(spineToMarkdown(blocks))` normalize-equals the original blocks (ids differ — they are
 * freshly minted on parse — so we compare STRUCTURE: type / content / children, ids stripped).
 */

// A quick block factory for readable fixtures.
const para = (text: string): Block => ({ id: 'p', type: 'paragraph', content: { segments: [{ text }] } });
const heading = (level: number, text: string): Block => ({ id: 'h', type: 'heading', content: { level, segments: [{ text }] } });

// Strip ids recursively so round-trip compares STRUCTURE, not the freshly-minted parse ids.
type Bare = { type: string; content?: unknown; children?: Bare[] };
function bare(blocks: Block[]): Bare[] {
  return blocks.map((b) => {
    const out: Bare = { type: b.type };
    if (b.content !== undefined) out.content = b.content;
    if (b.children) out.children = bare(b.children);
    return out;
  });
}
/** Round-trip a spine body through markdown and back, comparing structure (ids stripped). */
const roundTrips = (blocks: Block[]) => expect(bare(markdownToBody(spineToMarkdown(blocks)))).toEqual(bare(blocks));

describe('spineToMarkdown — headings', () => {
  it('emits # markers matching the level', () => {
    for (let lvl = 1; lvl <= 6; lvl++) {
      expect(spineToMarkdown([heading(lvl, 'Title')])).toBe('#'.repeat(lvl) + ' Title');
    }
  });
  it('round-trips every heading level', () => {
    for (let lvl = 1; lvl <= 6; lvl++) roundTrips([heading(lvl, `Heading ${lvl}`)]);
  });
});

describe('spineToMarkdown — paragraphs', () => {
  it('emits plain paragraph text', () => {
    expect(spineToMarkdown([para('just a note')])).toBe('just a note');
  });
  it('separates two paragraphs with a blank line', () => {
    expect(spineToMarkdown([para('one'), para('two')])).toBe('one\n\ntwo');
  });
  it('round-trips two paragraphs', () => {
    roundTrips([para('first line'), para('second line')]);
  });
});

describe('spineToMarkdown — inline marks', () => {
  const seg = (s: Record<string, unknown>): Block => ({ id: 'p', type: 'paragraph', content: { segments: [s] } });

  it('bold → **', () => { expect(spineToMarkdown([seg({ text: 'x', bold: true })])).toBe('**x**'); });
  it('italic → *', () => { expect(spineToMarkdown([seg({ text: 'x', italic: true })])).toBe('*x*'); });
  it('strike → ~~', () => { expect(spineToMarkdown([seg({ text: 'x', strike: true })])).toBe('~~x~~'); });
  it('highlight → ==', () => { expect(spineToMarkdown([seg({ text: 'x', highlight: true })])).toBe('==x=='); });
  it('code → backticks', () => { expect(spineToMarkdown([seg({ text: 'fn()', code: true })])).toBe('`fn()`'); });
  it('underline → <u>', () => { expect(spineToMarkdown([seg({ text: 'x', underline: true })])).toBe('<u>x</u>'); });
  it('link → [text](href)', () => {
    expect(spineToMarkdown([seg({ text: 'Anthropic', link: 'https://anthropic.com' })])).toBe('[Anthropic](https://anthropic.com)');
  });

  it('mixes a mark with surrounding plain text', () => {
    const b: Block = { id: 'p', type: 'paragraph', content: { segments: [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c' }] } };
    expect(spineToMarkdown([b])).toBe('a **b** c');
  });

  it('round-trips each single mark', () => {
    roundTrips([seg({ text: 'bold', bold: true })]);
    roundTrips([seg({ text: 'ital', italic: true })]);
    roundTrips([seg({ text: 'struck', strike: true })]);
    roundTrips([seg({ text: 'hl', highlight: true })]);
    roundTrips([seg({ text: 'code', code: true })]);
    roundTrips([seg({ text: 'under', underline: true })]);
    roundTrips([seg({ text: 'link', link: 'https://example.com' })]);
  });

  it('round-trips a mark amid plain text', () => {
    roundTrips([{ id: 'p', type: 'paragraph', content: { segments: [{ text: 'see ' }, { text: 'here', bold: true }, { text: ' now' }] } }]);
  });

  it('emits a formula segment as its source-spec text (matches staticHtml source-render)', () => {
    const b: Block = { id: 'p', type: 'paragraph', content: { segments: [{ text: '=2+2', formula: { kind: 'math' } }] } };
    expect(spineToMarkdown([b])).toBe('=2+2');
  });
});

describe('spineToMarkdown — todos', () => {
  it('emits an unchecked / checked top-level todo', () => {
    expect(spineToMarkdown([{ id: 't', type: 'todo', content: { checked: false, segments: [{ text: 'buy milk' }] } }])).toBe('[ ] buy milk');
    expect(spineToMarkdown([{ id: 't', type: 'todo', content: { checked: true, segments: [{ text: 'done' }] } }])).toBe('[x] done');
  });
  it('round-trips top-level todos', () => {
    roundTrips([{ id: 't', type: 'todo', content: { checked: false, segments: [{ text: 'open task' }] } }]);
    roundTrips([{ id: 't', type: 'todo', content: { checked: true, segments: [{ text: 'closed task' }] } }]);
  });
});

describe('spineToMarkdown — divider', () => {
  it('emits ---', () => { expect(spineToMarkdown([{ id: 'd', type: 'divider' }])).toBe('---'); });
  it('round-trips a divider between paragraphs', () => {
    roundTrips([para('above'), { id: 'd', type: 'divider' }, para('below')]);
  });
});

describe('spineToMarkdown — quote', () => {
  it('emits a single-line quote with > prefix', () => {
    expect(spineToMarkdown([{ id: 'q', type: 'quote', content: { segments: [{ text: 'to be' }] } }])).toBe('> to be');
  });
  it('emits a multi-line quote (children as > lines)', () => {
    const b: Block = { id: 'q', type: 'quote', content: { segments: [{ text: 'line one' }] }, children: [para('line two')] };
    expect(spineToMarkdown([b])).toBe('> line one\n> line two');
  });
  it('round-trips a single- and multi-line quote', () => {
    roundTrips([{ id: 'q', type: 'quote', content: { segments: [{ text: 'a quote' }] } }]);
    roundTrips([{ id: 'q', type: 'quote', content: { segments: [{ text: 'line one' }] }, children: [para('line two')] }]);
  });
});

describe('spineToMarkdown — code block', () => {
  it('fences with a language', () => {
    expect(spineToMarkdown([{ id: 'c', type: 'code', content: { code: 'x()', language: 'js' } }])).toBe('```js\nx()\n```');
  });
  it('fences with no language', () => {
    expect(spineToMarkdown([{ id: 'c', type: 'code', content: { code: 'let x = 1\nlet y = 2' } }])).toBe('```\nlet x = 1\nlet y = 2\n```');
  });
  it('round-trips a code block with + without a language', () => {
    roundTrips([{ id: 'c', type: 'code', content: { code: 'const a = 3', language: 'ts' } }]);
    roundTrips([{ id: 'c', type: 'code', content: { code: 'plain\ncode' } }]);
  });
  it('does NOT re-interpret markdown inside a code fence (round-trips raw)', () => {
    roundTrips([{ id: 'c', type: 'code', content: { code: '# not a heading\n- not a list' } }]);
  });
});

describe('spineToMarkdown — lists', () => {
  const list = (ordered: boolean, children: Block[]): Block => ({ id: 'l', type: 'list', content: { ordered }, children });

  it('emits a bullet list', () => {
    expect(spineToMarkdown([list(false, [para('apple'), para('pear')])])).toBe('- apple\n- pear');
  });
  it('emits an ordered list numbered from 1', () => {
    expect(spineToMarkdown([list(true, [para('first'), para('second')])])).toBe('1. first\n2. second');
  });
  it('emits todo items inside a bullet list', () => {
    const todos = list(false, [
      { id: 'i', type: 'todo', content: { checked: false, segments: [{ text: 'wash car' }] } },
      { id: 'i', type: 'todo', content: { checked: true, segments: [{ text: 'fill tank' }] } },
    ]);
    expect(spineToMarkdown([todos])).toBe('- [ ] wash car\n- [x] fill tank');
  });
  it('emits a 2-space-indented nested sublist', () => {
    const nested = list(false, [{ ...para('parent'), children: [list(false, [para('child a'), para('child b')])] }]);
    expect(spineToMarkdown([nested])).toBe('- parent\n  - child a\n  - child b');
  });

  it('round-trips a bullet list', () => { roundTrips([list(false, [para('apple'), para('pear')])]); });
  it('round-trips an ordered list', () => { roundTrips([list(true, [para('one'), para('two'), para('three')])]); });
  it('round-trips a list of todo items', () => {
    roundTrips([list(false, [
      { id: 'i', type: 'todo', content: { checked: false, segments: [{ text: 'a' }] } },
      { id: 'i', type: 'todo', content: { checked: true, segments: [{ text: 'b' }] } },
    ])]);
  });
  it('round-trips a nested sublist', () => {
    roundTrips([list(false, [{ ...para('parent'), children: [list(false, [para('child a'), para('child b')])] }])]);
  });
});

describe('spineToMarkdown — attachments', () => {
  const att = buildAttachmentBlock({ hash: 'abc123', name: 'photo.png', mime: 'image/png', size: 10 });
  const fileAtt = buildAttachmentBlock({ hash: 'def456', name: 'report.pdf', mime: 'application/pdf', size: 20 });

  it('emits a markdown image for an image attachment when a URL resolver is given', () => {
    expect(spineToMarkdown([att], { attachmentUrl: () => 'blob:xyz' })).toBe('![photo.png](blob:xyz)');
  });
  it('emits a markdown link for a non-image attachment when a URL resolver is given', () => {
    expect(spineToMarkdown([fileAtt], { attachmentUrl: () => 'blob:pdf' })).toBe('[report.pdf](blob:pdf)');
  });
  it('emits the bare filename when no URL can be resolved', () => {
    expect(spineToMarkdown([att])).toBe('photo.png');
    expect(spineToMarkdown([att], { attachmentUrl: () => null })).toBe('photo.png');
  });
});

describe('spineToMarkdown — title option', () => {
  it('prepends the title as a leading # heading', () => {
    expect(spineToMarkdown([para('body text')], { title: 'My Note' })).toBe('# My Note\n\nbody text');
  });
  it('omits the title when blank / absent', () => {
    expect(spineToMarkdown([para('body text')], { title: '   ' })).toBe('body text');
    expect(spineToMarkdown([para('body text')])).toBe('body text');
  });
});

describe('spineToMarkdown — unknown block', () => {
  it('emits inline segments for an unknown text-bearing block, matching staticHtml default', () => {
    expect(spineToMarkdown([{ id: 'u', type: 'weird', content: { segments: [{ text: 'hi' }] } }])).toBe('hi');
  });
  it('omits an unknown block with no segments', () => {
    expect(spineToMarkdown([{ id: 'u', type: 'weird', content: { foo: 1 } }])).toBe('');
  });
});

describe('spineToMarkdown — mixed document round-trip', () => {
  it('round-trips a realistic runbook (headings, prose+marks, list of todos, quote, code, divider)', () => {
    const doc: Block[] = [
      heading(1, 'Service log'),
      { id: 'p', type: 'paragraph', content: { segments: [{ text: 'Intro with ' }, { text: 'bold', bold: true }, { text: ' text.' }] } },
      heading(2, 'Phase 1'),
      { id: 'l', type: 'list', content: { ordered: false }, children: [
        { id: 'i', type: 'todo', content: { checked: false, segments: [{ text: 'change oil' }] } },
        { id: 'i', type: 'todo', content: { checked: true, segments: [{ text: 'top up coolant' }] } },
      ] },
      { id: 'q', type: 'quote', content: { segments: [{ text: 'remember to reset the light' }] } },
      { id: 'c', type: 'code', content: { code: 'torque = 120', language: 'txt' } },
      { id: 'd', type: 'divider' },
      para('Closing line.'),
    ];
    roundTrips(doc);
  });
});
