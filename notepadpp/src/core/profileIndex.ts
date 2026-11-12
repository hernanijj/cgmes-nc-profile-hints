// Lookup helpers over a VersionBundle: inheritance, properties per class,
// profile identification from header URIs.

import { ClassDef, ProfileData, PropDef, VersionBundle, localName } from './model';

export class ProfileIndex {
  readonly bundle: VersionBundle;
  private classes = new Map<string, { def: ClassDef; profile: ProfileData }[]>();
  private props = new Map<string, { def: PropDef; profile: ProfileData }[]>();
  private byLocal = new Map<string, string[]>();
  private ancestorCache = new Map<string, string[]>();
  private propsCache = new Map<string, PropDef[]>();

  constructor(bundle: VersionBundle) {
    this.bundle = bundle;
    for (const p of bundle.profiles) {
      for (const c of Object.values(p.classes)) push(this.classes, c.uri, { def: c, profile: p });
      for (const pr of Object.values(p.properties)) push(this.props, pr.uri, { def: pr, profile: p });
    }
    for (const uri of [...this.classes.keys(), ...this.props.keys()]) {
      const l = localName(uri);
      const arr = this.byLocal.get(l) ?? [];
      if (!arr.includes(uri)) arr.push(uri);
      this.byLocal.set(l, arr);
    }
  }

  get profiles(): ProfileData[] { return this.bundle.profiles; }

  profile(keyword: string): ProfileData | undefined {
    return this.bundle.profiles.find(p => p.keyword === keyword);
  }

  /** Class definition, preferring the active profiles, then any profile with a comment. */
  classDef(uri: string, active?: ProfileData[]): ClassDef | undefined {
    const list = this.classes.get(uri);
    if (!list) return undefined;
    const inActive = active ? list.find(e => active.includes(e.profile)) : undefined;
    const def = (inActive ?? list[0]).def;
    if (!def.comment) {
      const withComment = list.find(e => e.def.comment);
      if (withComment) return { ...def, comment: withComment.def.comment };
    }
    return def;
  }

  classProfiles(uri: string): ProfileData[] {
    return (this.classes.get(uri) ?? []).map(e => e.profile);
  }

  propDef(uri: string, active?: ProfileData[]): PropDef | undefined {
    const list = this.props.get(uri);
    if (!list) return undefined;
    return ((active && list.find(e => active.includes(e.profile))) ?? list[0]).def;
  }

  propProfiles(uri: string): ProfileData[] {
    return (this.props.get(uri) ?? []).map(e => e.profile);
  }

  /** Other URIs (any namespace) with the same local name. */
  sameLocalName(uri: string): string[] {
    return (this.byLocal.get(localName(uri)) ?? []).filter(u => u !== uri);
  }

  /** The class itself followed by all its ancestors (nearest first). */
  ancestors(uri: string): string[] {
    const cached = this.ancestorCache.get(uri);
    if (cached) return cached;
    const out: string[] = [];
    const queue = [uri];
    while (queue.length) {
      const u = queue.shift()!;
      if (out.includes(u)) continue;
      out.push(u);
      for (const e of this.classes.get(u) ?? []) for (const s of e.def.superClasses) queue.push(s);
    }
    this.ancestorCache.set(uri, out);
    return out;
  }

  isA(cls: string, target: string): boolean {
    return this.ancestors(cls).includes(target);
  }

  /** Exchanged properties applicable to a class in the given profiles. */
  propertiesFor(cls: string, active: ProfileData[]): PropDef[] {
    const key = cls + '|' + active.map(p => p.keyword).join(',');
    const cached = this.propsCache.get(key);
    if (cached) return cached;
    const result = this.computeProperties(cls, active);
    this.propsCache.set(key, result);
    return result;
  }

  private computeProperties(cls: string, active: ProfileData[]): PropDef[] {
    const anc = new Set(this.ancestors(cls));
    const seen = new Map<string, PropDef>();
    for (const p of active) {
      for (const pr of Object.values(p.properties)) {
        if (!pr.used || !anc.has(pr.domain)) continue;
        const prev = seen.get(pr.uri);
        // Several profiles may carry the same property; the strictest lower bound wins.
        if (!prev || effectiveMin(pr) > effectiveMin(prev)) seen.set(pr.uri, pr);
      }
    }
    const order = this.ancestors(cls);
    return [...seen.values()].sort(
      (a, b) => effectiveMin(b) - effectiveMin(a) || order.indexOf(b.domain) - order.indexOf(a.domain) || a.label.localeCompare(b.label),
    );
  }

