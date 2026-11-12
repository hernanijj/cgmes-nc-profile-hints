// Snippet builders: new objects, properties, headers and whole documents.

import { randomUUID } from 'crypto';
import { Analysis, qname } from './analysis';
import { ClassDef, NS, ProfileData, PropDef, namespaceOf } from './model';
import { ProfileIndex, effectiveMin, minFor } from './profileIndex';

export function snippetEscape(s: string): string {
  return s.replace(/[\\$}]/g, m => '\\' + m);
}

function choiceEscape(s: string): string {
  return s.replace(/[\\$}|,]/g, m => '\\' + m);
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function newUuid(): string {
  return randomUUID();
}

export function idAttribute(style: 'rdfID' | 'urnUuid', uuid: string): string {
  return style === 'urnUuid' ? `rdf:about="urn:uuid:${uuid}"` : `rdf:ID="_${uuid}"`;
}

function placeholder(p: PropDef, n: number, uuid?: string): string {
  if (p.fixed !== undefined) return snippetEscape(p.fixed);
  if (uuid && /\.mRID$/.test(p.label)) return `\${${n}:${uuid}}`;
  switch (p.primitive) {
    case 'Boolean': return `\${${n}|true,false|}`;
    case 'Float': case 'Decimal': return `\${${n}:0.0}`;
    case 'Integer': return `\${${n}:0}`;
    case 'DateTime': case 'DateTimeStamp': return `\${${n}:${nowIso()}}`;
    case 'Date': return `\${${n}:${nowIso().slice(0, 10)}}`;
    case 'Duration': return `\${${n}:PT1H}`;
    case 'MonthDay': return `\${${n}:--01-01}`;
    case 'Version': return `\${${n}:1.0.0}`;
  }
  return `\${${n}:${p.label.split('.').pop()}}`;
}

/** Snippet body for one property element (without the leading '<'). */
export function propertySnippet(a: Analysis, p: PropDef, n = 1, uuid?: string): string {
  const q = qname(a, p.uri);
  if (p.kind === 'attribute') return `${q}>${placeholder(p, n, uuid)}</${q}>`;
  if (p.kind === 'enum') {
    const values = p.shacl?.in?.length ? p.shacl.in : a.index!.enumValues(p.range!);
    return values.length
      ? `${q} rdf:resource="\${${n}|${values.map(choiceEscape).join(',')}|}"/>`
      : `${q} rdf:resource="\${${n}}"/>`;
  }
  const targets = referenceCandidates(a, p.range);
  if (targets.length && targets.length <= 25) return `${q} rdf:resource="\${${n}|${targets.map(t => choiceEscape(t.ref)).join(',')}|}"/>`;
  return `${q} rdf:resource="${a.idStyle === 'urnUuid' ? 'urn:uuid:' : '#_'}\${${n}}"/>`;
}

export interface RefCandidate { ref: string; label: string; type?: string }

export function referenceCandidates(a: Analysis, range: string | undefined): RefCandidate[] {
  const out: RefCandidate[] = [];
  for (const o of a.objects) {
    if (range && (!o.type || !a.index?.isA(o.type, range))) continue;
    const ref = o.id !== undefined ? '#' + o.id : o.about;
    if (!ref) continue;
    out.push({ ref, label: o.name ?? ref, type: o.type });
  }
  return out;
}

/** Snippet body for a new object (without the leading '<'). */
export function objectSnippet(a: Analysis, c: ClassDef, insertRequired: boolean): string {
  const uuid = newUuid();
  const q = qname(a, c.uri);
  const lines = [`${q} ${idAttribute(a.idStyle, uuid)}>`];
  let n = 1;
  if (insertRequired && a.index) {
    const props = a.index.propertiesFor(c.uri, a.active.length ? a.active : a.index.classProfiles(c.uri));
    for (const p of props.filter(p => minFor(p, a.subProfiles) > 0)) lines.push(`\t<${propertySnippet(a, p, n++, uuid)}`);
  }
  lines.push('\t$0', `</${q}>`);
  return lines.join('\n');
}

function headerProfile(index: ProfileIndex): ProfileData | undefined {
  return index.profiles.find(p => p.classes[NS.md + 'FullModel']);
}

function datasetMetadataProfile(index: ProfileIndex): ProfileData | undefined {
  return index.profiles.find(p => p.classes[NS.dcat + 'Dataset']);
}

