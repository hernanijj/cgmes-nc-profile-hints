// Index of the objects defined in the other files of a dataset (a CGM's EQ, SSH, TP, SV, or NC
// profiles that reference each other), so references can be checked across files. Files are read
// with regular-expression scans of object start tags and resource attributes instead of a full XML
// parse, and the scan yields regularly so a large dataset never blocks the editor.

import * as fs from 'fs';
import { Analysis, isHeaderType, looksLikeCim } from './analysis';
import { attr } from './xml';

/** A file's objects: normalized identifier -> index into types. */
export interface FileObjects {
  file: string;
  types: string[];
  ids: Map<string, number>;
  /** Object start offsets keyed by normalized identifier. */
  objectOffsets: Map<string, number>;
  /** Normalized identifiers referenced by rdf:resource attributes. */
  references: Set<string>;
  /** Identifiers of the file's own header (md:FullModel / dcat:Dataset), normalized. */
  models?: string[];
  /** Models the file depends on (md:Model.DependentOn, dcterms:requires/references), normalized. */
  dependsOn?: string[];
  /** Header profile URIs (md:Model.profile / dcterms:conformsTo). */
  profiles?: string[];
  /** md:Model.scenarioTime or dcat:startDate, as written. */
  time?: string;
}

export interface CrossHit { type: string; file: string }

export interface ReferenceLocation { offset: number; line: number; character: number; length: number }

/** What validate() needs: where an identifier is defined outside the current file. */
export interface DatasetLookup {
  /** Number of other CIM files in the dataset (0: no cross-file checks). */
  fileCount: number;
  lookup(ref: string): CrossHit[] | undefined;
  /** Whether one of the other files is the model with this identifier (its header). */
  hasModel(ref: string): boolean;
  /** How messages name the other files: "its folder" (default) or "the selected dataset". */
  scope?: string;
  /** Models the file depends on, directly or through the files it depends on, found in no file. */
  missingModels?: string[];
}

/**
 * "#_123", "_123", "urn:uuid:123" and "#123" all name the same object across CGMES 2.4.15 (rdf:ID
 * and rdf:about="#_…") and NC (urn:uuid:) files. Returns undefined for other URIs.
 */
export function normalizeRef(v: string): string | undefined {
  let s = v.trim();
  if (s.startsWith('urn:uuid:')) s = s.slice(9);
  else if (s.startsWith('#')) s = s.slice(1);
  else if (/^[a-z][\w+.-]*:/i.test(s)) return undefined;
  if (s.startsWith('_')) s = s.slice(1);
  return s ? s.toLowerCase() : undefined;
}

