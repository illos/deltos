import { describe, it, expect } from 'vitest';
import { markdownToBody, BlockIdSchema, type Block } from '../src/index.js';

/**
 * markdownToBody is the INVERSE of the client's copy serializer (client/src/editor/clipboard.ts
 * nodeToText) plus the editor's inline input-rule marks (client/src/editor/inputRules.ts). An agent
 * authoring a note over MCP writes markdown; this turns it into native spine blocks so `[ ] task`,
 * `# heading`, `**bold**`, `> quote`, ```` ``` ````, `---` render as real blocks rather than dead text.
 *
 * The bar: round-trip nodeToText's output losslessly (block STRUCTURE + inline marks), and — because it
 * is a superset of the old plain-text path — plain prose with no markdown still yields paragraph blocks
 * (no regression). Block ids MUST be server-minted UUIDs (a non-UUID id 400s the whole sync push batch).
 */

// A block whose content we can poke at in tests without `any` noise.
type AnyBlock = Block & { content?: any };
const bodyOf = (md: string): AnyBlock[] => markdownToBody(md) as AnyBlock[];
const segTexts = (b: AnyBlock): string[] => (b.content?.segments ?? []).map((s: any) => s.text);

describe('markdownToBody — headings', () => {
  it('parses every heading level 1..6 with the right level + segments', () => {
    for (let lvl = 1; lvl <= 6; lvl++) {
      const [b] = bodyOf('#'.repeat(lvl) + ' Title ' + lvl);
      expect(b.type).toBe('heading');
      expect(b.content.level).toBe(lvl);
      expect(segTexts(b)).toEqual([`Title ${lvl}`]);
    }
  });

  it('does NOT treat 7+ hashes as a heading (falls through to paragraph)', () => {
    const [b] = bodyOf('####### too deep');
    expect(b.type).toBe('paragraph');
  });

  it('does NOT treat a bare # with no space as a heading', () => {
    const [b] = bodyOf('#nospace');
    expect(b.type).toBe('paragraph');
  });
});

describe('markdownToBody — todos', () => {
  it('parses an unchecked top-level todo', () => {
    const [b] = bodyOf('[ ] buy milk');
    expect(b.type).toBe('todo');
    expect(b.content.checked).toBe(false);
    expect(segTexts(b)).toEqual(['buy milk']);
  });

  it('parses a checked top-level todo', () => {
    const [b] = bodyOf('[x] done thing');
    expect(b.type).toBe('todo');
    expect(b.content.checked).toBe(true);
    expect(segTexts(b)).toEqual(['done thing']);
  });
});

describe('markdownToBody — lists', () => {
  it('parses a bullet list into a list block whose children are paragraph items', () => {
    const [list] = bodyOf('- apple\n- pear');
    expect(list.type).toBe('list');
    expect(list.content.ordered).toBe(false);
    expect(list.children?.map((c) => c.type)).toEqual(['paragraph', 'paragraph']);
    expect(list.children?.map((c) => (c as AnyBlock).content.segments[0].text)).toEqual(['apple', 'pear']);
  });

  it('parses a * bullet list too', () => {
    const [list] = bodyOf('* one\n* two');
    expect(list.type).toBe('list');
    expect(list.content.ordered).toBe(false);
    expect(list.children).toHaveLength(2);
  });

  it('parses an ordered list', () => {
    const [list] = bodyOf('1. first\n2. second\n3. third');
    expect(list.type).toBe('list');
    expect(list.content.ordered).toBe(true);
    expect(list.children).toHaveLength(3);
    expect((list.children![2] as AnyBlock).content.segments[0].text).toBe('third');
  });

  it('parses a todo INSIDE a bullet list as a todo item child', () => {
    const [list] = bodyOf('- [ ] wash car\n- [x] fill tank');
    expect(list.type).toBe('list');
    const [c0, c1] = list.children as AnyBlock[];
    expect(c0.type).toBe('todo');
    expect(c0.content.checked).toBe(false);
    expect(c0.content.segments[0].text).toBe('wash car');
    expect(c1.type).toBe('todo');
    expect(c1.content.checked).toBe(true);
  });

  it('nests a 2-space-indented sublist under its parent item (mirrors nodeToText output)', () => {
    const [list] = bodyOf('- parent\n  - child a\n  - child b');
    expect(list.type).toBe('list');
    expect(list.children).toHaveLength(1);
    const parent = list.children![0] as AnyBlock;
    expect(parent.type).toBe('paragraph');
    expect(parent.content.segments[0].text).toBe('parent');
    expect(parent.children).toHaveLength(1);
    const sub = parent.children![0] as AnyBlock;
    expect(sub.type).toBe('list');
    expect(sub.children!.map((c) => (c as AnyBlock).content.segments[0].text)).toEqual(['child a', 'child b']);
  });
});