function headerURIs(p: ProfileData): string[] {
  const entsoe = p.profileURIs.filter(u => /entsoe\.eu\/CIM\//.test(u));
  return entsoe.length ? entsoe : p.profileURIs.slice(0, 1);
}

export function headerSnippet(a: Analysis, profiles: ProfileData[], start = 1): string {
  const index = a.index!;
  const hp = headerProfile(index);
  const metadataProfile = !hp ? datasetMetadataProfile(index) : undefined;
  if (metadataProfile) return datasetHeaderSnippet(a, profiles, metadataProfile, start);
  const md = (l: string) => qname(a, NS.md + l);
  const lines = [`${md('FullModel')} rdf:about="urn:uuid:${newUuid()}">`];
  let n = start;
  const now = nowIso();
  const done = new Set<string>();
  const add = (uri: string, body: string) => { if (!done.has(uri)) { done.add(uri); lines.push(`\t${body}`); } };
  add(NS.md + 'Model.created', `<${md('Model.created')}>${now}</${md('Model.created')}>`);
  add(NS.md + 'Model.scenarioTime', `<${md('Model.scenarioTime')}>\${${n++}:${now}}</${md('Model.scenarioTime')}>`);
  if (hp) {
    const header = { ...a, active: [hp] } as Analysis;
    for (const p of index.propertiesFor(NS.md + 'FullModel', [hp])) {
      if (effectiveMin(p) === 0 || done.has(p.uri) || p.uri === NS.md + 'Model.profile') continue;
      add(p.uri, `<${propertySnippet(header, p, n++)}`);
    }
  }
  add(NS.md + 'Model.modelingAuthoritySet', `<${md('Model.modelingAuthoritySet')}>\${${n++}:http://www.example.eu/OperatorX}</${md('Model.modelingAuthoritySet')}>`);
  for (const p of profiles) for (const u of headerURIs(p)) lines.push(`\t<${md('Model.profile')}>${snippetEscape(u)}</${md('Model.profile')}>`);
  lines.push(`</${md('FullModel')}>`);
  return lines.join('\n');
}

function datasetHeaderSnippet(a: Analysis, profiles: ProfileData[], metadataProfile: ProfileData, start: number): string {
  const index = a.index!;
  const uuid = newUuid();
  const datasetType = qname(a, NS.dcat + 'Dataset');
  const conformsTo = qname(a, 'http://purl.org/dc/terms/conformsTo');
  const lines = [`${datasetType} ${idAttribute(index.bundle.idStyle, uuid)}>`];
  const metadata = { ...a, active: [metadataProfile] } as Analysis;
  const identifier = 'http://purl.org/dc/terms/identifier';
  let n = start;
  const profilesToDeclare = [...metadataProfile.profileURIs, ...profiles.flatMap(headerURIs)];
  for (const uri of [...new Set(profilesToDeclare)]) {
    lines.push(`\t<${conformsTo}>${snippetEscape(uri)}</${conformsTo}>`);
  }
  for (const p of index.propertiesFor(NS.dcat + 'Dataset', [metadataProfile])) {
    if (minFor(p, new Set()) <= 0) continue;
    const q = qname(metadata, p.uri);
    if (p.uri === identifier) lines.push(`\t<${q}>\${${n++}:${uuid}}</${q}>`);
    else lines.push(`\t<${propertySnippet(metadata, p, n++)}`);
  }
  lines.push(`</${datasetType}>`);
  return lines.join('\n');
}

/** Namespaces needed by a profile (plus rdf and md). */
export function namespacesFor(index: ProfileIndex, profiles: ProfileData[]): [string, string][] {
  const used = new Set<string>([NS.rdf, NS.md]);
  const hp = headerProfile(index);
  const metadataProfile = !hp ? datasetMetadataProfile(index) : undefined;
  for (const p of [...profiles, ...(hp ? [hp] : metadataProfile ? [metadataProfile] : [])]) {
    for (const c of Object.values(p.classes)) if (c.concrete) used.add(namespaceOf(c.uri));
    for (const pr of Object.values(p.properties)) if (pr.used) used.add(namespaceOf(pr.uri));
  }
  const out: [string, string][] = [];
  const preferred = ['cim', 'entsoe', 'nc', 'eu', 'md', 'rdf'];
  const entries = Object.entries(index.bundle.namespaces).sort(
    (x, y) => (preferred.indexOf(x[0]) + 1 || 99) - (preferred.indexOf(y[0]) + 1 || 99),
  );
  for (const [prefix, uri] of entries) {
    if (used.has(uri) && !out.some(e => e[1] === uri)) out.push([prefix, uri]);
  }
  return out;
}

export function documentSnippet(index: ProfileIndex, profiles: ProfileData[]): string {
  const ns = namespacesFor(index, profiles);
  const root = { ns: new Map(ns) };
  const a = {
    index, indexes: [index], active: profiles, idStyle: index.bundle.idStyle, objects: [], refs: new Map(),
    root, doc: { text: '', roots: [], problems: [] }, isCim: true, headerProfiles: [], profileSource: 'explicit',
    unknownHeaderProfiles: [], subProfiles: new Set(),
  } as unknown as Analysis;
  const header = headerSnippet(a, profiles).split('\n').map(l => '\t' + l).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rdf:RDF ${ns.map(([p, u]) => `xmlns:${p}="${u}"`).join('\n\t')}>`,
    '\t<' + header.trimStart(),
    '\t$0',
    '</rdf:RDF>',
    '',
  ].join('\n');
}
