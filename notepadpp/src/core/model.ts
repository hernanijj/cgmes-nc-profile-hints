// Normalized profile model shared by the build script and the extension.
// Everything is keyed by full URI so that cim:/nc:/entsoe: namespaces stay distinct.

export type Max = number | 'n';

export interface ClassDef {
  uri: string;
  label: string;
  comment?: string;
  superClasses: string[];
  stereotypes: string[];
  concrete: boolean;
  /** Set when the class is an enumeration: full URIs of the allowed values. */
  enumValues?: string[];
  /** Set for CIMDatatype/Primitive classes. */
  datatype?: { primitive: string; unit?: string; multiplier?: string };
  /** CGMES 2.4.15 EQ: "Operation" or "ShortCircuit" when the class is not in EQ core. */
  subProfile?: string;
  /** Rules from SHACL that the editor does not evaluate (SPARQL etc.), shown in hovers. */
  extraRules?: RuleNote[];
}

export interface RuleNote {
  name: string;
  description?: string;
  message?: string;
  severity?: string;
}

export type PropKind = 'attribute' | 'association' | 'enum';

export interface ShaclInfo {
  minCount?: number;
  maxCount?: number;
  datatype?: string;
  in?: string[];
  class?: string[];
  /** Classes the referenced object may have (sh:in on the path ( property rdf:type )), any namespace. */
  targetTypes?: string[];
  pattern?: string;
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number;
  maxExclusive?: number;
  maxLength?: number;
  /** constraint kind -> message */
  messages?: Record<string, string>;
}

export interface PropDef {
  uri: string;
  /** "Class.property" as written in RDFS labels / CIM XML. */
  label: string;
  domain: string;
  comment?: string;
  kind: PropKind;
  range?: string;
  dataType?: string;
  /** Primitive name: String, Float, Integer, Boolean, Date, DateTime, Duration, ... */
  primitive?: string;
  min: number;
  max: Max;
  /** false for association ends that are not exchanged (cims:AssociationUsed No). */
  used: boolean;
  inverse?: string;
  fixed?: string;
  /** CGMES 2.4.15 EQ: "Operation" or "ShortCircuit" when the property is not in EQ core. */
  subProfile?: string;
  /** Lower bound in EQ core when the sub-profile makes the property stricter. */
  coreMin?: number;
  shacl?: ShaclInfo;
}

export interface ProfileData {
  keyword: string;
  title: string;
  version?: string;
  versionIRI?: string;
  file: string;
  /** URIs that identify the profile in instance headers (md:Model.profile, dcterms:conformsTo). */
  profileURIs: string[];
  classes: Record<string, ClassDef>;
  properties: Record<string, PropDef>;
}

export interface VersionBundle {
  id: string;
  family: string;
  version: string;
  label: string;
  /** Preferred prefix -> namespace, used when inserting elements. */
  namespaces: Record<string, string>;
  /** How identifiers are written: rdf:ID="_..." (CGMES 2.4.15) or rdf:about="urn:uuid:...". */
  idStyle: 'rdfID' | 'urnUuid';
  profiles: ProfileData[];
  source?: string;
}

export const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  cims: 'http://iec.ch/TC57/1999/rdf-schema-extensions-19990926#',
  owl: 'http://www.w3.org/2002/07/owl#',
  dcat: 'http://www.w3.org/ns/dcat#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  sh: 'http://www.w3.org/ns/shacl#',
  md: 'http://iec.ch/TC57/61970-552/ModelDescription/1#',
  xml: 'http://www.w3.org/XML/1998/namespace',
};

export function localName(uri: string): string {
  const i = Math.max(uri.lastIndexOf('#'), uri.lastIndexOf('/'));
  return i >= 0 ? uri.slice(i + 1) : uri;
}

export function namespaceOf(uri: string): string {
  const i = uri.lastIndexOf('#');
  if (i >= 0) return uri.slice(0, i + 1);
  const j = uri.lastIndexOf('/');
  return j >= 0 ? uri.slice(0, j + 1) : '';
}

export function formatMultiplicity(min: number, max: Max): string {
  return `${min}..${max}`;
}