const HEADER_END = /<\/[A-Za-z_][\w.-]*:(?:FullModel|Dataset)\s*>/;
const HEADER_DEP = /<[A-Za-z_][\w.-]*:(?:Model\.DependentOn|DependentOn|requires|references)\b[^>]*?rdf:resource\s*=\s*["']([^"']+)["']/g;
const HEADER_PROFILE = /<[A-Za-z_][\w.-]*:(?:Model\.profile|conformsTo)\b[^>]*>([^<]+)</g;
const HEADER_TIME = /<[A-Za-z_][\w.-]*:(?:Model\.scenarioTime|startDate)\b[^>]*>([^<]+)</;
const NS_DECL = /xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']*)["']/g;
const OBJECT_TAG = /<([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)\s[^>]*?\brdf:(ID|about)\s*=\s*["']([^"']*)["']/g;
const RESOURCE_ATTR = /\brdf:resource\s*=\s*(["'])([^"']*)\1/g;

/** Yields to the event loop when a slice of work has taken longer than this. */
const SLICE_MS = 25;
const tick = () => new Promise<void>(r => setImmediate(r));

/**
 * Reads the object start tags of a CIM/XML text given in pieces (a file read in chunks, so a
 * large file is never held or decoded at once): object identifiers, classes and referenced ids.
 */
export class ObjectScanner {
  private carry = '';
  private ns?: Map<string, string>;
  private notCim = false;
  private readonly types: string[] = [];
  private readonly typeIdx = new Map<string, number>();
  private readonly ids = new Map<string, number>();
  private readonly objectOffsets = new Map<string, number>();
  private readonly references = new Set<string>();
  private readonly models: string[] = [];
  private readonly referenceHits: ReferenceLocation[] = [];
  private inputLength = 0;
  private line = 0;
  private character = 0;
  /** Text after the root start tag until the header is complete (then undefined). */
  private head?: string = '';
  private readonly header: Pick<FileObjects, 'dependsOn' | 'profiles' | 'time'> = {};

  constructor(private readonly file: string, private readonly referenceTarget?: string) {}

  get referenceLocations(): ReferenceLocation[] { return this.referenceHits; }

  /** False once the text turned out not to be CIM/XML (no rdf:RDF root near the start). */
  get ok(): boolean { return !this.notCim; }

  push(chunk: string): void {
    if (this.notCim) return;
    let text = this.carry + chunk;
    let textOffset = this.inputLength - this.carry.length;
    this.inputLength += chunk.length;
    let fresh = chunk; // text not seen before (the carry was already given to readHeader)
    if (!this.ns) {
      const rootAt = text.indexOf('<rdf:RDF');
      const rootEnd = rootAt < 0 ? -1 : text.indexOf('>', rootAt);
      if (rootEnd < 0) {
        if (text.length > 20000) { this.notCim = true; this.carry = ''; } else this.carry = text;
        return;
      }
      if (!looksLikeCim(text.slice(rootAt, Math.min(text.length, rootAt + 20000)))) {
        this.notCim = true;
        this.carry = '';
        return;
      }
      this.ns = new Map();
      for (const m of text.slice(rootAt, rootEnd).matchAll(NS_DECL)) this.ns.set(m[1], m[2]);
      this.scanReferences(text.slice(0, rootEnd + 1), textOffset);
      text = text.slice(rootEnd + 1);
      textOffset += rootEnd + 1;
      fresh = text;
    }
    if (this.head !== undefined) this.readHeader(fresh);
    // Every complete start tag lies before the last '<' (attribute values cannot contain '<').
    const cut = text.lastIndexOf('<');
    if (cut < 0) {
      this.scanReferences(text, textOffset);
      this.carry = '';
      return;
    }
    this.carry = text.slice(cut);
    const complete = text.slice(0, cut);
    this.scanReferences(complete, textOffset);
    this.scan(complete, textOffset);
  }

  end(): FileObjects | undefined {
    if (this.carry && this.ns) {
      const offset = this.inputLength - this.carry.length;
      this.scanReferences(this.carry + ' ', offset);
      this.scan(this.carry + ' ', offset);
    }
    if (this.head !== undefined && this.ns) this.readHeader('', true);
    this.carry = '';
    return this.ns ? {
      file: this.file, types: this.types, ids: this.ids, objectOffsets: this.objectOffsets,
      references: this.references, models: this.models, ...this.header,
    } : undefined;
  }

  /** Header facts, read once the header element is complete (or 64 KB in, whichever comes first). */
  private readHeader(text: string, last = false): void {
    const head = this.head! + text;
    const end = HEADER_END.exec(head);
    if (!end && !last && head.length < 65536) { this.head = head; return; }
    const h = end ? head.slice(0, end.index) : head.slice(0, 65536);
    this.head = undefined;
    const own = (v: string) => Buffer.from(v, 'utf8').toString('utf8');
    this.header.dependsOn = [...h.matchAll(HEADER_DEP)].map(m => normalizeRef(m[1])).filter((v): v is string => !!v).map(own);
    this.header.profiles = [...h.matchAll(HEADER_PROFILE)].map(m => own(m[1].trim()));
    const t = HEADER_TIME.exec(h);
    if (t) this.header.time = own(t[1].trim());
  }

  private scanReferences(text: string, offset: number): void {
    const re = new RegExp(RESOURCE_ATTR.source, 'g');
    let cursor = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const valueStart = m.index + m[0].indexOf(m[1]) + 1;
      const ref = normalizeRef(m[2]);
      if (ref) {
        if (this.referenceTarget === undefined) this.references.add(ref);
        else if (ref === this.referenceTarget) {
          this.advancePosition(text.slice(cursor, valueStart));
          this.referenceHits.push({ offset: offset + valueStart, line: this.line, character: this.character, length: m[2].length });
          this.advancePosition(text.slice(valueStart, m.index + m[0].length));
          cursor = m.index + m[0].length;
          continue;
        }
      }
      if (this.referenceTarget !== undefined) {
        this.advancePosition(text.slice(cursor, m.index + m[0].length));
        cursor = m.index + m[0].length;
      }
    }
    if (this.referenceTarget !== undefined) this.advancePosition(text.slice(cursor));
  }

  private advancePosition(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 13) {
        this.line++;
        this.character = 0;
        if (text.charCodeAt(i + 1) === 10) i++;
      } else if (c === 10) { this.line++; this.character = 0; }
      else this.character++;
    }
  }

  private scan(text: string, offset: number): void {
    if (this.referenceTarget !== undefined) return;
    const ns = this.ns!;
    const re = new RegExp(OBJECT_TAG.source, 'g');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const [, prefix, local, , value] = m;
      if (prefix === 'rdf') continue;
      const type = (ns.get(prefix) ?? prefix + ':') + local;
      const ref = normalizeRef(value);
      if (!ref) continue;
      // A copy: a substring would keep the whole 1 MB piece of the file it came from in memory.
      const key = Buffer.from(ref, 'utf8').toString('utf8');
      if (isHeaderType(type)) { this.models.push(key); continue; }
      if (!this.objectOffsets.has(key)) this.objectOffsets.set(key, offset + m.index);
      let t = this.typeIdx.get(type);
      if (t === undefined) { t = this.types.length; this.types.push(type); this.typeIdx.set(type, t); }
      if (!this.ids.has(key)) this.ids.set(key, t);
    }
  }
}