  concreteClasses(active: ProfileData[]): ClassDef[] {
    const out = new Map<string, ClassDef>();
    for (const p of active) for (const c of Object.values(p.classes)) if (c.concrete) out.set(c.uri, c);
    return [...out.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Whether a profile marks concrete classes at all (so abstract-class checks make sense). */
  marksConcrete(p: ProfileData): boolean {
    return Object.values(p.classes).some(c => c.concrete);
  }

  enumValues(enumUri: string): string[] {
    for (const e of this.classes.get(enumUri) ?? []) if (e.def.enumValues?.length) return e.def.enumValues;
    return [];
  }

  /**
   * Map header profile URIs (md:Model.profile / dcterms:conformsTo) to profiles. With exact, only
   * the URIs themselves count, not a profile of the same name in another version.
   */
  profilesForHeader(uris: string[], exact = false): { matched: ProfileData[]; unknown: string[] } {
    const matched: ProfileData[] = [];
    const unknown: string[] = [];
    for (const raw of uris) {
      if (raw.trim().endsWith('#')) continue;
      const u = norm(raw);
      let hit = this.bundle.profiles.find(p => p.profileURIs.some(x => norm(x) === u));
      if (!hit && !exact) {
        // Same profile, different minor version or host (ap.cim4.eu vs entsoe.eu): compare the name segment.
        const seg = nameSegment(u);
        if (seg) hit = this.bundle.profiles.find(p => p.profileURIs.some(x => nameSegment(norm(x)) === seg));
      }
      if (hit) { if (!matched.includes(hit)) matched.push(hit); } else unknown.push(raw);
    }
    return { matched, unknown };
  }
}

/**
 * The version bundle for a file: the one whose profiles the header names exactly, else one with a
 * profile of the same name (another minor version), preferring the file's cim namespace in both
 * cases (CGMES 2.4.15 and 3.0 both have SSH, TP, SV... profiles, only the namespace tells them apart).
 */
export function indexForHeader(indexes: ProfileIndex[], uris: string[], cimNs?: string): ProfileIndex | undefined {
  if (!uris.length) return undefined;
  const sameNs = (i: ProfileIndex) => !!cimNs && i.bundle.namespaces['cim'] === cimNs;
  const best = (exact: boolean) => {
    const hits = indexes
      .map(i => ({ i, n: i.profilesForHeader(uris, exact).matched.length }))
      .filter(h => h.n > 0)
      .sort((x, y) => Number(sameNs(y.i)) - Number(sameNs(x.i)) || y.n - x.n);
    return hits[0]?.i;
  };
  return best(true) ?? best(false);
}

export function effectiveMin(p: PropDef): number {
  return p.shacl?.minCount ?? p.min;
}

/** Lower bound taking CGMES 2.4.15 EQ sub-profiles (Operation, ShortCircuit) into account. */
export function minFor(p: PropDef, subProfiles?: Set<string>): number {
  const m = effectiveMin(p);
  if (!p.subProfile || !subProfiles) return m;
  return p.subProfile.split(',').some(s => subProfiles.has(s)) ? m : (p.coreMin ?? 0);
}

export function effectiveMax(p: PropDef): number | 'n' {
  return p.shacl?.maxCount ?? p.max;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}

function norm(u: string): string {
  return u.trim().toLowerCase().replace(/[#/]+$/, '');
}

/** "http://entsoe.eu/cim/equipmentcore/3/1" -> "equipmentcore"; ".../remedialaction-eu/2.2" -> "remedialaction" */
function nameSegment(u: string): string | undefined {
  const parts = u.replace(/^[a-z]+:\/\//, '').split('/').filter(Boolean);
  for (let i = parts.length - 1; i > 0; i--) {
    const p = parts[i];
    if (/^[\d.]+$/.test(p)) continue;
    return p.replace(/-eu$/, '').replace(/[^a-z]/g, '');
  }
  return undefined;
}
