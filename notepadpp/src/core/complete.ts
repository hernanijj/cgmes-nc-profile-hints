// Context-aware completion for CIM/XML documents, independent of the VS Code API.

import { Analysis, isHeaderType, objectOf, qname } from './analysis';
import { classMarkdown, propDetail, propMarkdown } from './docs';
import { NS, localName } from './model';
import { effectiveMax, minFor } from './profileIndex';
import { isPropertyReference, knownPropertyNames, withPropertyName } from './propertyReference';
import { documentSnippet, headerSnippet, nowIso, objectSnippet, propertySnippet, referenceCandidates } from './templates';
import { XmlElement, elementAt, expandName } from './xml';

export type ItemKind = 'class' | 'property' | 'association' | 'enum' | 'reference' | 'value' | 'snippet';

export interface CompletionResult {
  label: string;
  kind: ItemKind;
  detail?: string;
  documentation?: string;
  /** Snippet syntax. */
  insertText: string;
  filterText?: string;
  sortText?: string;
  replaceStart: number;
  replaceEnd: number;
  /** Re-open suggestions after inserting (e.g. to pick a reference). */
  retrigger?: boolean;
}

export interface CompleteOptions {
  insertRequired: boolean;
}

const NAME = /[\w:.\-]/;

export function complete(a: Analysis, offset: number, opts: CompleteOptions): CompletionResult[] {
  const text = a.doc.text;

  // 1) Inside an attribute value?
  const el = elementAt(a.doc, offset);
  if (el && (el.startTagEnd < 0 || offset < el.startTagEnd)) {
    const at = el.attrs.find(x => x.valueStart <= offset && offset <= x.valueEnd && x.valueEnd > x.nameEnd);
    if (at && at.name === 'rdf:resource') return resourceValues(a, el, at.valueStart, at.valueEnd);
  }

  // 2) Typing a tag name?
  const look = text.slice(Math.max(0, offset - 300), offset);
  const m = /<([\w:.\-]*)$/.exec(look);
  if (m) {
    const lt = offset - m[1].length - 1;
    let end = offset;
    while (end < text.length && NAME.test(text[end])) end++;
    let container = elementAt(a.doc, lt);
    if (container && container.start === lt) container = container.parent;
    return tagNames(a, container, lt + 1, end, opts);
  }

  // 3) Element text?
  if (el && el.startTagEnd >= 0 && offset >= el.startTagEnd && (el.closeStart < 0 || offset <= el.closeStart)) {
    return textValues(a, el, offset);
  }
  return [];
}

function tagNames(a: Analysis, container: XmlElement | undefined, start: number, end: number, opts: CompleteOptions): CompletionResult[] {
  const out: CompletionResult[] = [];

  if (!container || !a.root || (container !== a.root && !container.parent)) {
    if (a.root) return out;
    // Empty document: offer whole skeletons, one per profile and version.
    for (const index of a.indexes) for (const p of index.profiles) {
      if (p.classes[NS.md + 'FullModel'] && !Object.values(p.classes).some(c => c.concrete && !isHeaderType(c.uri))) continue;
      out.push({
        label: `${index.bundle.label} ${p.keyword} document`,
        kind: 'snippet',
        detail: p.title,
        documentation: `New ${index.bundle.label} ${p.keyword} instance file with header and namespaces.`,
        insertText: documentSnippet(index, [p]).slice(1),
        filterText: `${p.keyword} ${index.bundle.label}`,
        replaceStart: start,
        replaceEnd: end,
      });
    }
    return out;
  }
  const index = a.index;
  if (!index) return out;

  if (container === a.root) {
    if (!a.header) {
      out.push({
        label: 'md:FullModel (header)',
        kind: 'snippet',
        detail: `Model header for ${a.active.map(p => p.keyword).join(', ') || index.bundle.label}`,
        insertText: headerSnippet(a, a.active),
        filterText: 'FullModel header md:FullModel',
        sortText: '0',
        replaceStart: start,
        replaceEnd: end,
      });
    }
    const classes = index.concreteClasses(a.active.length ? a.active : index.profiles).filter(c => !isHeaderType(c.uri));
    for (const c of classes) {
      const q = qname(a, c.uri);
      out.push({
        label: q,
        kind: 'class',
        detail: `${index.bundle.label} · ${[...new Set(index.classProfiles(c.uri).map(p => p.keyword))].join(', ')}`,
        documentation: classMarkdown(a, c),
        insertText: objectSnippet(a, c, opts.insertRequired),
        filterText: `${q} ${c.label}`,
        sortText: '1' + c.label,
        replaceStart: start,
        replaceEnd: end,
      });
    }
    return out;
  }

  // Property of an object (or of the header).
  const obj = container.parent === a.root ? container : undefined;
  const type = obj ? expandName(obj, obj.name) : undefined;
  if (!type) return out;
  const profiles = isHeaderType(type)
    ? index.profiles.filter(p => p.classes[NS.md + 'FullModel'])
    : a.active.length ? a.active : index.classProfiles(type);
  const present = new Map<string, number>();
  for (const c of container.children) {
    const u = expandName(c, c.name);
    if (u && c.start !== start - 1) present.set(u, (present.get(u) ?? 0) + 1);
  }
  const view = { ...a, active: profiles } as Analysis;
  for (const p of index.propertiesFor(type, profiles)) {
    const have = present.get(p.uri) ?? 0;
    const max = effectiveMax(p);
    if (max !== 'n' && have >= max) continue;
    const q = qname(a, p.uri);
    const required = minFor(p, a.subProfiles) > have;
    out.push({
      label: q,
      kind: p.kind === 'attribute' ? 'property' : p.kind,
      detail: propDetail(view, p),
      documentation: propMarkdown(view, p),
      insertText: propertySnippet(view, p),
      filterText: `${q} ${p.label}`,
      sortText: (required ? '0' : '1') + p.label,
      replaceStart: start,
      replaceEnd: end,
      retrigger: p.kind === 'association' && referenceCandidates(view, p.range).length > 25,
    });
  }
  return out;
}

