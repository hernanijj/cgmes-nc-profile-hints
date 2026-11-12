// Reads CIM RDFS files (CGMES 2.4.15 "RDFSAugmented" and the RDFS2020 style used
// by the network code profiles) into the normalized ProfileData model.

import { ClassDef, Max, NS, ProfileData, PropDef, localName } from './model';
import { XmlElement, attr, expandName, parseXml, textContent } from './xml';

type Obj = string | { res: string };

interface Subject {
  uri: string;
  props: Map<string, Obj[]>;
}

export interface RdfsParseResult {
  profile: ProfileData;
  namespaces: Record<string, string>;
}

function resolve(base: string, ref: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return ref;
  const b = base.replace(/#.*$/, '');
  if (ref.startsWith('#')) return b + ref;
  if (ref === '') return b;
  const slash = b.lastIndexOf('/');
  return (slash >= 0 ? b.slice(0, slash + 1) : b) + ref;
}

export function readTriples(text: string): { subjects: Map<string, Subject>; namespaces: Record<string, string> } {
  const doc = parseXml(text);
  const root = doc.root;
  const subjects = new Map<string, Subject>();
  const namespaces: Record<string, string> = {};
  if (!root) return { subjects, namespaces };
  for (const [p, u] of root.ns) if (p) namespaces[p] = u;
  const baseOf = (el: XmlElement): string => {
    for (let e: XmlElement | undefined = el; e; e = e.parent) {
      const b = attr(e, 'xml:base');
      if (b) return b.value.trim();
    }
    return '';
  };
  const add = (s: string, p: string, o: Obj) => {
    let subj = subjects.get(s);
    if (!subj) { subj = { uri: s, props: new Map() }; subjects.set(s, subj); }
    let list = subj.props.get(p);
    if (!list) { list = []; subj.props.set(p, list); }
    list.push(o);
  };
  for (const node of root.children) {
    const base = baseOf(node);
    const about = attr(node, 'rdf:about');
    const id = attr(node, 'rdf:ID');
    let s: string;
    if (about) s = resolve(base, about.value.trim());
    else if (id) s = resolve(base, '#' + id.value.trim());
    else continue;
    const nodeType = expandName(node, node.name);
    if (nodeType && nodeType !== NS.rdf + 'Description') add(s, NS.rdf + 'type', { res: nodeType });
    for (const p of node.children) {
      const pred = expandName(p, p.name);
      if (!pred) continue;
      const r = attr(p, 'rdf:resource');
      if (r) add(s, pred, { res: resolve(baseOf(p), r.value.trim()) });
      else add(s, pred, textContent(doc, p).trim());
    }
  }
  return { subjects, namespaces };
}

const first = (s: Subject | undefined, p: string): Obj | undefined => s?.props.get(p)?.[0];
const lit = (s: Subject | undefined, p: string): string | undefined => {
  const v = first(s, p);
  return typeof v === 'string' ? v : v?.res;
};
const res = (s: Subject | undefined, p: string): string | undefined => {
  const v = first(s, p);
  return typeof v === 'string' ? undefined : v?.res;
};
const all = (s: Subject | undefined, p: string): Obj[] => s?.props.get(p) ?? [];
const resAll = (s: Subject | undefined, p: string): string[] =>
  all(s, p).flatMap(o => (typeof o === 'string' ? [] : [o.res]));

function stereotypes(s: Subject): string[] {
  return all(s, NS.cims + 'stereotype').map(o => (typeof o === 'string' ? o : localName(o.res)));
}

export function parseMultiplicity(m: string | undefined): { min: number; max: Max } {
  if (!m) return { min: 0, max: 1 };
  const t = m.replace(/^.*M:/, '');
  const [a, b] = t.split('..');
  const min = parseInt(a, 10);
  if (b === undefined) return a === 'n' ? { min: 0, max: 'n' } : { min, max: min };
  return { min: isNaN(min) ? 0 : min, max: b === 'n' || b === '*' ? 'n' : parseInt(b, 10) };
}

const KNOWN_KEYWORDS: [RegExp, string][] = [
  [/^EquipmentBoundary/i, 'EQBD'],
  [/^TopologyBoundary/i, 'TPBD'],
  [/^Equipment/i, 'EQ'],
  [/^Topology/i, 'TP'],
  [/^SteadyStateHypothesis/i, 'SSH'],
  [/^StateVariable/i, 'SV'],
  [/^DiagramLayout/i, 'DL'],
  [/^GeographicalLocation/i, 'GL'],
  [/^Dynamics/i, 'DY'],
  [/^FileHeader/i, 'FH'],
];

export function parseRdfs(text: string, file: string): RdfsParseResult {
  const { subjects, namespaces } = readTriples(text);
  const types = (s: Subject) => resAll(s, NS.rdf + 'type');

  const classes: Record<string, ClassDef> = {};
  const properties: Record<string, PropDef> = {};
  let ontology: Subject | undefined;

  for (const s of subjects.values()) {
    const t = types(s);
    if (t.includes(NS.owl + 'Ontology')) ontology = s;
    if (t.includes(NS.rdfs + 'Class')) {
      const st = stereotypes(s);
      classes[s.uri] = {
        uri: s.uri,
        label: lit(s, NS.rdfs + 'label') ?? localName(s.uri),
        comment: lit(s, NS.rdfs + 'comment') || undefined,
        superClasses: resAll(s, NS.rdfs + 'subClassOf'),
        stereotypes: st,
        concrete: st.includes('concrete'),
      };
    }
  }

  // Enumeration values are typed with their enumeration class.
  for (const s of subjects.values()) {
    for (const t of types(s)) {
      const c = classes[t];
      if (c && c.stereotypes.includes('enumeration')) (c.enumValues ??= []).push(s.uri);
    }
  }

  const rawProps: Subject[] = [];
  for (const s of subjects.values()) if (types(s).includes(NS.rdf + 'Property')) rawProps.push(s);

  // Datatype classes: Primitive directly, CIMDatatype through their .value attribute.
  for (const c of Object.values(classes)) {
    if (c.stereotypes.includes('Primitive')) c.datatype = { primitive: c.label };
  }
  for (const s of rawProps) {
    const domain = res(s, NS.rdfs + 'domain');
    const c = domain ? classes[domain] : undefined;
    if (!c || !c.stereotypes.includes('CIMDatatype')) continue;
    const name = localName(s.uri).split('.').pop();
    c.datatype ??= { primitive: 'String' };
    if (name === 'value') {
      const dt = res(s, NS.cims + 'dataType');
      c.datatype.primitive = dt ? (classes[dt]?.label ?? localName(dt)) : 'String';
    } else if (name === 'unit') c.datatype.unit = lit(s, NS.cims + 'isFixed');
    else if (name === 'multiplier') c.datatype.multiplier = lit(s, NS.cims + 'isFixed');
  }

  const isDatatypeClass = (u: string) => {
    const c = classes[u];
    return !!c && (c.stereotypes.includes('CIMDatatype') || c.stereotypes.includes('Primitive'));
  };

  for (const s of rawProps) {
    const domain = res(s, NS.rdfs + 'domain');
    if (!domain) continue;
    if (isDatatypeClass(domain)) continue; // .value/.unit/.multiplier of datatypes
    const range = res(s, NS.rdfs + 'range');
    const dataType = res(s, NS.cims + 'dataType');
    const used = lit(s, NS.cims + 'AssociationUsed');
    const m = parseMultiplicity(res(s, NS.cims + 'multiplicity') ?? lit(s, NS.cims + 'multiplicity'));
    const label = localName(s.uri);
    const p: PropDef = {
      uri: s.uri,
      label,
      domain,
      comment: lit(s, NS.rdfs + 'comment') || undefined,
      kind: 'attribute',
      min: m.min,
      max: m.max,
      used: used === undefined ? true : used.toLowerCase() !== 'no',
      inverse: res(s, NS.cims + 'inverseRoleName'),
      fixed: lit(s, NS.cims + 'isFixed'),
    };
    const target = dataType ?? range;
    const targetClass = target ? classes[target] : undefined;
    if (targetClass?.enumValues || targetClass?.stereotypes.includes('enumeration')) {
      p.kind = 'enum';
      p.range = target;
    } else if (dataType || (range && isDatatypeClass(range))) {
      p.kind = 'attribute';
      p.dataType = target;
      p.primitive = targetClass?.datatype?.primitive ?? (target ? localName(target) : 'String');
    } else if (range) {
      p.kind = 'association';
      p.range = range;
    } else {
      p.primitive = 'String';
    }
    properties[s.uri] = p;
  }

  // Profile identification.
  const fileBase = file.replace(/^.*[\\/]/, '');
  if (fileBase.includes('AssessedElement')){
        print('AssessedElement profile detected');
  } 
  let keyword = lit(ontology, NS.dcat + 'keyword');
  const profileURIs: string[] = [];
  let version = lit(ontology, NS.owl + 'versionInfo');
  const versionIRI = res(ontology, NS.owl + 'versionIRI');
  if (versionIRI) profileURIs.push(versionIRI);
  // CGMES 2.4.15: <Profile>Version class with fixed URIs and shortName.
  for (const p of Object.values(properties)) {
    const c = classes[p.domain];
    if (!c || !/Version$/.test(c.label) || p.fixed === undefined) continue;
    const name = p.label.split('.').pop() ?? '';
    if (/URI/i.test(name) && /^https?:/.test(p.fixed) && !/DifferenceModel|ModelDescription/.test(p.fixed)) profileURIs.push(p.fixed);
    if (name === 'shortName' && !keyword) keyword = p.fixed;
    if (name === 'entsoeUML' && !version) version = p.fixed.replace(/^entsoe_v/, '');
  }
  if (!keyword) keyword = KNOWN_KEYWORDS.find(([re]) => re.test(fileBase))?.[1];
  if (!keyword) keyword = fileBase.replace(/Profile.*$/, '').replace(/[^A-Z]/g, '') || fileBase;

  // Drop the header "Version" helper classes from instance data hints.
  for (const c of Object.values(classes)) {
    if (/Version$/.test(c.label) && Object.values(properties).some(p => p.domain === c.uri && p.fixed !== undefined)) {
      delete classes[c.uri];
      for (const p of Object.values(properties)) if (p.domain === c.uri) delete properties[p.uri];
    }
  }

  const pkg = [...subjects.values()].find(s => types(s).includes(NS.cims + 'ClassCategory'));
  const title =
    lit(ontology, 'http://purl.org/dc/terms/#title') ??
    lit(ontology, 'http://purl.org/dc/terms/title') ??
    lit(pkg, NS.rdfs + 'label') ??
    fileBase;

  return {
    profile: { keyword, title: title || fileBase, version, versionIRI, file: fileBase, profileURIs, classes, properties },
    namespaces,
  };
}
function print(arg0: string) {
  console.log(arg0);
}

