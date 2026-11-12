// Turns a CIM/XML text into objects, references and header information, and
// works out which version bundle and profiles apply to it.

import { NS, ProfileData, localName } from './model';
import { ProfileIndex, indexForHeader } from './profileIndex';
import type { DatasetLookup } from './crossIndex';
import { PropertyReferenceList } from './propertyReference';
import { XmlAttr, XmlDocument, XmlElement, attr, expandName, parseXml, textContent } from './xml';

export interface CimObject {
  el: XmlElement;
  type?: string;
  /** rdf:ID value */
  id?: string;
  /** rdf:about value */
  about?: string;
  idAttr?: XmlAttr;
  name?: string;
}

export type ProfileSource = 'explicit' | 'header' | 'inferred' | 'none';

export interface Analysis {
  doc: XmlDocument;
  isCim: boolean;
  root?: XmlElement;
  header?: XmlElement;
  headerProfiles: string[];
  /** Models this one depends on (md:Model.DependentOn, dcterms:requires/references), as written. */
  dependsOn: string[];
  objects: CimObject[];
  /** reference ("#_x", "urn:uuid:x", or full URI) -> objects */
  refs: Map<string, CimObject[]>;
  index?: ProfileIndex;
  /** All loaded version bundles. */
  indexes: ProfileIndex[];
  active: ProfileData[];
  profileSource: ProfileSource;
  unknownHeaderProfiles: string[];
  idStyle: 'rdfID' | 'urnUuid';
  /** EQ sub-profiles declared in the header (CGMES 2.4.15): "Operation", "ShortCircuit". */
  subProfiles: Set<string>;
  /** The ENTSO-E PropertyReference list, when one is loaded. */
  propertyReferences?: PropertyReferenceList;
  /** Objects of the other files of the dataset (same folder), for cross-file reference checks. */
  dataset?: DatasetLookup;
}

const HEADER_TYPES = new Set([
  NS.md + 'FullModel',
  'http://iec.ch/TC57/61970-552/DifferenceModel/1#DifferenceModel',
  NS.dcat + 'Dataset',
]);

export function isHeaderType(uri: string | undefined): boolean {
  return !!uri && HEADER_TYPES.has(uri);
}

export interface AnalyzeOptions {
  indexes: ProfileIndex[];
  /** Bundle id or 'auto'. */
  version?: string;
  /** Profile keywords chosen by the user for this document. */
  profiles?: string[];
  idStyle?: 'auto' | 'rdfID' | 'urnUuid';
  propertyReferences?: PropertyReferenceList;
  dataset?: DatasetLookup;
}