function resourceValues(a: Analysis, el: XmlElement, start: number, end: number): CompletionResult[] {
  const index = a.index;
  if (!index) return [];
  const puri = expandName(el, el.name);
  const prop = puri ? index.propDef(puri, a.active) : undefined;
  const out: CompletionResult[] = [];
  if (prop?.kind === 'enum') {
    const values = prop.shacl?.in?.length ? prop.shacl.in : index.enumValues(prop.range!);
    const enumDef = index.classDef(prop.range!);
    for (const v of values) {
      out.push({ label: localName(v), kind: 'enum', detail: v, documentation: enumDef?.comment, insertText: v.replace(/[\\$}]/g, '\\$&'),
        filterText: `${v} ${localName(v)}`, replaceStart: start, replaceEnd: end });
    }
    return out;
  }
  if (prop && isPropertyReference(prop)) {
    const typed = a.doc.text.slice(start, end);
    const names = a.propertyReferences?.names ?? [...knownPropertyNames(a.indexes)].sort();
    const detail = a.propertyReferences ? 'PropertyReference list' : 'CIM property (no PropertyReference list loaded)';
    // Keep the namespace already typed; otherwise use the reference data one.
    const keep = /PropertyReference[/#]/.test(typed);
    for (const n of names) {
      const v = withPropertyName(keep ? typed : '', n);
      out.push({ label: n, kind: 'value', detail, insertText: v.replace(/[\\$}]/g, '\\$&'), filterText: keep ? v : `${n} ${v}`, replaceStart: start, replaceEnd: end });
    }
    return out;
  }
  const self = objectOf(a, el);
  for (const c of referenceCandidates(a, prop?.range)) {
    if (self && (c.ref === '#' + self.id || c.ref === self.about)) continue;
    out.push({
      label: c.label === c.ref ? c.ref : `${c.label}`,
      kind: 'reference',
      detail: `${c.type ? localName(c.type) : ''} ${c.ref}`.trim(),
      insertText: c.ref.replace(/[\\$}]/g, '\\$&'),
      filterText: `${c.ref} ${c.label}`,
      replaceStart: start,
      replaceEnd: end,
    });
  }
  return out;
}

function textValues(a: Analysis, el: XmlElement, offset: number): CompletionResult[] {
  const index = a.index;
  if (!index || !el.parent || el.parent.parent !== a.root) return [];
  const puri = expandName(el, el.name);
  if (!puri) return [];
  const text = a.doc.text;
  let start = el.startTagEnd, end = el.closeStart >= 0 ? el.closeStart : offset;
  while (start < offset && /\s/.test(text[start])) start++;
  while (end > offset && /\s/.test(text[end - 1])) end--;
  const mk = (label: string, detail?: string): CompletionResult => ({ label, kind: 'value', detail, insertText: label.replace(/[\\$}]/g, '\\$&'), replaceStart: start, replaceEnd: end });

  if (puri === NS.md + 'Model.profile') {
    return index.profiles.flatMap(p => p.profileURIs.map(u => mk(u, `${p.keyword} · ${p.title}`)));
  }
  const prop = index.propDef(puri, a.active);
  if (!prop || prop.kind !== 'attribute') return [];
  if (prop.fixed !== undefined) return [mk(prop.fixed, 'fixed value')];
  switch (prop.primitive) {
    case 'Boolean': return [mk('true'), mk('false')];
    case 'DateTime': case 'DateTimeStamp': return [mk(nowIso(), 'now (UTC)')];
    case 'Date': return [mk(nowIso().slice(0, 10), 'today')];
  }
  if (/\.mRID$/.test(prop.label)) {
    const o = objectOf(a, el);
    const id = o?.id?.replace(/^_/, '') ?? o?.about?.replace(/^urn:uuid:/, '');
    if (id) return [mk(id, 'same as the object identifier')];
  }
  return [];
}
