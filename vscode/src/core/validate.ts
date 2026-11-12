// Profile-aware checks for CIM/XML instance files.

import { Analysis, CimObject, isHeaderType, qname } from './analysis';
import { PropDef, formatMultiplicity, localName } from './model';
import { ProfileIndex, effectiveMax, effectiveMin, minFor } from './profileIndex';
import { isPropertyReference, knownPropertyNames, propertyReferenceName, withPropertyName } from './propertyReference';
import { XmlElement, attr, contentRange, expandName, splitQName, textContent } from './xml';

export type Severity = 'error' | 'warning' | 'info' | 'hint';

/**
 * Where the broken rule comes from: the RDFS profile definition ("schema"), a SHACL shape that is
 * stricter than the RDFS ("shacl"), the ENTSO-E reference data ("reference"), or CIM/XML file rules
 * such as syntax, prefixes and identifiers ("file").
 */
export type RuleSource = 'schema' | 'shacl' | 'reference' | 'file' | 'dataset';

export interface Problem {
  start: number;
  end: number;
  severity: Severity;
  message: string;
  code: string;
  rule?: RuleSource;
  /** Every rule set the problem breaks, e.g. ['schema', 'shacl'] when the RDFS and a SHACL shape both reject it. */
  rules?: RuleSource[];
  /** Extra data for quick fixes. */
  data?: Record<string, unknown>;
}

export interface ValidateOptions {
  unresolvedReferences: 'off' | 'hint' | 'info' | 'warning';
  /** References found neither in the file nor in the other files of its dataset. */
  danglingReferences?: 'off' | 'hint' | 'info' | 'warning' | 'error';
  requiredProperties: boolean;
  checkIdFormat: boolean;
  /** Check NC PropertyReference values against the PropertyReference list or the loaded profiles. */
  propertyReferences?: boolean;
}

export const DEFAULT_VALIDATE_OPTIONS: ValidateOptions = {
  unresolvedReferences: 'hint',
  danglingReferences: 'warning',
  requiredProperties: true,
  checkIdFormat: true,
  propertyReferences: true,
};

const RULE_OF_CODE: Record<string, RuleSource> = {
  xml: 'file', 'undeclared-prefix': 'file', 'unknown-header-profile': 'file', 'duplicate-id': 'file', 'missing-id': 'file',
  'id-ncname': 'file', 'id-uuid': 'file', 'unresolved-reference': 'file',
  range: 'shacl', 'max-length': 'shacl', pattern: 'shacl',
  'property-reference': 'reference',
  'dangling-reference': 'dataset',
};

