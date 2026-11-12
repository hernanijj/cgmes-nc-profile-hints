// Hover text and navigation helpers (definition, references, outline).

import { Analysis, CimObject, isHeaderType, objectOf, qname } from './analysis';
import { classMarkdown, propMarkdown } from './docs';
import { normalizeRef } from './crossIndex';
import { localName } from './model';
import { elementAt, expandName } from './xml';

export interface HoverResult { markdown: string; start: number; end: number }

export function hover(a: Analysis, offset: number): HoverResult | undefined {
  const index = a.index;
  if (!index) return undefined;
  const el = elementAt(a.doc, offset);
  if (!el) return undefined;
  const closeNameStart = el.closeStart >= 0 ? el.closeStart + 2 : -1;
  const onName = (offset >= el.nameStart && offset <= el.nameEnd) ||
    (closeNameStart >= 0 && offset >= closeNameStart && offset <= closeNameStart + el.name.length);
  const range = offset >= el.nameStart && offset <= el.nameEnd
    ? { start: el.nameStart, end: el.nameEnd }
    : { start: closeNameStart, end: closeNameStart + el.name.length };
  const uri = expandName(el, el.name);

  if (onName && uri) {
    if (el.parent === a.root) {
      const c = index.classDef(uri, a.active);
      if (c) return { markdown: classMarkdown(a, c), ...range };
      if (isHeaderType(uri)) return { markdown: `**${el.name}** — model header`, ...range };
      return undefined;
    }
    const p = index.propDef(uri, a.active);
    if (p) return { markdown: propMarkdown(a, p), ...range };
    return undefined;
  }

  const at = el.attrs.find(x => offset >= x.valueStart && offset <= x.valueEnd);
  if (at?.name === 'rdf:resource') {
    const v = at.value.trim();
    const r = { start: at.valueStart, end: at.valueEnd };
    const ev = index.classDef(v.replace(/\.[^.#/]*$/, ''));
    if (ev?.enumValues?.includes(v)) {
      return { markdown: `**${localName(v)}** — value of ${qname(a, ev.uri)}\n\n${ev.comment ?? ''}`, ...r };
    }
    const target = a.refs.get(v)?.[0];
    if (target) return { markdown: objectSummary(a, target), ...r };
  }
  return undefined;
}

export function objectSummary(a: Analysis, o: CimObject): string {
  const lines = [`**${o.name ?? (o.id ?? o.about)}** — ${o.type ? qname(a, o.type) : o.el.name}`];
  const id = o.id !== undefined ? `rdf:ID="${o.id}"` : `rdf:about="${o.about}"`;
  lines.push('', '`' + id + '`');
  return lines.join('\n');
}

/** Target object of the reference under the cursor. */
export function definitionAt(a: Analysis, offset: number): CimObject | undefined {
  const ref = referenceAt(a, offset);
  return ref ? a.refs.get(ref)?.[0] : undefined;
}

/** Identifier in the rdf:resource value under the cursor. */
export function referenceAt(a: Analysis, offset: number): string | undefined {
  const el = elementAt(a.doc, offset);
  const at = el?.attrs.find(x => x.name === 'rdf:resource' && offset >= x.valueStart && offset <= x.valueEnd);
  return at?.value.trim();
}

/** All rdf:resource attributes pointing at the object under the cursor (or referenced at cursor). */
export function referencesAt(a: Analysis, offset: number): { start: number; end: number }[] {
  const ref = referenceAt(a, offset);
  if (ref) return referencesTo(a, ref);
  const target = (() => {
    const el = elementAt(a.doc, offset);
    return objectOf(a, el);
  })();
  const id = target?.id ?? target?.about;
  return id ? referencesTo(a, id) : [];
}

/** All rdf:resource attributes in this file that identify the given object. */
export function referencesTo(a: Analysis, ref: string): { start: number; end: number }[] {
  const key = normalizeRef(ref);
  const out: { start: number; end: number }[] = [];
  for (const o of a.objects) for (const c of o.el.children) {
    const r = c.attrs.find(x => x.name === 'rdf:resource');
    if (r && (key ? normalizeRef(r.value) === key : r.value.trim() === ref.trim())) out.push({ start: r.valueStart, end: r.valueEnd });
  }
  return out;
}
