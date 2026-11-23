// mend: one patch tool for every AI edit format, as SPEC.md specifies.
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// the V4A patch format, text-editor tool calls as JSON), finds the lines each
// edit names at the first of three matching tiers, and writes every change or
// none. Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface Doc {
  lines: string[];
  br: string;
  fin: boolean;
}
function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}
function renderDoc(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Current path -> the path it came from before the patch (for R lines); absent when created in the patch. */
  private src = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  sourceOf(p: string): string | undefined {
    return this.src.get(p);
  }
  create(p: string, text: string): void {
    this.now.set(p, text);
    this.src.delete(p);
  }
  modify(p: string, text: string): void {
    this.now.set(p, text);
  }
  remove(p: string): void {
    this.now.set(p, null);
    this.src.delete(p);
  }
  move(oldP: string, newP: string, text: string): void {
    const s = this.src.get(oldP) ?? (this.original(oldP) !== null ? oldP : undefined);
    this.now.set(oldP, null);
    this.now.set(newP, text);
    this.src.delete(oldP);
    if (s !== undefined) this.src.set(newP, s);
    else this.src.delete(newP);
  }
  snapshot(): { now: Map<string, string | null>; src: Map<string, string> } {
    return { now: new Map(this.now), src: new Map(this.src) };
  }
  restore(s: { now: Map<string, string | null>; src: Map<string, string> }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.src.clear();
    for (const [k, v] of s.src) this.src.set(k, v);
  }
}

type Edit = (tree: Tree) => void;

/** Format detection (SPEC.md section 4): the first of these that holds, else null. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 5: matching lines at three tiers ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function norm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrail(s);
  return stripBoth(s);
}
function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
/** Positions where O's lines match the file's lines at one tier; occurrences may overlap. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  const on = o.map((l) => norm(l, tier));
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(file[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier at which O occurs at least once (tier 0 only with --strict), else null. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(file, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: `text`, and for a context line the index of its line in O (`ctx` >= 0), else -1. */
interface NLine {
  text: string;
  ctx: number;
}
/** A non-context line of N at tier 2 is re-indented from O's first line's indent to the file's. */
function reindent(line: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}
/** Replace O at `pos` by N; a context line is written as the file's own matched line. */
function applyReplace(file: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const f = leading(file[pos] ?? '');
  const p = leading(o[0] ?? '');
  const rep: string[] = n.map((nl) => (nl.ctx >= 0 ? file[pos + nl.ctx]! : reindent(nl.text, tier, f, p)));
  return [...file.slice(0, pos), ...rep, ...file.slice(pos + o.length)];
}

// ---- Section 9: JSON edits ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.create(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.modify(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const out = [...doc.lines.slice(0, line), ...add, ...doc.lines.slice(line)];
      tree.modify(p, renderDoc(out, doc.br, doc.fin));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ----

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
  raw: string;
}
interface Hunk {
  /** The hunk's old start line, as written (1-based). */
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreak: boolean;
  /** A `\` line follows the hunk's last `+` line (for creations). */
  plusBack: boolean;
}
/** Split a hunk/chunk body into its old lines O and its new lines N. */
function buildON(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      n.push({ text: b.text, ctx: o.length });
      o.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}
function hunkNoBreak(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === 'back';
}
function hunkPlusBack(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'new') last = i;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === 'back';
}