describe('markdownToBody — blockquote', () => {
  it('parses a single-line blockquote into a quote block', () => {
    const [b] = bodyOf('> to be or not to be');
    expect(b.type).toBe('quote');
    expect(b.content.segments[0].text).toBe('to be or not to be');
  });

  it('collapses consecutive > lines into one quote block (extra lines as children)', () => {
    const [b] = bodyOf('> line one\n> line two');
    expect(b.type).toBe('quote');
    expect(b.content.segments[0].text).toBe('line one');
    expect(b.children).toHaveLength(1);
    expect((b.children![0] as AnyBlock).content.segments[0].text).toBe('line two');
  });
});

describe('markdownToBody — fenced code', () => {
  it('parses a fenced block with no language (no language key, raw code preserved)', () => {
    const [b] = bodyOf('```\nlet x = 1\nlet y = 2\n```');
    expect(b.type).toBe('code');
    expect(b.content.code).toBe('let x = 1\nlet y = 2');
    expect('language' in b.content).toBe(false);
  });

  it('parses a fenced block WITH a language', () => {
    const [b] = bodyOf('```ts\nconst a: number = 3\n```');
    expect(b.type).toBe('code');
    expect(b.content.language).toBe('ts');
    expect(b.content.code).toBe('const a: number = 3');
  });

  it('does NOT interpret markdown INSIDE a fenced block (raw text)', () => {
    const [b] = bodyOf('```\n# not a heading\n- not a list\n**not bold**\n```');
    expect(b.type).toBe('code');
    expect(b.content.code).toBe('# not a heading\n- not a list\n**not bold**');
  });
});

describe('markdownToBody — divider', () => {
  it('parses --- as a divider block with no content', () => {
    const body = bodyOf('above\n\n---\n\nbelow');
    const divider = body.find((b) => b.type === 'divider');
    expect(divider).toBeDefined();
    expect(divider!.content).toBeUndefined();
    expect(body.map((b) => b.type)).toEqual(['paragraph', 'divider', 'paragraph']);
  });
});

describe('markdownToBody — inline marks', () => {
  const seg = (md: string) => (bodyOf(md)[0] as AnyBlock).content.segments;

  it('**bold**', () => {
    expect(seg('**strong**')).toEqual([{ text: 'strong', bold: true }]);
  });
  it('*italic*', () => {
    expect(seg('*slanted*')).toEqual([{ text: 'slanted', italic: true }]);
  });
  it('~~strike~~', () => {
    expect(seg('~~gone~~')).toEqual([{ text: 'gone', strike: true }]);
  });
  it('==highlight==', () => {
    expect(seg('==note==')).toEqual([{ text: 'note', highlight: true }]);
  });
  it('`code`', () => {
    expect(seg('`fn()`')).toEqual([{ text: 'fn()', code: true }]);
  });
  it('<u>underline</u> (round-trips nodeToText underline emission)', () => {
    expect(seg('<u>under</u>')).toEqual([{ text: 'under', underline: true }]);
  });

  it('mixes marks with surrounding plain text', () => {
    expect(seg('a **b** c')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' c' },
    ]);
  });

  it('does not over-transform casual prose with single asterisks around spaces', () => {
    expect(seg('2 * 3 * 4 equals 24')).toEqual([{ text: '2 * 3 * 4 equals 24' }]);
  });
});