export function refKeysFor(o: CimObject, base?: string): string[] {
  const keys: string[] = [];
  if (o.id !== undefined) {
    keys.push('#' + o.id);
    if (base) keys.push(base.replace(/#.*$/, '') + '#' + o.id);
  }
  if (o.about !== undefined) {
    keys.push(o.about);
    if (o.about.startsWith('urn:uuid:')) keys.push('#_' + o.about.slice(9));
  }
  return keys;
}

export function looksLikeCim(text: string): boolean {
  const head = text.slice(0, 20000);
  if (/<(?:rdfs:(?:Class|Datatype)|rdf:Property|owl:(?:Ontology|Class|ObjectProperty|DatatypeProperty)|sh:(?:NodeShape|PropertyShape))\b/i.test(head)) return false;
  const hasRdf = /<rdf:RDF\b|xmlns:rdf\s*=/.test(head);
  const hasCimVocabulary = /https?:\/\/(?:iec\.ch\/TC57\/(?:CIM100|2013\/CIM-schema-cim\d+|ns\/CIM\/|61970-552\/ModelDescription\/1#)|entsoe\.eu\/(?:CIM\/|ns\/(?:CIM|nc)#)|(?:ap-voc\.)?cim4\.eu\/|cim\.ucaiug\.io\/ns#)/i.test(head);
  return hasRdf && hasCimVocabulary;
}

export function analyze(text: string, opts: AnalyzeOptions): Analysis {
  const doc = parseXml(text);
  const named = doc.roots.filter(r => r.name !== '');
  const root = named.find(r => expandName(r, r.name) === NS.rdf + 'RDF') ?? named[0];
  const a: Analysis = {
    doc,
    isCim: looksLikeCim(text),
    root,
    headerProfiles: [],
    dependsOn: [],
    objects: [],
    refs: new Map(),
    indexes: opts.indexes,
    active: [],
    profileSource: 'none',
    unknownHeaderProfiles: [],
    idStyle: 'rdfID',
    subProfiles: new Set(),
    propertyReferences: opts.propertyReferences,
    dataset: opts.dataset,
  };
  if (!root) return a;
  const base = attr(root, 'xml:base')?.value;

  for (const el of root.children) {
    if (!el.name) continue; // a '<' being typed
    const type = expandName(el, el.name);
    if (isHeaderType(type)) {
      a.header ??= el;
      for (const c of el.children) {
        const ln = localName(expandName(c, c.name) ?? c.name);
        if (ln === 'Model.profile' || ln === 'conformsTo' || ln === 'profile') {
          const v = attr(c, 'rdf:resource')?.value ?? textContent(doc, c).trim();
          if (v) a.headerProfiles.push(v);
        } else if (ln === 'Model.DependentOn' || ln === 'DependentOn' || ln === 'requires' || ln === 'references') {
          const v = attr(c, 'rdf:resource')?.value.trim();
          if (v) a.dependsOn.push(v);
        }
      }
      continue;
    }
    const idAttr = attr(el, 'rdf:ID');
    const aboutAttr = attr(el, 'rdf:about');
    const o: CimObject = { el, type, id: idAttr?.value.trim(), about: aboutAttr?.value.trim(), idAttr: idAttr ?? aboutAttr };
    for (const c of el.children) {
      const ln = localName(c.name);
      if (ln === 'IdentifiedObject.name' || ln === 'name') { o.name = textContent(doc, c).trim(); break; }
    }
    a.objects.push(o);
    for (const k of refKeysFor(o, base)) {
      const list = a.refs.get(k);
      if (list) list.push(o); else a.refs.set(k, [o]);
    }
  }

  for (const u of a.headerProfiles) {
    if (/operation/i.test(u)) a.subProfiles.add('Operation');
    if (/shortcircuit/i.test(u)) a.subProfiles.add('ShortCircuit');
  }

  // Which version bundle?
  const cimNs = root.ns.get('cim');
  let index: ProfileIndex | undefined;
  if (opts.version && opts.version !== 'auto') index = opts.indexes.find(i => i.bundle.id === opts.version);
  if (!index) index = indexForHeader(opts.indexes, a.headerProfiles, cimNs);
  // CGMES 3.0 and the NC profiles share the CIM100 namespace: then the class hits decide.
  const byNs = cimNs ? opts.indexes.filter(i => i.bundle.namespaces['cim'] === cimNs) : [];
  if (!index && byNs.length === 1) index = byNs[0];
  if (!index) {
    // Most class hits wins.
    let best = 0;
    for (const i of byNs.length ? byNs : opts.indexes) {
      const hits = a.objects.filter(o => o.type && i.classDef(o.type)).length;
      if (hits > best) { best = hits; index = i; }
    }
  }
  index ??= byNs[0] ?? opts.indexes[0];
  a.index = index;
  if (!index) return a;

  // Which profiles?
  if (opts.profiles?.length) {
    a.active = opts.profiles.map(k => index!.profile(k)).filter((p): p is ProfileData => !!p);
    if (a.active.length) a.profileSource = 'explicit';
  }
  if (!a.active.length && a.headerProfiles.length) {
    const { matched, unknown } = index.profilesForHeader(a.headerProfiles);
    a.unknownHeaderProfiles = unknown;
    if (matched.length) { a.active = matched; a.profileSource = 'header'; }
  }
  if (!a.active.length) {
    a.active = inferProfiles(index, a);
    a.profileSource = a.active.length ? 'inferred' : 'none';
  }

  // Identifier style.
  if (opts.idStyle && opts.idStyle !== 'auto') a.idStyle = opts.idStyle;
  else {
    const withAbout = a.objects.filter(o => o.about?.startsWith('urn:uuid:')).length;
    const withId = a.objects.filter(o => o.id !== undefined).length;
    a.idStyle = withAbout > withId ? 'urnUuid' : withId > withAbout ? 'rdfID' : index.bundle.idStyle;
  }
  return a;
}

/** Picks the profile that covers the terms used in the document, if one clearly does. */
function inferProfiles(index: ProfileIndex, a: Analysis): ProfileData[] {
  const terms = new Set<string>();
  for (const o of a.objects) {
    if (o.type) terms.add(o.type);
    for (const c of o.el.children) {
      const u = expandName(c, c.name);
      if (u) terms.add(u);
    }
  }
  if (!terms.size) return [];
  let best: ProfileData | undefined;
  let bestScore = 0;
  for (const p of index.profiles) {
    let s = 0;
    for (const t of terms) if (p.classes[t] || p.properties[t]) s++;
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return best && bestScore / terms.size >= 0.9 ? [best] : [];
}

/** The object a nested element belongs to (direct child of rdf:RDF). */
const objectByElement = new WeakMap<Analysis, Map<XmlElement, CimObject>>();

export function objectOf(a: Analysis, el: XmlElement | undefined): CimObject | undefined {
  for (let e = el; e; e = e.parent) {
    if (e.parent === a.root) {
      let m = objectByElement.get(a);
      if (!m) { m = new Map(a.objects.map(o => [o.el, o])); objectByElement.set(a, m); }
      return m.get(e);
    }
  }
  return undefined;
}

/** Prefix to use for a namespace URI in this document (declared ones first). */
export function prefixFor(a: Analysis, uri: string): string | undefined {
  if (a.root) for (const [p, u] of a.root.ns) if (u === uri && p) return p;
  if (a.index) for (const [p, u] of Object.entries(a.index.bundle.namespaces)) if (u === uri) return p;
  return undefined;
}

export function qname(a: Analysis, uri: string): string {
  const i = uri.lastIndexOf('#');
  const ns = i >= 0 ? uri.slice(0, i + 1) : uri;
  const local = i >= 0 ? uri.slice(i + 1) : uri;
  const p = prefixFor(a, ns);
  return p ? `${p}:${local}` : local;
}