interface RawSection {
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newMode: boolean;
  delMode: boolean;
  hunks: Hunk[];
  seenHunk: boolean;
}
/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}
function isDiffGit(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  const startSection = (): void => {
    if (cur) sections.push(cur);
    cur = { pairOld: null, pairNew: null, renOld: null, renNew: null, gitOld: null, gitNew: null, newMode: false, delMode: false, hunks: [], seenHunk: false };
  };
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (isDiffGit(line)) {
      const m = /^diff --git a\/(\S+) b\/(.+)$/.exec(line.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection();
      cur!.gitOld = m[1]!;
      cur!.gitNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur && !cur.seenHunk && cur.pairOld === null) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(next);
          i += 2;
          continue;
        }
        if (cur && !cur.seenHunk) {
          i += 2;
          continue;
        }
        startSection();
        cur!.pairOld = headerPath(line);
        cur!.pairNew = headerPath(next);
        i += 2;
        continue;
      }
      if (cur && !cur.seenHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(hm[1]!, 10);
      i++;
      const body: BodyLine[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (isDiffGit(bl)) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '', raw: '' });
          i++;
          continue;
        }
        if (bl[0] === ' ') {
          body.push({ kind: 'ctx', text: bl.slice(1), raw: bl });
          i++;
          continue;
        }
        if (bl[0] === '-') {
          body.push({ kind: 'old', text: bl.slice(1), raw: bl });
          i++;
          continue;
        }
        if (bl[0] === '+') {
          body.push({ kind: 'new', text: bl.slice(1), raw: bl });
          i++;
          continue;
        }
        if (bl[0] === '\\') {
          body.push({ kind: 'back', text: bl, raw: bl });
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.raw === '') body.pop();
      const { o, n: nn } = buildON(body);
      cur.hunks.push({ a, o, n: nn, noBreak: hunkNoBreak(body), plusBack: hunkPlusBack(body) });
      cur.seenHunk = true;
      continue;
    }
    if (cur && !cur.seenHunk) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newMode = true;
      else if (line.startsWith('deleted file mode')) cur.delMode = true;
    }
    i++;
  }
  if (cur) sections.push(cur);
  return sections.map((s) => sectionEdit(s, strict));
}

