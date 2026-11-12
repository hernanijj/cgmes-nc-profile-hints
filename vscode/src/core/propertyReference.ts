// NC profiles point to CIM properties through nc:PropertyReference, whose values come from the
// ENTSO-E reference data list (http://energy.referencedata.eu/PropertyReference/), not from the
// document. Only the property part of the URI ("Class.property") is checked.

import { PropDef, localName } from './model';
import { ProfileIndex } from './profileIndex';

export const PROPERTY_REFERENCE_NS = 'http://energy.referencedata.eu/PropertyReference/';

export interface PropertyReferenceList {
  names: string[];
  set: Set<string>;
  /** Where the list came from (file path), for messages. */
  source: string;
}

const NAME = /^[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*$/;

/**
 * Reads the property names out of any text form of the list: RDF/XML, Turtle, JSON-LD, HTML,
 * CSV or one name per line. In order of preference: the members of the ENTSO-E reference data
 * collection (prov:hadMember, full property URIs in cim16/CIM100/cim17/nc namespaces), URIs
 * ending in PropertyReference/<Class.property>, then every "Class.property" token.
 */
export function parsePropertyReferenceList(text: string, source: string): PropertyReferenceList {
  const names = new Set<string>();
  for (const m of text.matchAll(/hadMember\b[^>]*?(?:rdf:resource\s*=\s*["']|<)([^"'>]+)/g)) {
    const l = localName(m[1].trim());
    if (NAME.test(l)) names.add(l);
  }
  if (!names.size) for (const m of text.matchAll(/PropertyReference[/#]([A-Za-z_][\w-]*\.[A-Za-z_][\w-]*)/g)) names.add(m[1]);
  if (!names.size) {
    for (const m of text.matchAll(/(?<![\w./#-])([A-Z][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)(?![\w.-])/g)) names.add(m[1]);
  }
  const sorted = [...names].sort();
  return { names: sorted, set: new Set(sorted), source };
}

export function isPropertyReference(prop: PropDef): boolean {
  return !!prop.range && localName(prop.range) === 'PropertyReference';
}

/** The property part of a PropertyReference value, whatever namespace it is written with. */
export function propertyReferenceName(value: string): string {
  return value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('#')) + 1);
}

/** The value with its property part replaced, keeping the namespace the author wrote. */
export function withPropertyName(value: string, name: string): string {
  const i = Math.max(value.lastIndexOf('/'), value.lastIndexOf('#'));
  return (i >= 0 ? value.slice(0, i + 1) : PROPERTY_REFERENCE_NS) + name;
}

const knownCache = new WeakMap<ProfileIndex[], Set<string>>();

/** "Class.property" names of every property in the loaded profiles (used when no list is loaded). */
export function knownPropertyNames(indexes: ProfileIndex[]): Set<string> {
  let s = knownCache.get(indexes);
  if (!s) {
    s = new Set();
    for (const i of indexes) for (const p of i.profiles) for (const uri of Object.keys(p.properties)) {
      const l = localName(uri);
      if (NAME.test(l)) s.add(l);
    }
    knownCache.set(indexes, s);
  }
  return s;
}