/** Tags a schema problem that a SHACL shape rejects too, adding the shape's message. */
function alsoShacl(p: Problem, shaclMessage: string | undefined, constraint: string): Problem {
  p.rule = 'schema';
  p.rules = ['schema', 'shacl'];
  p.message += ` [also SHACL ${constraint}${shaclMessage ? `:\n${shaclMessage}` : ''}]`;
  return p;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_INSIDE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const UUID_GROUPS = [8, 4, 4, 4, 12];

/**
 * Why an identifier is not prefix + UUID (mRID), or undefined when it is. The first line says what is
 * off (it is what lists show), the next lines show the identifier against the expected format.
 */
export function explainUuid(id: string, prefix: '_' | 'urn:uuid:'): string | undefined {
  const rest = id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
  if (rest !== undefined && UUID.test(rest)) return undefined;
  const shape = `${prefix}xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`;
  const expected = `Expected: ${shape} (x = 0-9 or a-f; groups of 8-4-4-4-12)`;
  const found = `Found:    ${id}`;
  const say = (what: string) => `${what}\n${found}\n${expected}`;
  const body = rest ?? id;
  const m = UUID_INSIDE.exec(body);
  if (m) {
    const before = body.slice(0, m.index);
    const after = body.slice(m.index + m[0].length);
    const parts = [
      rest === undefined ? `the identifier does not start with "${prefix}"` : '',
      before ? `extra text "${before}" before the UUID` : '',
      after ? `extra text "${after}" after the UUID` : '',
    ].filter(Boolean);
    return say(`Identifier is not "${prefix}" + UUID: ${parts.join(', ')}.`);
  }
  if (rest === undefined) return say(`Identifier is not "${prefix}" + UUID: the identifier does not start with "${prefix}".`);
  if (/^[0-9a-fA-F]{32}$/.test(rest)) {
    const dashed = [0, 8, 12, 16, 20].map((at, i) => rest.slice(at, at + UUID_GROUPS[i])).join('-');
    return say(`Identifier is not "${prefix}" + UUID: the UUID has no dashes (expected ${prefix}${dashed}).`);
  }
  const groups = rest.split('-');
  if (groups.length === 5) {
    const bad = groups.map((g, i) => {
      const n = UUID_GROUPS[i];
      if (g.length !== n) return `group ${i + 1} "${g}" has ${g.length} characters, expected ${n}`;
      const odd = g.replace(/[0-9a-fA-F]/g, '');
      return odd ? `group ${i + 1} "${g}" has non-hexadecimal "${[...new Set(odd)].join('')}"` : '';
    }).filter(Boolean);
    if (bad.length) return say(`Identifier is not "${prefix}" + UUID: ${bad.join('; ')}.`);
  }
  return say(`Identifier is not "${prefix}" + UUID: "${rest}" is not 5 groups of 8-4-4-4-12 hexadecimal digits.`);
}

const PRIMITIVE_CHECKS: Record<string, { re: RegExp; hint: string }> = {
  Float: { re: /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^(INF|-INF|NaN)$/, hint: 'a decimal number such as 1.5 or 1e-3' },
  Decimal: { re: /^[+-]?(\d+(\.\d*)?|\.\d+)$/, hint: 'a decimal number such as 10.25' },
  Integer: { re: /^[+-]?\d+$/, hint: 'a whole number' },
  Boolean: { re: /^(true|false)$/, hint: '"true" or "false"' },
  Date: { re: /^\d{4}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/, hint: 'a date such as 2024-01-31' },
  DateTime: {
    re: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
    hint: 'an ISO 8601 date-time such as 2024-01-31T23:00:00Z',
  },
  DateTimeStamp: {
    re: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    hint: 'an ISO 8601 date-time with time zone such as 2024-01-31T23:00:00Z',
  },
  Duration: { re: /^-?P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/, hint: 'an ISO 8601 duration such as PT15M' },
  MonthDay: { re: /^--\d{2}-\d{2}$/, hint: 'a month-day such as --12-31' },
  Time: { re: /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/, hint: 'a time such as 13:30:00' },
  URI: { re: /^\S+$/, hint: 'a URI without spaces' },
  IRI: { re: /^\S+$/, hint: 'an IRI without spaces' },
  StringIRI: { re: /^\S+$/, hint: 'an IRI without spaces' },
  URL: { re: /^\S+$/, hint: 'a URL without spaces' },
};

const XSD_TO_PRIMITIVE: Record<string, string> = {
  float: 'Float', double: 'Float', decimal: 'Decimal', integer: 'Integer', int: 'Integer', long: 'Integer',
  boolean: 'Boolean', date: 'Date', dateTime: 'DateTime', dateTimeStamp: 'DateTimeStamp', duration: 'Duration',
  gMonthDay: 'MonthDay', time: 'Time', anyURI: 'URI',
};

export function primitiveCheck(primitive: string | undefined, value: string): string | undefined {
  if (!primitive) return undefined;
  const c = PRIMITIVE_CHECKS[primitive];
  if (!c || c.re.test(value)) return undefined;
  return `Expected ${c.hint} (${primitive}), found "${value}".`;
}

export function validate(a: Analysis, opts: ValidateOptions = DEFAULT_VALIDATE_OPTIONS): Problem[] {
  const out: Problem[] = [];
  if (!a.isCim || !a.root) return out;
  const index = a.index;
  for (const p of a.doc.problems) out.push({ ...p, severity: 'error', code: 'xml' });

  // Undeclared prefixes anywhere in the tree.
  const checkPrefix = (el: XmlElement) => {
    const { prefix } = splitQName(el.name);
    if (prefix && prefix !== 'xml' && !el.ns.has(prefix)) {
      out.push({ start: el.nameStart, end: el.nameStart + prefix.length, severity: 'error', code: 'undeclared-prefix',
        message: `Namespace prefix "${prefix}" is not declared.`, data: { prefix } });
    }
    for (const c of el.children) checkPrefix(c);
  };
  checkPrefix(a.root);

  if (!index) return out;
  const active = a.active;
  const full = a.profileSource === 'explicit' || a.profileSource === 'header' || a.profileSource === 'inferred';
  const activeNames = active.map(p => p.keyword).join(', ') || 'any profile';

  if (a.header && a.unknownHeaderProfiles.length) {
    out.push({ start: a.header.nameStart, end: a.header.nameEnd, severity: 'warning', code: 'unknown-header-profile',
      message: `Header profile(s) not found in ${index.bundle.label}: ${a.unknownHeaderProfiles.join(', ')}` });
  }

  // Duplicate identifiers.
  const seen = new Map<string, CimObject>();
  for (const o of a.objects) {
    if (o.id === undefined) continue;
    const prev = seen.get(o.id);
    if (prev && o.idAttr) {
      out.push({ start: o.idAttr.valueStart, end: o.idAttr.valueEnd, severity: 'error', code: 'duplicate-id',
        message: `rdf:ID "${o.id}" is already used by another object in this file.` });
    } else seen.set(o.id, o);
  }

  const perClass = new Map<string, { allowed: PropDef[]; byUri: Map<string, PropDef>; required: PropDef[] }>();
  for (const o of a.objects) {
    const el = o.el;
    const nameRange = { start: el.nameStart, end: el.nameEnd };
    if (!o.type) continue; // undeclared prefix already reported
    if (isHeaderType(o.type)) continue;

    // Identifier
    if (o.id === undefined && o.about === undefined) {
      out.push({ ...nameRange, severity: 'error', code: 'missing-id', message: 'Object has no rdf:ID or rdf:about identifier.' });
    } else if (opts.checkIdFormat && o.idAttr) {
      const v = o.idAttr.value.trim();
      const r = { start: o.idAttr.valueStart, end: o.idAttr.valueEnd };
      if (o.id !== undefined) {
        if (!/^[A-Za-z_][\w.-]*$/.test(v)) out.push({ ...r, severity: 'error', code: 'id-ncname', message: `rdf:ID "${v}" is not a valid XML name (it must not start with a digit; CGMES uses "_" + UUID).` });
        else {
          const why = explainUuid(v, '_');
          if (why) out.push({ ...r, severity: 'hint', code: 'id-uuid', message: why });
        }
      } else if (v.startsWith('urn:uuid:')) {
        const why = explainUuid(v, 'urn:uuid:');
        if (why) out.push({ ...r, severity: 'warning', code: 'id-uuid', message: why });
      }
    }

    // Class
    const cls = index.classDef(o.type, active);
    const inActive = active.length === 0 || active.some(p => p.classes[o.type!]);
    if (!cls) {
      const alt = index.sameLocalName(o.type).filter(u => index.classDef(u));
      if (alt.length) {
        out.push({ ...nameRange, severity: 'error', code: 'wrong-namespace',
          message: `${el.name} is not defined in ${index.bundle.label}. Did you mean ${alt.map(u => qname(a, u)).join(' or ')}?`,
          data: { replacements: alt.map(u => qname(a, u)) } });
      } else {
        out.push({ ...nameRange, severity: 'error', code: 'unknown-class', message: `Unknown class ${el.name} in ${index.bundle.label}.` });
      }
      continue;
    }
    let isAbstract = false;
    if (!inActive) {
      const where = index.classProfiles(o.type).map(p => p.keyword).join(', ');
      out.push({ ...nameRange, severity: 'warning', code: 'class-not-in-profile',
        message: `${cls.label} is not part of profile ${activeNames} (it is defined in ${where}).` });
    } else if (!cls.concrete && active.some(p => p.classes[o.type!] && index.marksConcrete(p)) && !cls.enumValues && !cls.datatype) {
      isAbstract = true;
      out.push({ ...nameRange, severity: 'warning', code: 'abstract-class',
        message: `${cls.label} is not a concrete class in ${activeNames}; instantiate one of its subclasses instead.` });
    }

    if (o.about?.startsWith('#') && o.idAttr && a.dataset?.fileCount) checkDescribedObject(a, index, o, opts, out);

    // Properties
    // The same for every object of a class: computed once per class.
    let byClass = perClass.get(o.type);
    if (!byClass) {
      const list = index.propertiesFor(o.type, active.length ? active : index.profiles);
      byClass = { allowed: list, byUri: new Map(list.map(p => [p.uri, p])), required: list.filter(p => schemaMinFor(p, a.subProfiles) > 0 || minFor(p, a.subProfiles) > 0) };
      perClass.set(o.type, byClass);
    }
    const { allowed, byUri: allowedByUri, required } = byClass;
    const counts = new Map<string, XmlElement[]>();
    for (const c of el.children) {
      const puri = expandName(c, c.name);
      if (!puri) continue;
      const pr = { start: c.nameStart, end: c.nameEnd };
      let prop = allowedByUri.get(puri);
      if (!prop) {
        const def = index.propDef(puri, active);
        if (def && !def.used) {
          out.push({ ...pr, severity: 'warning', code: 'association-not-exchanged',
            message: `${def.label} is the non-exchanged end of the association${def.inverse ? `; set ${localName(def.inverse)} on the other object instead` : ''}.` });
          continue;
        }
        if (def && index.isA(o.type, def.domain)) {
          if (inActive) {
            const where = index.propProfiles(puri).map(p => p.keyword).join(', ');
            out.push({ ...pr, severity: 'warning', code: 'property-not-in-profile',
              message: `${def.label} is not exchanged in profile ${activeNames} (it belongs to ${where}).` });
          }
          prop = def;
        } else if (def) {
          out.push({ ...pr, severity: 'error', code: 'property-wrong-class',
            message: `${def.label} is not a property of ${cls.label}.` });
          continue;
        } else {
          const alt = index.sameLocalName(puri).filter(u => allowedByUri.has(u));
          if (alt.length) {
            out.push({ ...pr, severity: 'error', code: 'wrong-namespace',
              message: `${c.name} is not defined. Did you mean ${alt.map(u => qname(a, u)).join(' or ')}?`,
              data: { replacements: alt.map(u => qname(a, u)) } });
          } else {
            const suggestion = closest(localName(puri), allowed.map(p => p.label));
            out.push({ ...pr, severity: 'error', code: 'unknown-property',
              message: `Unknown property ${c.name} for ${cls.label}.${suggestion ? ` Did you mean ${suggestion}?` : ''}`,
              data: suggestion ? { replacements: [qname(a, allowed.find(p => p.label === suggestion)!.uri)] } : undefined });
          }
          continue;
        }
      }
      const list = counts.get(prop.uri) ?? [];
      list.push(c);
      counts.set(prop.uri, list);
      checkValue(a, c, prop, opts, out);
    }

    // Cardinality
    for (const [uri, els] of counts) {
      const prop = allowedByUri.get(uri) ?? index.propDef(uri, active)!;
      const max = effectiveMax(prop);
      if (max !== 'n' && els.length > max) {
        const bySchema = prop.max !== 'n' && els.length > prop.max;
        const byShacl = prop.shacl?.maxCount !== undefined && els.length > prop.shacl.maxCount;
        const maxMsg = prop.shacl?.messages?.maxCount && !/missing/i.test(prop.shacl.messages.maxCount) ? prop.shacl.messages.maxCount : undefined;
        for (const extra of els.slice(max)) {
          const p: Problem = { start: extra.nameStart, end: extra.nameEnd, severity: 'error', code: 'too-many', rule: bySchema ? 'schema' : 'shacl',
            message: bySchema
              ? `${prop.label} may appear at most ${max} time(s) (multiplicity ${formatMultiplicity(effectiveMin(prop), max)}).`
              : `SHACL allows ${prop.label} at most ${max} time(s) (sh:maxCount ${max}).${maxMsg ? ` [SHACL: ${maxMsg}]` : ''}` };
          out.push(bySchema && byShacl ? alsoShacl(p, maxMsg, `sh:maxCount ${prop.shacl!.maxCount}`) : p);
        }
      }
    }
    if (opts.requiredProperties && full && inActive && !isAbstract) {
      const missing = required.filter(p => schemaMinFor(p, a.subProfiles) > (counts.get(p.uri)?.length ?? 0));
      if (missing.length) {
        const p: Problem = { ...nameRange, severity: 'warning', code: 'missing-required',
          message: `Missing required ${missing.length === 1 ? 'property' : 'properties'} for ${cls.label} in ${activeNames}: ${missing.map(p => p.label).join(', ')}`,
          data: { properties: missing.map(p => p.uri) } };
        // The SHACL shapes require them too (sh:minCount).
        const both = missing.filter(m => m.shacl?.minCount !== undefined && minFor(m, a.subProfiles) > (counts.get(m.uri)?.length ?? 0));
        out.push(both.length ? alsoShacl(p, undefined, `sh:minCount for ${both.length === missing.length ? 'all of them' : both.map(m => m.label).join(', ')}`) : p);
      }
      // Required only by a SHACL shape (sh:minCount stricter than the RDFS multiplicity).
      const shaclOnly = required.filter(p => !missing.includes(p) && minFor(p, a.subProfiles) > (counts.get(p.uri)?.length ?? 0));
      if (shaclOnly.length) {
        out.push({ ...nameRange, severity: 'warning', code: 'missing-required', rule: 'shacl',
          message: `SHACL requires ${shaclOnly.length === 1 ? 'property' : 'properties'} for ${cls.label}: ${shaclOnly.map(p => p.label + (p.shacl?.messages?.minCount ? ` [SHACL: ${p.shacl.messages.minCount}]` : '')).join(', ')}`,
          data: { properties: shaclOnly.map(p => p.uri) } });
      }
    }
  }
  for (const p of out) {
    p.rule ??= RULE_OF_CODE[p.code] ?? 'schema';
    p.rules ??= [p.rule];
  }
  return out;
}

/** Lower bound from the RDFS multiplicity alone (SHACL sh:minCount ignored). */
function schemaMinFor(p: PropDef, subProfiles: Set<string>): number {
  if (!p.subProfile) return p.min;
  return p.subProfile.split(',').some(s => subProfiles.has(s)) ? p.min : (p.coreMin ?? 0);
}

function checkValue(a: Analysis, c: XmlElement, prop: PropDef, opts: ValidateOptions, out: Problem[]) {
  const index = a.index!;
  const res = attr(c, 'rdf:resource');
  const text = textContent(a.doc, c).trim();
  const tag = { start: c.nameStart, end: c.nameEnd };
  const shMsg = (k: string) => (prop.shacl?.messages?.[k] ? ` [SHACL: ${prop.shacl.messages[k]}]` : '');

  if (prop.kind === 'attribute') {
    if (res) {
      out.push({ start: res.nameStart, end: res.valueEnd + 1, severity: 'error', code: 'expected-literal',
        message: `${prop.label} is an attribute (${prop.primitive ?? 'literal'}); write the value as element text, not rdf:resource.` });
      return;
    }
    const cr = contentRange(c);
    const range = cr ? trimRange(a.doc.text, cr) : tag;
    if (!text) {
      if (c.closeStart >= 0 || c.selfClosing) out.push({ ...range, severity: 'warning', code: 'empty-value', message: `${prop.label} has an empty value.` });
      return;
    }
    if (prop.fixed !== undefined && prop.fixed !== text) {
      out.push({ ...range, severity: 'warning', code: 'fixed-value', message: `${prop.label} has the fixed value "${prop.fixed}".` });
    }
    const primitive = prop.primitive ?? (prop.shacl?.datatype ? XSD_TO_PRIMITIVE[localName(prop.shacl.datatype)] : undefined);
    const err = primitiveCheck(primitive, text);
    if (err) {
      const bySchema = !!prop.primitive;
      const shPrim = prop.shacl?.datatype ? XSD_TO_PRIMITIVE[localName(prop.shacl.datatype)] : undefined;
      const p: Problem = { ...range, severity: 'error', code: 'datatype', rule: bySchema ? 'schema' : 'shacl', message: err + (bySchema ? '' : shMsg('datatype')) };
      out.push(bySchema && shPrim && primitiveCheck(shPrim, text)
        ? alsoShacl(p, prop.shacl?.messages?.datatype, `sh:datatype ${qnameXsd(prop.shacl!.datatype!)}`) : p);
      return;
    }
    const sh = prop.shacl;
    if (sh) {
      const n = Number(text);
      const bad =
        (sh.minInclusive !== undefined && n < sh.minInclusive) || (sh.maxInclusive !== undefined && n > sh.maxInclusive) ||
        (sh.minExclusive !== undefined && n <= sh.minExclusive) || (sh.maxExclusive !== undefined && n >= sh.maxExclusive);
      if (bad) out.push({ ...range, severity: 'error', code: 'range', message: `${prop.label} value ${text} is out of the allowed range.${shMsg('range')}` });
      if (sh.maxLength !== undefined && text.length > sh.maxLength) {
        out.push({ ...range, severity: 'warning', code: 'max-length', message: `${prop.label} is longer than ${sh.maxLength} characters.${shMsg('maxLength')}` });
      }
      if (sh.pattern) {
        try {
          if (!new RegExp(sh.pattern).test(text)) out.push({ ...range, severity: 'warning', code: 'pattern', message: `${prop.label} does not match the pattern ${sh.pattern}.${shMsg('pattern')}` });
        } catch { /* pattern not supported by JS regex */ }
      }
    }
    return;
  }

  // association or enum
  if (!res) {
    out.push({ ...tag, severity: 'error', code: 'expected-resource',
      message: prop.kind === 'enum'
        ? `${prop.label} is an enumeration; use rdf:resource="${index.enumValues(prop.range!)[0] ?? '…'}".`
        : `${prop.label} is an association; reference the target with rdf:resource="#…".` });
    return;
  }
  const v = res.value.trim();
  const vr = { start: res.valueStart, end: res.valueEnd };
  if (prop.kind === 'enum') {
    const schemaValues = index.enumValues(prop.range!);
    const values = prop.shacl?.in?.length ? prop.shacl.in : schemaValues;
    if (values.length && !values.includes(v)) {
      if (schemaValues.includes(v)) {
        out.push({ ...vr, severity: 'error', code: 'enum-value', rule: 'shacl',
          message: `${localName(v)} is a ${localName(prop.range!)} value, but SHACL only allows ${values.map(localName).join(', ')}.${shMsg('in')}`,
          data: { replacements: values } });
        return;
      }
      const byLocal = values.find(x => localName(x) === localName(v));
      const near = byLocal ? undefined : closest(localName(v), values.map(localName));
      const suggestion = byLocal ?? values.find(x => localName(x) === near);
      const p: Problem = { ...vr, severity: 'error', code: 'enum-value',
        message: `"${v}" is not a value of ${localName(prop.range!)}.${byLocal ? ` Use the full URI ${byLocal}.` : ` Allowed:\n${values.map(localName).join(',\n')}`}`,
        data: suggestion ? { replacements: [suggestion] } : { replacements: values } };
      out.push(prop.shacl?.in?.length ? alsoShacl(p, prop.shacl.messages?.in, 'sh:in') : p);
    }
    return;
  }
  if (isPropertyReference(prop) && !v.startsWith('#') && !v.startsWith('urn:uuid:')) {
    if (opts.propertyReferences ?? true) checkPropertyReference(a, prop, v, vr, out);
    return;
  }
  const local = a.refs.get(v);
  const isLocalRef = v.startsWith('#') || v.startsWith('urn:uuid:');
  let targetTypes: (string | undefined)[];
  let where = '';
  if (local) {
    targetTypes = local.map(t => t.type);
  } else {
    const hits = isLocalRef ? a.dataset?.lookup(v) : undefined;
    if (!hits) {
      if (!isLocalRef) return;
      const n = a.dataset?.fileCount ?? 0;
      // Models this file depends on that are not in its folder (typically the boundary set): the
      // object may be there, so it is only "unresolved".
      const absent = n > 0 ? missingModels(a) : [];
      if (n > 0 && !absent.length) {
        const sev = opts.danglingReferences ?? 'warning';
        if (sev !== 'off') {
          out.push({ ...vr, severity: sev, code: 'dangling-reference',
            message: `${v} is not defined in this file nor in the ${n} other CIM file${n === 1 ? '' : 's'} of ${a.dataset!.scope ?? 'its folder'} (dangling reference; ${prop.label} expects a ${localName(prop.range ?? 'object')}).` });
        }
      } else if (opts.unresolvedReferences !== 'off') {
        out.push({ ...vr, severity: opts.unresolvedReferences, code: 'unresolved-reference',
          message: absent.length
            ? `${v} is not defined in this file nor in the ${n} other CIM file${n === 1 ? '' : 's'} of ${a.dataset!.scope ?? 'its folder'}; it may be in ${absent.length === 1 ? 'the model' : `one of the ${absent.length} models`} this file depends on that ${absent.length === 1 ? 'is' : 'are'} not there (e.g. the boundary set): ${absent.join(', ')}.`
            : `${v} is not defined in this file (it may live in another profile instance, e.g. EQ or boundary).` });
      }
      return;
    }
    // Another file may use another CIM version (an NC 2.2 AE pointing into a CGMES 2.4.15 EQ):
    // its classes are judged by the class of the same name in this version, when there is one.
    targetTypes = hits.map(h => {
      if (index.classDef(h.type)) return h.type;
      const same = index.sameLocalName(h.type).filter(u => index.classDef(u));
      return same.length === 1 ? same[0] : h.type;
    });
    where = ` (defined in ${[...new Set(hits.map(h => h.file.replace(/^.*[\\/]/, '')))].join(', ')})`;
  }
  // Only judge classes this version knows; a description in another profile may use a more general class.
  const expected = prop.shacl?.class?.length ? prop.shacl.class : prop.range ? [prop.range] : [];
  let judge = index;
  let known = targetTypes.filter((t): t is string => !!t && !!index.classDef(t));
  if (!known.length && expected.length) {
    // A class of another version with the same namespace (an NC 2.2 AE pointing into a CGMES 3.0 EQ):
    // judged by that version, when it knows the expected classes too.
    const other = a.indexes.find(i => i !== index && i.bundle.namespaces['cim'] === index.bundle.namespaces['cim']
      && targetTypes.some(t => t && i.classDef(t)) && expected.every(r => i.classDef(r)));
    if (other) { judge = other; known = targetTypes.filter((t): t is string => !!t && !!other.classDef(t)); }
  }
  if (!known.length) return;
  if (!expected.length || known.some(t => expected.some(r => judge.isA(t, r)))) return;
  const t = known[0];
  const bySchema = !prop.range || !known.some(k => judge.isA(k, prop.range!));
  const byShacl = !!prop.shacl?.class?.length;
  const p: Problem = { ...vr, severity: 'error', code: 'reference-type', rule: bySchema ? 'schema' : 'shacl',
    message: bySchema
      ? `${prop.label} must reference a ${localName(prop.range ?? expected[0])}, but ${v} is ${an(localName(t))}${where}.`
      : `SHACL requires ${prop.label} to reference a ${expected.map(localName).join(' or ')}, but ${v} is ${an(localName(t))}${where}.${shMsg('class')}` };
  out.push(bySchema && byShacl ? alsoShacl(p, prop.shacl?.messages?.class, `sh:class ${prop.shacl!.class!.map(localName).join(' or ')}`) : p);
}

/**
 * Models the file depends on, directly or through the files it depends on (TP -> EQ -> boundary),
 * that are not in the dataset: references may point into them, so they are not called dangling.
 */
function missingModels(a: Analysis): string[] {
  const ds = a.dataset!;
  return ds.missingModels ?? a.dependsOn.filter(d => !ds.hasModel(d));
}

const an = (w: string) => (/^[AEIOU]/i.test(w) ? 'an ' : 'a ') + w;

/**
 * rdf:about="#_x" describes an object defined in another file (SSH, TP, SV values of an EQ object):
 * it must exist in the dataset and be of the same class (or a sub/superclass of it).
 */
function checkDescribedObject(a: Analysis, index: ProfileIndex, o: CimObject, opts: ValidateOptions, out: Problem[]) {
  const v = o.about!;
  if (a.refs.get(v)?.some(x => x !== o && x.id !== undefined)) return; // defined in this file
  const r = { start: o.idAttr!.valueStart, end: o.idAttr!.valueEnd };
  const hits = a.dataset!.lookup(v);
  const cls = localName(o.type!);
  if (!hits) {
    const n = a.dataset!.fileCount;
    const absent = missingModels(a);
    if (absent.length) {
      if (opts.unresolvedReferences !== 'off') {
        out.push({ ...r, severity: opts.unresolvedReferences, code: 'unresolved-reference',
          message: `${v} describes ${an(cls)} that is not in this folder; it may be in a model this file depends on that is not there (e.g. the boundary set): ${absent.join(', ')}.` });
      }
      return;
    }
    const sev = opts.danglingReferences ?? 'warning';
    if (sev !== 'off') {
      out.push({ ...r, severity: sev, code: 'dangling-reference',
        message: `${v} describes ${an(cls)} that is defined neither in this file nor in the ${n} other CIM file${n === 1 ? '' : 's'} of ${a.dataset!.scope ?? 'its folder'} (e.g. its EQ).` });
    }
    return;
  }
  const known = hits.map(h => index.classDef(h.type) ? h.type : index.sameLocalName(h.type).find(u => index.classDef(u)))
    .filter((t): t is string => !!t);
  if (!known.length || known.some(t => index.isA(t, o.type!) || index.isA(o.type!, t))) return;
  const files = [...new Set(hits.map(h => h.file.replace(/^.*[\\/]/, '')))].join(', ');
  out.push({ ...r, severity: 'error', code: 'reference-type', rule: 'dataset',
    message: `${v} is described here as ${an(cls)}, but it is ${an(localName(known[0]))} in ${files}.` });
}

/** nc:PropertyReference values: only the "Class.property" part is checked, the namespace is not. */
function checkPropertyReference(a: Analysis, prop: PropDef, v: string, vr: { start: number; end: number }, out: Problem[]) {
  const name = propertyReferenceName(v);
  if (!/^[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*$/.test(name)) {
    out.push({ ...vr, severity: 'error', code: 'property-reference',
      message: `${prop.label} must end with a property name such as Class.property (e.g. ${withPropertyName('', 'Switch.open')}), found "${name}".` });
    return;
  }
  const list = a.propertyReferences;
  const known = list?.set ?? knownPropertyNames(a.indexes);
  if (known.has(name)) return;
  const candidates = list?.names ?? [...known];
  const sameCase = candidates.find(n => n.toLowerCase() === name.toLowerCase());
  const near = sameCase ?? closestName(name, candidates);
  out.push({ ...vr, severity: list ? 'error' : 'warning', code: 'property-reference',
    message: list
      ? `${name} is not in the PropertyReference list (${list.source}).${near ? ` Did you mean ${near}?` : ''}`
      : `${name} is not a property of the loaded CIM profiles.${near ? ` Did you mean ${near}?` : ''} Set cgmes.propertyReferenceList to check against the ENTSO-E PropertyReference list.`,
    data: near ? { replacements: [withPropertyName(v, near)] } : undefined });
}

function qnameXsd(uri: string): string {
  return uri.replace('http://www.w3.org/2001/XMLSchema#', 'xsd:');
}

function trimRange(text: string, r: { start: number; end: number }) {
  let { start, end } = r;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return start === end ? r : { start, end };
}

const closestCache = new Map<string, string | undefined>();

export function closest(word: string, candidates: string[]): string | undefined {
  const key = word + '\u0000' + candidates.join('\u0001');
  if (closestCache.has(key)) return closestCache.get(key);
  if (closestCache.size > 5000) closestCache.clear();
  const r = computeClosest(word, candidates);
  closestCache.set(key, r);
  return r;
}

function computeClosest(word: string, candidates: string[]): string | undefined {
  const w = word.toLowerCase();
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const cl = c.toLowerCase();
    const tail = cl.slice(cl.lastIndexOf('.') + 1);
    const d = Math.min(lev(w, cl), lev(w.slice(w.lastIndexOf('.') + 1), tail));
    if (d < bestD) { bestD = d; best = c; }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(word.length / 4)) ? best : undefined;
}

/** Closest "Class.property" comparing the whole name (closest() also matches on the part after the dot). */
function closestName(word: string, candidates: string[]): string | undefined {
  const w = word.toLowerCase();
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = lev(w, c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= Math.max(2, Math.floor(word.length / 5)) ? best : undefined;
}

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 6) return 99;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** VS Code keeps at most this many diagnostics per file and drops the rest ("Not showing N further…"). */
export const MAX_EDITOR_PROBLEMS = 1000;
/** Above this many unresolved references, the editor gets one summary instead of one hint each. */
export const COLLAPSE_UNRESOLVED_OVER = 100;

/**
 * The problems to publish to the editor: cross-file references collapsed into one summary when
 * there are many (normal for NC files pointing into EQ), and errors and warnings kept first when
 * the list would still exceed VS Code's limit. The full list stays available to the CIM Issues view.
 */
export function problemsForEditor(problems: Problem[], anchor: { start: number; end: number }): Problem[] {
  let out = problems;
  const unresolved = out.filter(p => p.code === 'unresolved-reference');
  if (unresolved.length > COLLAPSE_UNRESOLVED_OVER) {
    out = out.filter(p => p.code !== 'unresolved-reference');
    out.push({ ...anchor, severity: unresolved[0].severity, code: 'unresolved-reference', rule: 'file',
      message: `${unresolved.length} references point to objects that are not in this file (normal when they live in EQ, boundary or another profile instance). The CIM Issues view lists each one.` });
  }
  const dangling = out.filter(p => p.code === 'dangling-reference');
  if (dangling.length > COLLAPSE_UNRESOLVED_OVER) {
    out = out.filter(p => p.code !== 'dangling-reference');
    out.push({ ...anchor, severity: dangling[0].severity, code: 'dangling-reference', rule: 'dataset',
      message: `${dangling.length} references point to objects found neither in this file nor in the other CIM files of its dataset. The CIM Issues view lists each one.` });
  }
  if (out.length > MAX_EDITOR_PROBLEMS) {
    const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };
    const kept = [...out].sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, MAX_EDITOR_PROBLEMS - 1);
    kept.push({ ...anchor, severity: 'info', code: 'more-issues', rule: 'file',
      message: `${out.length - kept.length} more issues are not shown in the editor (VS Code shows at most ${MAX_EDITOR_PROBLEMS} per file). The CIM Issues view lists all ${out.length}.` });
    out = kept;
  }
  return out;
}
