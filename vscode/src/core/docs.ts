// Markdown documentation for classes and properties (hovers and completion details).

import { Analysis, qname } from './analysis';
import { ClassDef, PropDef, formatMultiplicity, localName } from './model';
import { effectiveMax, minFor } from './profileIndex';

export function typeLabel(a: Analysis, p: PropDef): string {
  if (p.kind === 'association') return `→ ${localName(p.range ?? '')}`;
  if (p.kind === 'enum') return `enum ${localName(p.range ?? '')}`;
  const dt = p.dataType ? a.index?.classDef(p.dataType) : undefined;
  const unit = dt?.datatype?.unit && dt.datatype.unit !== 'none' ? `, ${unitText(dt.datatype.multiplier, dt.datatype.unit)}` : '';
  const named = p.dataType && localName(p.dataType) !== p.primitive ? `${localName(p.dataType)} (${p.primitive}${unit})` : `${p.primitive ?? 'String'}${unit}`;
  return named;
}

function unitText(mult: string | undefined, unit: string): string {
  const m = mult && mult !== 'none' ? mult : '';
  return m + unit;
}

export function propDetail(a: Analysis, p: PropDef): string {
  const min = minFor(p, a.subProfiles), max = effectiveMax(p);
  const sub = p.subProfile ? ` · ${p.subProfile.replace(',', '/')}` : '';
  return `${typeLabel(a, p)} · ${formatMultiplicity(min, max)}${min > 0 ? ' · required' : ''}${sub}`;
}

export function propMarkdown(a: Analysis, p: PropDef): string {
  const index = a.index!;
  const lines: string[] = [];
  lines.push(`**${qname(a, p.uri)}** — ${propDetail(a, p)}`);
  if (p.comment) lines.push('', escape(p.comment));
  const facts: string[] = [];
  const profiles = index.propProfiles(p.uri).map(x => x.keyword);
  if (profiles.length) facts.push(`Profiles: ${[...new Set(profiles)].join(', ')}`);
  if (p.kind === 'enum' && p.range) {
    const vals = p.shacl?.in?.length ? p.shacl.in : index.enumValues(p.range);
    if (vals.length) facts.push(`Values: ${vals.map(v => '`' + localName(v) + '`').join(', ')}`);
  }
  if (p.kind === 'association') {
    facts.push(`Value: \`rdf:resource="${a.idStyle === 'urnUuid' ? 'urn:uuid:…' : '#_…'}"\` pointing to a ${localName(p.range ?? '')}`);
    if (p.inverse) facts.push(`Inverse: ${localName(p.inverse)} (not exchanged)`);
    if (p.shacl?.targetTypes?.length) facts.push(`SHACL value types: ${[...new Set(p.shacl.targetTypes.map(localName))].sort().map(c => '`' + c + '`').join(', ')}`);
  }
  if (p.fixed !== undefined) facts.push(`Fixed value: \`${p.fixed}\``);
  const sh = p.shacl;
  if (sh) {
    const s: string[] = [];
    if (sh.minInclusive !== undefined) s.push(`≥ ${sh.minInclusive}`);
    if (sh.minExclusive !== undefined) s.push(`> ${sh.minExclusive}`);
    if (sh.maxInclusive !== undefined) s.push(`≤ ${sh.maxInclusive}`);
    if (sh.maxExclusive !== undefined) s.push(`< ${sh.maxExclusive}`);
    if (sh.maxLength !== undefined) s.push(`max length ${sh.maxLength}`);
    if (sh.pattern) s.push(`pattern \`${sh.pattern}\``);
    if (s.length) facts.push(`SHACL: ${s.join(', ')}`);
  }
  if (facts.length) lines.push('', ...facts.map(f => `- ${f}`));
  return lines.join('\n');
}

export function classMarkdown(a: Analysis, c: ClassDef, withProps = true): string {
  const index = a.index!;
  const lines: string[] = [];
  const profiles = [...new Set(index.classProfiles(c.uri).map(p => p.keyword))];
  const flags = [c.concrete ? 'concrete' : c.enumValues ? 'enumeration' : c.datatype ? 'datatype' : 'abstract'];
  lines.push(`**${qname(a, c.uri)}** — ${flags.join(', ')} · ${index.bundle.label}${profiles.length ? ` · ${profiles.join(', ')}` : ''}`);
  if (c.comment) lines.push('', escape(c.comment));
  const anc = index.ancestors(c.uri);
  if (anc.length > 1) lines.push('', `Inherits: ${anc.slice(1).map(localName).join(' → ')}`);
  if (c.enumValues?.length) lines.push('', `Values: ${c.enumValues.map(v => '`' + localName(v) + '`').join(', ')}`);
  if (withProps && !c.enumValues && !c.datatype) {
    const props = index.propertiesFor(c.uri, a.active.length ? a.active : index.profiles);
    if (props.length) {
      const shown = props.slice(0, 40);
      lines.push('', `| Property | Type | Mult. |`, `|---|---|---|`);
      for (const p of shown) {
        lines.push(`| ${minFor(p, a.subProfiles) > 0 ? '**' + p.label + '**' : p.label} | ${typeLabel(a, p).replace(/\|/g, '\\|')} | ${formatMultiplicity(minFor(p, a.subProfiles), effectiveMax(p))} |`);
      }
      if (props.length > shown.length) lines.push('', `…and ${props.length - shown.length} more`);
    }
  }
  if (c.extraRules?.length) {
    lines.push('', 'Additional SHACL rules (checked by full validators, not in the editor):');
    for (const r of c.extraRules.slice(0, 8)) lines.push(`- ${escape(r.description ?? r.message ?? r.name)}`);
  }
  return lines.join('\n');
}

function escape(s: string): string {
  return s.replace(/\r/g, '').replace(/([\\`*_{}[\]<>])/g, '\\$1').replace(/\n/g, '  \n');
}