/** Apply a section's hunks in order to a file's lines; `d` tracks the drift from hunks applied so far. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let lines = [...doc.lines];
  let fin = doc.fin;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const ins = Math.min(h.a + d, lines.length);
      const rep = h.n.map((x) => x.text);
      const atEnd = ins === lines.length;
      lines = [...lines.slice(0, ins), ...rep, ...lines.slice(ins)];
      if (atEnd) fin = !h.noBreak;
      d += h.n.length;
      continue;
    }
    const found = findTier(lines, h.o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const atEnd = pos + h.o.length === lines.length;
    lines = applyReplace(lines, pos, h.o, h.n, found.tier);
    if (atEnd) fin = !h.noBreak;
    d += h.n.length - h.o.length;
  }
  return { lines, br: doc.br, fin };
}

function sectionEdit(s: RawSection, strict: boolean): Edit {
  let oldP: string | null = s.pairOld ?? s.renOld ?? s.gitOld;
  let newP: string | null = s.pairNew ?? s.renNew ?? s.gitNew;
  if (oldP === '/dev/null') oldP = null;
  if (newP === '/dev/null') newP = null;
  const create = oldP === null || s.newMode;
  const remove = !create && (newP === null || s.delMode);
  const move = !create && !remove && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (create) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusBack = false;
      let anyPlus = false;
      for (const h of s.hunks) {
        for (const x of h.n) if (x.ctx < 0) plus.push(x.text);
        if (h.n.some((x) => x.ctx < 0)) {
          anyPlus = true;
          lastPlusBack = h.plusBack;
        }
      }
      const text = !anyPlus ? '' : plus.join('\n') + (lastPlusBack ? '' : '\n');
      tree.create(np, text);
      return;
    }
    if (remove) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.remove(op);
      return;
    }
    const op = oldP!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (move) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(parseDoc(before), s.hunks, strict, op);
      tree.move(op, np, renderDoc(out.lines, out.br, out.fin));
      return;
    }
    const out = applyHunks(parseDoc(before), s.hunks, strict, op);
    tree.modify(op, renderDoc(out.lines, out.br, out.fin));
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.create(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const doc = parseDoc(text);
    const found = findTier(doc.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const out = applyReplace(doc.lines, pos, oldLines, n, found.tier);
    tree.modify(path, renderDoc(out, doc.br, doc.fin));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let sep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${s + 1}`);
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${s + 1}`);
    }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  /** The anchor line, or null when the chunk has none. */
  anchor: string | null;
  /** True when a `*** End of File` line ends this chunk. */
  eof: boolean;
  /** The chunk's body lines, in order. */
  body: BodyLine[];
}
function isV4ASectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}
/** The first line at or after `from` equal to the anchor at the first tier with one, else -1. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (norm(lines[i]!, t) === norm(anchor, t)) return i;
    }
  }
  return -1;
}
/** The first occurrence of O at or after `from`, at the first tier with one (an end-of-file chunk only takes one ending at the last line), else null. */
function findFrom(lines: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (const p of occurrences(lines, o, t)) {
      if (p < from) continue;
      if (eof && p + o.length !== lines.length) continue;
      return { tier: t, pos: p };
    }
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: { anchor: string | null; eof: boolean; o: string[]; n: NLine[] }[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(text);
    let lines = [...doc.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const ins = ch.eof ? lines.length : cursor;
        const rep = ch.n.map((x) => x.text);
        lines = [...lines.slice(0, ins), ...rep, ...lines.slice(ins)];
        cursor = ins + rep.length;
        continue;
      }
      const found = findFrom(lines, ch.o, cursor, strict, ch.eof);
      if (!found) throw new Fail('no-match', path);
      lines = applyReplace(lines, found.pos, ch.o, ch.n, found.tier);
      cursor = found.pos + ch.n.length;
    }
    const out = renderDoc(lines, doc.br, doc.fin);
    if (moveTo !== null) tree.move(path, moveTo, out);
    else tree.modify(path, out);
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const sec: string[] = [];
      let j = i + 1;
      while (j < last && !isV4ASectionStart(lines[j]!)) {
        sec.push(lines[j]!);
        j++;
      }
      while (sec.length > 0 && sec[sec.length - 1]!.trim() === '') sec.pop();
      for (let k = 0; k < sec.length; k++) {
        const sl = sec[k]!;
        if (!(sl.startsWith('+') || sl === '')) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(((p, ls) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const content = ls.map((x) => (x === '' ? '' : x.slice(1)));
        tree.create(p, content.length === 0 ? '' : content.join('\n') + '\n');
      })(path, sec));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const sec: string[] = [];
      let j = i + 1;
      while (j < last && !isV4ASectionStart(lines[j]!)) {
        sec.push(lines[j]!);
        j++;
      }
      while (sec.length > 0 && sec[sec.length - 1]!.trim() === '') sec.pop();
      if (sec.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push(((p) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.remove(p);
      })(path));
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j++;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: BodyLine[] } | null = null;
      const closeChunk = (): void => {
        if (cur) {
          chunks.push({ anchor: cur.anchor, eof: cur.eof, body: cur.body });
          cur = null;
        }
      };
      while (j < last) {
        const l = lines[j]!;
        if (isV4ASectionStart(l)) break;
        if (l === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          closeChunk();
          j++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          j++;
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${j + 1}`);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (!cur) cur = { anchor: null, eof: false, body: [] };
          if (l === '') cur.body.push({ kind: 'ctx', text: '', raw: '' });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), raw: l });
          else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1), raw: l });
          else cur.body.push({ kind: 'new', text: l.slice(1), raw: l });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      closeChunk();
      // Blank lines at the end of the section are not part of it: drop trailing blank
      // patch lines (empty context lines) from the last chunk's body.
      if (chunks.length > 0) {
        const lastBody = chunks[chunks.length - 1]!.body;
        while (lastBody.length > 0 && lastBody[lastBody.length - 1]!.kind === 'ctx' && lastBody[lastBody.length - 1]!.raw.trim() === '') lastBody.pop();
      }
      const built: { anchor: string | null; eof: boolean; o: string[]; n: NLine[] }[] = chunks.map((c) => {
        const { o, n: nn } = buildON(c.body);
        return { anchor: c.anchor, eof: c.eof, o, n: nn };
      });
      if (built.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, built, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---- Sections 1, 2 and 10: invocation, output and atomicity ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  // A move's R line replaces that pair's D and A lines: collect the moves first,
  // and remember each move's old path so it gets no D line of its own, and each
  // move's new path so it gets no A line of its own.
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || now === null || was !== null) continue;
    const srcP = tree.sourceOf(p);
    if (srcP !== undefined && tree.original(srcP) !== null && tree.get(srcP) === null) {
      rows.push({ key: p, line: `R ${srcP} -> ${p}` });
      movedFrom.add(srcP);
      movedTo.add(p);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
