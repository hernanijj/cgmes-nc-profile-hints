// Builds a VersionBundle from a set of RDFS (and optional SHACL) files.
// Used by the build script for the bundled packages and at runtime for
// user-provided schema folders.

import { ProfileData, VersionBundle } from './model';
import { parseRdfs } from './rdfs';
import { applyShacl, parseShacl, ShaclExtract } from './shacl';

export interface SourceFile { name: string; text: string }

export interface BundleMeta {
  id: string;
  family: string;
  version: string;
  label: string;
  idStyle?: VersionBundle['idStyle'];
  source?: string;
}

/**
 * "RemedialActionProfile_v2_2_SHACL.ttl" -> "remedialaction",
 * "61970-600-2_Equipment-AP-Con-Simple-SHACL.ttl" and "61970-552-Header-AP-Con-Simple-SHACL.ttl" (CGMES 3.0) -> "equipment", "header"
 */
function profileStem(file: string): string {
  const base = file.replace(/^.*[\\/]/, '');
  const m = /^(?:\d+[-\d]*[_-])?([A-Za-z]+?)(?:Profile|-AP|_AP|_v\d|RDFS|SHACL|CustomConstraints|\.)/.exec(base);
  return (m ? m[1] : base).toLowerCase();
}

/** "statevariables" and "statevariable" name the same profile. */
function singular(stem: string): string {
  return stem.replace(/s$/, '');
}

function versionScore(p: ProfileData, version: string): number {
  return p.version && p.version.startsWith(version) ? 1 : 0;
}

function compareVersions(a = '', b = ''): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * CGMES 3.0 "-Con-Complex-" SHACL files hold rules that apply only to some classes or kinds of model
 * (node-breaker, solved or not solved MAS): their cardinalities are not checked as if they held for
 * every object, only their value rules (ranges, allowed values, classes) and their SPARQL notes.
 */
function conditional(file: string): boolean {
  return /-Con-Complex-/i.test(file);
}

function valueRulesOnly(ex: ShaclExtract): ShaclExtract {
  const byPath: ShaclExtract['byPath'] = {};
  for (const [path, info] of Object.entries(ex.byPath)) {
    const { minCount, maxCount, messages, ...rest } = info;
    if (!Object.keys(rest).length) continue;
    const kept = messages && Object.fromEntries(Object.entries(messages).filter(([k]) => k !== 'minCount' && k !== 'maxCount'));
    byPath[path] = kept && Object.keys(kept).length ? { ...rest, messages: kept } : rest;
  }
  return { byPath, notesByClass: ex.notesByClass };
}

export function buildBundle(meta: BundleMeta, rdfs: SourceFile[], shapes: SourceFile[] = []): VersionBundle {
  const namespaces: Record<string, string> = {};
  const byKeyword = new Map<string, ProfileData>();
  const variants = new Map<string, ProfileData[]>();
  for (const f of rdfs) {
    let parsed;
    try {
      parsed = parseRdfs(f.text, f.name);
    } catch {
      continue;
    }
    const { profile, namespaces: ns } = parsed;
    if (!Object.keys(profile.classes).length) continue;
    for (const [k, v] of Object.entries(ns)) if (!(k in namespaces)) namespaces[k] = v;
    variants.set(profile.keyword, [...(variants.get(profile.keyword) ?? []), profile]);
    const prev = byKeyword.get(profile.keyword);
    if (!prev) { byKeyword.set(profile.keyword, profile); continue; }
    // Several files for one profile (e.g. EQ core / operation / short circuit variants,
    // or two header revisions): keep the one matching the package version, then the largest.
    const score = (p: ProfileData) => [versionScore(p, meta.version), Object.keys(p.properties).length];
    const [a1, a2] = score(profile), [b1, b2] = score(prev);
    if (a1 > b1 || (a1 === b1 && (a2 > b2 || (a2 === b2 && compareVersions(profile.version, prev.version) > 0)))) {
      byKeyword.set(profile.keyword, profile);
    }
  }
  const profiles = [...byKeyword.values()];
  for (const p of profiles) tagSubProfiles(p, variants.get(p.keyword) ?? []);

  for (const s of shapes) {
    const stem = singular(profileStem(s.name));
    const stems = profiles.map(p => singular(profileStem(p.file)));
    const targets = profiles.filter((_, i) => stems[i] === stem);
    // A variant of a profile kept in another form (CGMES 2.4.15 EquipmentCore*Profile.ttl when
    // the full EquipmentProfile.ttl is used): skip it, its cardinalities differ.
    if (!targets.length && stems.some(t => stem.startsWith(t))) continue;
    // Otherwise unmatched files (NC custom constraints, CGMES 3.0 AllProfiles) apply to every profile.
    applyShacl(targets.length ? targets : profiles, conditional(s.name) ? valueRulesOnly(parseShacl(s.text)) : parseShacl(s.text));
  }

  const isNc = Object.values(namespaces).some(u => /entsoe\.eu\/ns\/nc#|cim4\.eu\/ns\/nc#/.test(u));
  return {
    id: meta.id,
    family: meta.family,
    version: meta.version,
    label: meta.label,
    namespaces,
    idStyle: meta.idStyle ?? (isNc ? 'urnUuid' : 'rdfID'),
    profiles: profiles.sort((a, b) => a.keyword.localeCompare(b.keyword)),
    source: meta.source,
  };
}

/**
 * CGMES 2.4.15 ships EQ as Core / CoreOperation / CoreShortCircuit / CoreOperationShortCircuit
 * RDFS files. The largest one is kept; this marks what is not in Core so that
 * required-property checks follow the sub-profiles declared in the header.
 */
function tagSubProfiles(chosen: ProfileData, group: ProfileData[]): void {
  const kind = (p: ProfileData) => ({ op: /Operation/i.test(p.file), sc: /ShortCircuit/i.test(p.file) });
  const core = group.find(p => /Core/i.test(p.file) && !kind(p).op && !kind(p).sc);
  if (!core) return;
  const op = group.find(p => kind(p).op && !kind(p).sc);
  const sc = group.find(p => kind(p).sc && !kind(p).op);
  const tag = (uri: string, inCore: boolean, inOp: boolean, inSc: boolean): string | undefined => {
    if (inCore) return undefined;
    if (inOp && !inSc) return 'Operation';
    if (inSc && !inOp) return 'ShortCircuit';
    return op && sc && !inOp && !inSc ? 'Operation,ShortCircuit' : undefined;
  };
  for (const c of Object.values(chosen.classes)) {
    c.subProfile = tag(c.uri, !!core.classes[c.uri], !!op?.classes[c.uri], !!sc?.classes[c.uri]);
  }
  for (const pr of Object.values(chosen.properties)) {
    const inCore = core.properties[pr.uri];
    // Same property but stricter in a sub-profile (e.g. Terminal.ConnectivityNode 1..1 only with Operation).
    if (inCore && inCore.min < pr.min) {
      pr.subProfile = op?.properties[pr.uri] && op.properties[pr.uri].min === pr.min ? 'Operation' : 'ShortCircuit';
      pr.coreMin = inCore.min;
      continue;
    }
    pr.subProfile = tag(pr.uri, !!inCore, !!op?.properties[pr.uri], !!sc?.properties[pr.uri]);
  }
}