/** scanObjects over a text already in memory, in slices that yield to the event loop. */
export async function scanObjects(text: string, file: string, shouldStop: () => boolean = () => false): Promise<FileObjects | undefined> {
  const s = new ObjectScanner(file);
  const CHUNK = 1 << 20;
  let started = Date.now();
  for (let i = 0; i < text.length && s.ok; i += CHUNK) {
    s.push(text.slice(i, i + CHUNK));
    if (Date.now() - started > SLICE_MS) {
      await tick();
      if (shouldStop()) return undefined;
      started = Date.now();
    }
  }
  return s.end();
}

/** Finds one reference in a file without parsing or retaining its XML tree. */
export async function scanReferenceLocations(file: string, ref: string, shouldStop: () => boolean = () => false): Promise<ReferenceLocation[]> {
  const target = normalizeRef(ref);
  if (!target) return [];
  const scanner = new ObjectScanner(file, target);
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  try {
    for await (const chunk of stream) {
      scanner.push(chunk as string);
      if (!scanner.ok || shouldStop()) return [];
      await tick();
    }
  } finally {
    stream.destroy();
  }
  scanner.end();
  return scanner.referenceLocations;
}

/** The same information taken from an analysis of a file open in the editor (always current). */
export function objectsFromAnalysis(a: Analysis, file: string): FileObjects {
  const types: string[] = [];
  const typeIdx = new Map<string, number>();
  const ids = new Map<string, number>();
  const objectOffsets = new Map<string, number>();
  const references = new Set<string>();
  for (const o of a.objects) {
    if (!o.type) continue;
    const key = normalizeRef(o.id ?? o.about ?? '');
    if (!key) continue;
    let t = typeIdx.get(o.type);
    if (t === undefined) { t = types.length; types.push(o.type); typeIdx.set(o.type, t); }
    if (!ids.has(key)) ids.set(key, t);
    if (!objectOffsets.has(key)) objectOffsets.set(key, o.el.start);
    for (const c of o.el.children) {
      const value = attr(c, 'rdf:resource')?.value;
      const ref = value && normalizeRef(value);
      if (ref) references.add(ref);
    }
  }
  const header = a.header && normalizeRef((attr(a.header, 'rdf:about') ?? attr(a.header, 'rdf:ID'))?.value ?? '');
  return { file, types, ids, objectOffsets, references, models: header ? [header] : [], dependsOn: normalizedDeps(a.dependsOn), profiles: a.headerProfiles };
}

export function normalizedDeps(deps: readonly string[]): string[] {
  return deps.map(normalizeRef).filter((v): v is string => !!v);
}

/**
 * The files a file needs, following md:Model.DependentOn from model to model (SV -> TP, SSH -> EQ
 * -> boundary). Models found in no file are returned in missing.
 */
export function dependencyClosure(deps: readonly string[], files: Iterable<FileObjects>): { files: FileObjects[]; missing: string[] } {
  const byModel = new Map<string, FileObjects>();
  for (const f of files) for (const m of f.models ?? []) if (!byModel.has(m)) byModel.set(m, f);
  const found: FileObjects[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue = [...deps];
  while (queue.length) {
    const m = queue.shift()!;
    if (seen.has(m)) continue;
    seen.add(m);
    const f = byModel.get(m);
    if (!f) { missing.push(m); continue; }
    if (!found.includes(f)) { found.push(f); queue.push(...(f.dependsOn ?? [])); }
  }
  return { files: found, missing };
}

/**
 * Lookup over a set of files, leaving out the file being validated. When preferred files are given
 * (the models the file depends on), an identifier found there is only taken from them, so another
 * version of the same object elsewhere in the folder (another hour's SSH, an older EQ) is ignored.
 */
export function datasetLookup(files: Iterable<FileObjects>, exclude?: string, preferred?: ReadonlySet<string>, scope?: string, missingModels?: string[]): DatasetLookup {
  const list = [...files].filter(f => f.file !== exclude);
  let models: Set<string> | undefined;
  return {
    fileCount: list.length,
    scope,
    missingModels,
    hasModel(ref: string) {
      models ??= new Set(list.flatMap(f => f.models ?? []));
      const key = normalizeRef(ref);
      return !!key && models.has(key);
    },
    lookup(ref: string) {
      const key = normalizeRef(ref);
      if (!key) return undefined;
      let hits: CrossHit[] | undefined;
      for (const f of list) {
        const t = f.ids.get(key);
        if (t !== undefined) (hits ??= []).push({ type: f.types[t], file: f.file });
      }
      if (hits && preferred?.size && hits.length > 1) {
        const mine = hits.filter(h => preferred.has(h.file));
        if (mine.length) return mine;
      }
      return hits;
    },
  };
}