describe('markdownToBody — links', () => {
  it('parses a [text](url) link', () => {
    const [b] = bodyOf('see [Anthropic](https://anthropic.com) here');
    expect((b as AnyBlock).content.segments).toEqual([
      { text: 'see ' },
      { text: 'Anthropic', link: 'https://anthropic.com' },
      { text: ' here' },
    ]);
  });

  it('parses a bare https url into a link segment', () => {
    const [b] = bodyOf('visit https://example.com now');
    expect((b as AnyBlock).content.segments).toEqual([
      { text: 'visit ' },
      { text: 'https://example.com', link: 'https://example.com' },
      { text: ' now' },
    ]);
  });
});

describe('markdownToBody — plain text (no-markdown regression)', () => {
  it('turns each non-blank line into its own paragraph (matches the old textToBody line model)', () => {
    const body = bodyOf('line one\nline two');
    expect(body.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(body.map((b) => segTexts(b as AnyBlock)[0])).toEqual(['line one', 'line two']);
  });

  it('treats a blank line as a paragraph separator (no empty ghost blocks)', () => {
    const body = bodyOf('para one\n\npara two');
    expect(body.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(body.map((b) => segTexts(b as AnyBlock)[0])).toEqual(['para one', 'para two']);
  });

  it('a single plain string is one paragraph', () => {
    const body = bodyOf('just a note');
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe('paragraph');
    expect(segTexts(body[0] as AnyBlock)).toEqual(['just a note']);
  });
});

describe('markdownToBody — block ids are server-minted UUIDs', () => {
  it('every block id (recursively) is a valid spine BlockId UUID', () => {
    const body = bodyOf('# H\n- a\n  - b\n> q\n[ ] t\n```\ncode\n```\n---\npara');
    const walk = (blocks: Block[]) => {
      for (const b of blocks) {
        expect(BlockIdSchema.safeParse(b.id).success).toBe(true);
        if (b.children) walk(b.children);
      }
    };
    walk(body);
  });

  it('ids are unique across the tree', () => {
    const body = bodyOf('- a\n- b\n- c');
    const ids: string[] = [];
    const walk = (blocks: Block[]) => blocks.forEach((b) => { ids.push(b.id); if (b.children) walk(b.children); });
    walk(body);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('markdownToBody — mixed document', () => {
  it('parses a document mixing headings, lists, quote, code, divider, and prose in order', () => {
    const md = [
      '# Title',
      '',
      'Intro paragraph with **bold**.',
      '',
      '## Section',
      '- item one',
      '- item two',
      '',
      '> a quote',
      '',
      '```js',
      'x()',
      '```',
      '',
      '---',
      '',
      'Closing line.',
    ].join('\n');
    const body = bodyOf(md);
    expect(body.map((b) => b.type)).toEqual([
      'heading', 'paragraph', 'heading', 'list', 'quote', 'code', 'divider', 'paragraph',
    ]);
    expect((body[0] as AnyBlock).content.level).toBe(1);
    expect((body[2] as AnyBlock).content.level).toBe(2);
    expect((body[3] as AnyBlock).children).toHaveLength(2);
    expect((body[5] as AnyBlock).content.language).toBe('js');
  });
});

describe('markdownToBody — realistic checklist runbook (the real agent use case)', () => {
  it('parses a car-maintenance runbook: ## phase headings + [ ] todos come out as headings + todos', () => {
    const md = [
      '# 2005 Jetta service',
      '',
      '## Phase 1: fluids',
      '- [ ] change oil',
      '- [x] top up coolant',
      '',
      '## Phase 2: brakes',
      '- [ ] inspect pads',
      '- [ ] bleed lines',
    ].join('\n');
    const body = bodyOf(md);
    const headings = body.filter((b) => b.type === 'heading');
    expect(headings.map((h) => (h as AnyBlock).content.level)).toEqual([1, 2, 2]);
    // Each phase's checklist is a list whose children are todo items.
    const lists = body.filter((b) => b.type === 'list') as AnyBlock[];
    expect(lists).toHaveLength(2);
    const allTodos = lists.flatMap((l) => l.children as AnyBlock[]);
    expect(allTodos.every((t) => t.type === 'todo')).toBe(true);
    expect(allTodos.map((t) => t.content.checked)).toEqual([false, true, false, false]);
    expect(allTodos.map((t) => t.content.segments[0].text)).toEqual([
      'change oil', 'top up coolant', 'inspect pads', 'bleed lines',
    ]);
  });
});
