// Extracts the parts of SHACL shapes (Turtle) that the editor can check cheaply:
// cardinality, datatype, sh:in, sh:class and simple value ranges per property path,
// together with their messages. Everything else (SPARQL constraints) is kept as a
// note on the target class so hovers can mention it.

import { Parser, Quad } from 'n3';
import { NS, ProfileData, RuleNote, ShaclInfo } from './model';

const RDF_FIRST = NS.rdf + 'first';
const RDF_REST = NS.rdf + 'rest';
const RDF_NIL = NS.rdf + 'nil';
const SH = NS.sh;

interface Node { props: Map<string, string[]> }

export interface ShaclExtract {
  byPath: Record<string, ShaclInfo>;
  notesByClass: Record<string, RuleNote[]>;
}

export function parseShacl(text: string, extract: ShaclExtract = { byPath: {}, notesByClass: {} }): ShaclExtract {
  let quads: Quad[];
  try {
    quads = new Parser().parse(text);
  } catch {
    return extract;
  }
  const nodes = new Map<string, Node>();
  const key = (t: Quad['object']) => (t.termType === 'Literal' ? '"' + t.value : t.termType === 'BlankNode' ? '_:' + t.value : t.value);
  for (const q of quads) {
    const s = key(q.subject as Quad['object']);
    let node = nodes.get(s);
    if (!node) { node = { props: new Map() }; nodes.set(s, node); }
    const p = q.predicate.value;
    const list = node.props.get(p) ?? [];
    list.push(key(q.object));
    node.props.set(p, list);
  }
  const get = (s: string, p: string) => nodes.get(s)?.props.get(p) ?? [];
  const one = (s: string, p: string) => get(s, p)[0];
  const val = (v: string | undefined) => (v === undefined ? undefined : v.startsWith('"') ? v.slice(1) : v);
  const num = (v: string | undefined) => {
    const s = val(v);
    if (s === undefined) return undefined;
    const n = Number(s);
    return isNaN(n) ? undefined : n;
  };
  const list = (head: string | undefined): string[] => {
    const out: string[] = [];
    for (let h = head, guard = 0; h && h !== RDF_NIL && guard < 10000; h = one(h, RDF_REST), guard++) {
      const f = one(h, RDF_FIRST);
      if (f !== undefined) out.push(val(f)!);
    }
    return out;
  };

  // Which NodeShape targets which class, to attach SPARQL notes.
  const targetsOf = new Map<string, string[]>();
  for (const [s] of nodes) {
    const t = get(s, SH + 'targetClass').map(v => val(v)!);
    if (t.length) targetsOf.set(s, t);
  }
  const shapeTargets = (shape: string): string[] => {
    const direct = targetsOf.get(shape);
    if (direct) return direct;
    const out: string[] = [];
    for (const [ns, ts] of targetsOf) if (get(ns, SH + 'property').includes(shape) || get(ns, SH + 'sparql').includes(shape)) out.push(...ts);
    return out;
  };

  for (const [s] of nodes) {
    const msg = val(one(s, SH + 'message'));
    const sparql = get(s, SH + 'sparql');
    if (sparql.length || get(s, NS.rdf + 'type').includes(SH + 'SPARQLConstraint')) {
      const note: RuleNote = {
        name: val(one(s, SH + 'name')) ?? s.replace(/^.*[#/]/, ''),
        description: val(one(s, SH + 'description')),
        message: msg ?? val(one(sparql[0] ?? '', SH + 'message')),
        severity: val(one(s, SH + 'severity'))?.replace(SH, ''),
      };
      for (const c of shapeTargets(s)) {
        const arr = (extract.notesByClass[c] ??= []);
        if (!arr.some(n => n.name === note.name)) arr.push(note);
      }
      continue;
    }
    const path = one(s, SH + 'path');
    if (path?.startsWith('_:')) {
      // sh:path ( property rdf:type ) with sh:in: the classes the property may point to (value type list).
      const steps = list(path);
      const inHead = one(s, SH + 'in');
      if (steps.length === 2 && steps[1] === NS.rdf + 'type' && inHead) {
        const info = (extract.byPath[steps[0]] ??= {});
        info.targetTypes = list(inHead);
        if (msg) (info.messages ??= {}).targetTypes = msg;
      }
      continue;
    }
    if (!path || path.startsWith('"')) continue;
    if (get(s, SH + 'inversePath').length) continue;
    const info = (extract.byPath[path] ??= {});
    const set = <K extends keyof ShaclInfo>(k: K, v: ShaclInfo[K] | undefined, kind: string) => {
      if (v === undefined) return;
      info[k] = v;
      if (msg) (info.messages ??= {})[kind] = msg;
    };
    set('minCount', num(one(s, SH + 'minCount')), 'minCount');
    set('maxCount', num(one(s, SH + 'maxCount')), 'maxCount');
    set('datatype', val(one(s, SH + 'datatype')), 'datatype');
    set('pattern', val(one(s, SH + 'pattern')), 'pattern');
    set('minInclusive', num(one(s, SH + 'minInclusive')), 'range');
    set('maxInclusive', num(one(s, SH + 'maxInclusive')), 'range');
    set('minExclusive', num(one(s, SH + 'minExclusive')), 'range');
    set('maxExclusive', num(one(s, SH + 'maxExclusive')), 'range');
    set('maxLength', num(one(s, SH + 'maxLength')), 'maxLength');
    const inHead = one(s, SH + 'in');
    if (inHead) set('in', list(inHead), 'in');
    const cls = get(s, SH + 'class').map(v => val(v)!);
    if (cls.length) set('class', cls, 'class');
    if (!Object.keys(info).length) delete extract.byPath[path];
  }
  return extract;
}

export function applyShacl(profiles: ProfileData[], ex: ShaclExtract): void {
  for (const p of profiles) {
    for (const [path, info] of Object.entries(ex.byPath)) {
      const prop = p.properties[path];
      if (prop) prop.shacl = { ...prop.shacl, ...info, messages: { ...prop.shacl?.messages, ...info.messages } };
    }
    for (const [cls, notes] of Object.entries(ex.notesByClass)) {
      const c = p.classes[cls];
      if (c) c.extraRules = [...(c.extraRules ?? []), ...notes.filter(n => !c.extraRules?.some(e => e.name === n.name))];
    }
  }
}
