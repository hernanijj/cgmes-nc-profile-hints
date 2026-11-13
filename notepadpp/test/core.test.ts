import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { fixture, indexes, run } from './helpers';
import { analyze, looksLikeCim } from '../src/core/analysis';
import { ProfileIndex } from '../src/core/profileIndex';
import { parsePropertyReferenceList } from '../src/core/propertyReference';
import { DEFAULT_VALIDATE_OPTIONS, explainUuid, problemsForEditor, validate } from '../src/core/validate';
import { complete } from '../src/core/complete';
import { hover } from '../src/core/hover';
import { parseXml, elementAt } from '../src/core/xml';

const codes = (text: string) => validate(run(text)).map(p => p.code);

test('profile selection prefers exact header URIs, then the CIM namespace', () => {
  const extra = ['cgmes-3.0', 'ncp-2.4'].map(id => new ProfileIndex(JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../..', 'profiles', id + '.json'), 'utf8'),
  )));
  const all = [...indexes, ...extra];
  const cases = [
    ['http://iec.ch/TC57/CIM100#', 'http://iec.ch/TC57/ns/CIM/SteadyStateHypothesis-EU/3.0', 'cgmes-3.0', 'SSH'],
    ['http://iec.ch/TC57/CIM100#', 'http://example.org/SteadyStateHypothesis-EU/9.9', 'cgmes-3.0', 'SSH'],
    ['http://iec.ch/TC57/2013/CIM-schema-cim16#', 'http://example.org/SteadyStateHypothesis-EU/9.9', 'cgmes-2.4.15', 'SSH'],
    ['https://cim.ucaiug.io/ns#', 'https://ap-voc.cim4.eu/AssessedElement/2.4', 'ncp-2.4', 'AE'],
    ['https://cim.ucaiug.io/ns#', 'https://ap-voc.cim4.eu/RemedialAction/2.5', 'ncp-2.5', 'RA'],
  ];
  for (const [ns, uri, id, keyword] of cases) {
    const text = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="${ns}" xmlns:md="http://iec.ch/TC57/61970-552/ModelDescription/1#"><md:FullModel rdf:about="urn:uuid:model"><md:Model.profile>${uri}</md:Model.profile></md:FullModel></rdf:RDF>`;
    for (const order of [all, [...all].reverse()]) {
      const a = analyze(text, { indexes: order });
      assert.equal(a.index?.bundle.id, id, uri);
      assert.deepEqual(a.active.map(p => p.keyword), [keyword]);
    }
  }
  const cgmes3 = extra[0];
  assert.equal(cgmes3.profilesForHeader([cases[1][1]], true).matched.length, 0);
  assert.deepEqual(cgmes3.profilesForHeader(['http://iec.ch/TC57/ns/CIM/SteadyStateHypothesis-EU#']), { matched: [], unknown: [] });
});

test('propertyReferences false suppresses only PropertyReference value checks', () => {
  const text = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:nc="http://entsoe.eu/ns/nc#"><nc:PinEquipment rdf:about="urn:uuid:invalid"><nc:PinEquipment.PropertyReference rdf:resource="http://energy.referencedata.eu/PropertyReference/Switch.opne"/></nc:PinEquipment></rdf:RDF>`;
  const a = analyze(text, { indexes, version: 'ncp-2.2', profiles: ['RA'] });
  const enabled = validate(a);
  assert.ok(enabled.some(p => p.code === 'property-reference'));
  assert.ok(enabled.some(p => p.code !== 'property-reference'));
  assert.deepEqual(validate(a, { ...DEFAULT_VALIDATE_OPTIONS, propertyReferences: false }), enabled.filter(p => p.code !== 'property-reference'));
  const { propertyReferences, ...legacyOptions } = DEFAULT_VALIDATE_OPTIONS;
  assert.deepEqual(validate(a, legacyOptions), enabled);
});

test('xml scanner keeps offsets and tolerates unfinished tags', () => {
  const t = '<a x="1"><b>hi</b><c y="2';
  const d = parseXml(t);
  assert.equal(d.root?.name, 'a');
  assert.equal(d.root?.children.length, 2);
  assert.equal(elementAt(d, t.indexOf('hi'))?.name, 'b');
});

test('only CIM instance RDF is classified and indexed for validation', async () => {
  const generic = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="urn:example:item"/></rdf:RDF>';
  const schema = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"><rdfs:Class rdf:about="http://iec.ch/TC57/CIM100#ACLineSegment"/></rdf:RDF>';
  assert.equal(looksLikeCim(generic), false);
  assert.equal(analyze(generic, { indexes }).isCim, false);
  assert.deepEqual(validate(analyze(generic, { indexes })), []);
  assert.equal(looksLikeCim(schema), false);
  assert.equal(analyze(schema, { indexes }).isCim, false);
  assert.equal(await scanObjects(generic, 'generic.rdf'), undefined);
  assert.equal(await scanObjects(schema, 'schema.rdf'), undefined);
  assert.equal(analyze(fixture('eq-2415.xml'), { indexes }).isCim, true);
});

test('CGMES 2.4.15 EQ: version, profile and sub-profiles come from the header', () => {
  const a = run(fixture('eq-2415.xml'));
  assert.equal(a.index?.bundle.id, 'cgmes-2.4.15');
  assert.deepEqual(a.active.map(p => p.keyword), ['EQ']);
  assert.equal(a.profileSource, 'header');
  assert.equal(a.subProfiles.size, 0);
});

test('CGMES 2.4.15 EQ diagnostics', () => {
  const c = codes(fixture('eq-2415.xml'));
  for (const k of ['undeclared-prefix', 'datatype', 'unknown-property', 'too-many', 'reference-type', 'enum-value', 'abstract-class', 'class-not-in-profile']) {
    assert.ok(c.includes(k), `expected ${k} in ${c.join(', ')}`);
  }
  const missing = validate(run(fixture('eq-2415.xml'))).filter(p => p.code === 'missing-required').map(p => p.message);
  // Short-circuit attributes are not required when only EquipmentCore is declared.
  assert.ok(!missing.some(m => m.includes('ACLineSegment.r0')), missing.join('\n'));
  assert.ok(!missing.some(m => m.includes('Terminal.ConnectivityNode')), missing.join('\n'));
  assert.ok(missing.some(m => m.includes('ACLineSegment.bch')));
});

test('declaring EquipmentShortCircuit makes short-circuit attributes required', () => {
  const t = fixture('eq-2415.xml').replace(
    '<md:Model.profile>http://entsoe.eu/CIM/EquipmentCore/3/1</md:Model.profile>',
    '<md:Model.profile>http://entsoe.eu/CIM/EquipmentCore/3/1</md:Model.profile><md:Model.profile>http://entsoe.eu/CIM/EquipmentShortCircuit/3/1</md:Model.profile>',
  );
  const missing = validate(run(t)).filter(p => p.code === 'missing-required').map(p => p.message).join('\n');
  assert.match(missing, /ACLineSegment\.r0/);
});

test('NCP 2.2 RA diagnostics use namespaces and SHACL', () => {
  const a = run(fixture('ra-22.xml'));
  assert.equal(a.index?.bundle.id, 'ncp-2.2');
  assert.deepEqual(a.active.map(p => p.keyword), ['RA']);
  const ps = validate(a);
  const wrongNs = ps.filter(p => p.code === 'wrong-namespace');
  assert.equal(wrongNs.length, 2);
  assert.deepEqual(wrongNs[0].data?.replacements, ['nc:RemedialAction.kind']);
  assert.match(ps.find(p => p.code === 'datatype')!.message, /Boolean/);
});

test('NCP 2.5 RA sample resolves its profile and validates required properties', () => {
  const text = fixture('ra-25.xml');
  const a = run(text);
  assert.equal(a.index?.bundle.id, 'ncp-2.5');
  assert.deepEqual(a.active.map(p => p.keyword), ['RA']);
  assert.equal(a.profileSource, 'header');

  const ps = validate(a);
  const schemaIssues = ps.filter(p => [
    'unknown-class', 'unknown-property', 'wrong-namespace', 'datatype', 'enum-value', 'missing-required',
  ].includes(p.code));
  assert.deepEqual(schemaIssues, [], schemaIssues.map(p => p.message).join('\n'));

  const broken = validate(run(text.replace(
    '<nc:RemedialAction.normalAvailable>true</nc:RemedialAction.normalAvailable>',
    '<nc:RemedialAction.normalAvailable>trueo</nc:RemedialAction.normalAvailable>',
  )));
  assert.ok(broken.some(p => p.code === 'datatype' && /Boolean/.test(p.message)));
});

test('NCP 2.5 completion uses the active profile namespace and required properties', () => {
  const t = fixture('ra-25.xml');
  const off = t.indexOf('</rdf:RDF>');
  const text = t.slice(0, off) + '<' + t.slice(off);
  const items = complete(run(text), off + 1, { insertRequired: true });
  const action = items.find(i => i.label === 'nc:GridStateAlterationRemedialAction');
  assert.ok(action, 'NCP 2.5 remedial-action class item');
  assert.match(action!.insertText, /rdf:ID="_/);
  assert.match(action!.insertText, /nc:GridStateAlterationRemedialAction\.isActivationRestricted/);
  assert.match(action!.insertText, /nc:RemedialAction\.kind rdf:resource=/);
});

test('completion offers classes at top level with required properties', () => {
  const t = fixture('ra-22.xml');
  const off = t.indexOf('</rdf:RDF>');
  const text = t.slice(0, off) + '<' + t.slice(off);
  const items = complete(run(text), off + 1, { insertRequired: true });
  const gsa = items.find(i => i.label === 'nc:GridStateAlterationRemedialAction');
  assert.ok(gsa, 'class item');
  assert.match(gsa!.insertText, /rdf:ID="_/);
  assert.match(gsa!.insertText, /nc:RemedialAction\.kind rdf:resource="\$\{\d+\|http/);
});

test('NCP 2.2 completion defaults to rdf:ID but follows existing urn:uuid objects', () => {
  const root = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:nc="http://entsoe.eu/ns/nc#">';
  const existing = '<nc:GridStateAlterationRemedialAction rdf:about="urn:uuid:11111111-1111-4111-8111-111111111111"/>';
  for (const [objects, expected] of [['', /rdf:ID="_/], [existing, /rdf:about="urn:uuid:/]] as const) {
    const text = `${root}${objects}<</rdf:RDF>`;
    const offset = text.lastIndexOf('</rdf:RDF>');
    const a = analyze(text, { indexes, version: 'ncp-2.2', profiles: ['RA'] });
    const item = complete(a, offset, { insertRequired: true }).find(i => i.label === 'nc:GridStateAlterationRemedialAction');
    assert.ok(item, 'class item');
    assert.match(item.insertText, expected);
  }
});

test('completion offers properties of the enclosing object, required first', () => {
  const t = fixture('eq-2415.xml');
  const at = t.indexOf('<cim:ACLineSegment.foo>');
  const text = t.slice(0, at) + '<' + t.slice(at);
  const items = complete(run(text), at + 1, { insertRequired: true });
  const labels = items.map(i => i.label);
  assert.ok(labels.includes('cim:ACLineSegment.bch'));
  assert.ok(!labels.includes('cim:ACLineSegment.x'), 'x already present with max 1');
  assert.ok(items.find(i => i.label === 'cim:ACLineSegment.bch')!.sortText!.startsWith('0'));
});

test('completion of rdf:resource suggests objects of the right type', () => {
  const t = fixture('eq-2415.xml');
  const prefix = '<cim:ConductingEquipment.BaseVoltage rdf:resource="';
  const start = t.indexOf(prefix);
  assert.notEqual(start, -1);
  const at = start + prefix.length;
  const items = complete(run(t), at, { insertRequired: true });
  assert.deepEqual(items.map(i => i.insertText), ['#_7e4b1f2a-1c1d-4e7b-9a10-0b6f8b0f0001']);
});

test('hover on a property shows type and multiplicity', () => {
  const t = fixture('eq-2415.xml');
  const h = hover(run(t), t.indexOf('cim:ACLineSegment.r>') + 5);
  assert.ok(h);
  assert.match(h!.markdown, /Resistance \(Float, ohm\)/);
  assert.match(h!.markdown, /1\.\.1/);
});

test('empty document offers profile skeletons', () => {
  const items = complete(run('<'), 1, { insertRequired: true });
  assert.ok(items.some(i => i.label === 'CGMES 2.4.15 EQ document'));
  assert.ok(items.some(i => i.label === 'NC profiles 2.2 RA document'));
  const eq = items.find(i => i.label === 'CGMES 2.4.15 EQ document')!;
  assert.match(eq.insertText, /xmlns:cim="http:\/\/iec.ch\/TC57\/2013\/CIM-schema-cim16#"/);
  assert.match(eq.insertText, /EquipmentCore\/3\/1/);
});

test('NCP 2.2 PropertyReference values are checked by property name only', () => {
  const doc = (values: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:nc="http://entsoe.eu/ns/nc#" xmlns:md="http://iec.ch/TC57/61970-552/ModelDescription/1#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <md:FullModel rdf:about="urn:uuid:2bfc1c0e-6b39-4e5c-9a7e-3f3b0d2c6a12">
    <md:Model.profile>http://entsoe.eu/ns/CIM/RemedialAction-EU/2.2</md:Model.profile>
  </md:FullModel>
${values.map((v, i) => `  <nc:PinEquipment rdf:about="urn:uuid:8f0d4f5e-2d43-4d39-9a3c-1d2a6e4b000${i}">
    <nc:PinEquipment.PropertyReference rdf:resource="${v}"/>
  </nc:PinEquipment>`).join('\n')}
</rdf:RDF>`;
  const values = [
    'http://energy.referencedata.eu/PropertyReference/Switch.open',
    'http://energy.referencedata.eu/PropertyReference#Switch.open',
    'https://example.org/other/Switch.open',
    'http://energy.referencedata.eu/PropertyReference/Switch.opne',
    'http://energy.referencedata.eu/PropertyReference/',
  ];
  const codes = (ps: ReturnType<typeof validate>) => ps.filter(p => p.code === 'property-reference');

  // With a list: namespace ignored, the name must be in the list.
  const list = parsePropertyReferenceList(`<rdf:Description rdf:about="http://energy.referencedata.eu/PropertyReference/Switch.open"/>
    <rdf:Description rdf:about="http://energy.referencedata.eu/PropertyReference/RotatingMachine.p"/>`, 'test.rdf');
  assert.deepEqual(list.names, ['RotatingMachine.p', 'Switch.open']);
  const a = analyze(doc(values), { indexes, propertyReferences: list });
  const ps = codes(validate(a));
  assert.equal(ps.length, 2);
  assert.match(ps[0].message, /Switch\.opne is not in the PropertyReference list.*Did you mean Switch\.open/);
  assert.deepEqual(ps[0].data?.replacements, ['http://energy.referencedata.eu/PropertyReference/Switch.open']);
  assert.match(ps[1].message, /must end with a property name/);
  assert.equal(validate(a).filter(p => p.code === 'unresolved-reference').length, 0);

  // Without a list: names are checked against the properties of the loaded profiles.
  const b = run(doc(values.slice(0, 4)));
  const fallback = codes(validate(b));
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].severity, 'warning');

  // Plain-text lists and completion.
  assert.deepEqual(parsePropertyReferenceList('name\nSwitch.open\nTapChanger.step\n', 'x.csv').names, ['Switch.open', 'TapChanger.step']);
  const text = doc(['http://energy.referencedata.eu/PropertyReference/Sw']);
  const items = complete(analyze(text, { indexes, propertyReferences: list }), text.indexOf('/Sw"') + 3, { insertRequired: false });
  assert.deepEqual(items.map(i => i.insertText), ['http://energy.referencedata.eu/PropertyReference/RotatingMachine.p', 'http://energy.referencedata.eu/PropertyReference/Switch.open']);
});

test('the bundled ENTSO-E PropertyReference list is read from its prov:hadMember URIs', () => {
  const list = parsePropertyReferenceList(fs.readFileSync(path.resolve(__dirname, '..', '..', 'profiles', 'property-references.rdf'), 'utf8'), 'property-references.rdf');
  assert.ok(list.names.length > 150);
  for (const n of ['Switch.open', 'RotatingMachine.p', 'RemedialAction.available', 'TapChanger.step']) assert.ok(list.set.has(n), n);
  assert.ok(!list.set.has('NCP'));
});

test('CGMES 2.4.15 SHACL: tap changer must reference a PowerTransformerEnd', () => {
  const eq = indexes[0].profile('EQ')!;
  const p = Object.values(eq.properties).find(x => x.label === 'RatioTapChanger.TransformerEnd')!;
  assert.deepEqual(p.shacl?.class?.map(c => c.split('#')[1]), ['PowerTransformerEnd']);
});

test('problems say whether the rule comes from the RDFS schema, SHACL or the file', () => {
  const head = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:cim="http://iec.ch/TC57/2013/CIM-schema-cim16#" xmlns:md="http://iec.ch/TC57/61970-552/ModelDescription/1#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <md:FullModel rdf:about="urn:uuid:2bfc1c0e-6b39-4e5c-9a7e-3f3b0d2c6a12">
    <md:Model.profile>http://entsoe.eu/CIM/EquipmentCore/3/1</md:Model.profile>
  </md:FullModel>`;
  const text = `${head}
  <cim:TransformerEnd rdf:ID="_e1"/>
  <cim:RatioTapChanger rdf:ID="_r1">
    <cim:RatioTapChanger.TransformerEnd rdf:resource="#_e1"/>
    <cim:TapChanger.highStep>abc</cim:TapChanger.highStep>
  </cim:RatioTapChanger>
</rdf:RDF>`;
  const ps = validate(run(text));
  const rt = ps.find(p => p.code === 'reference-type')!;
  assert.equal(rt.rule, 'shacl');
  assert.match(rt.message, /SHACL requires RatioTapChanger.TransformerEnd to reference a PowerTransformerEnd/);
  const dt = ps.find(p => p.code === 'datatype')!;
  assert.deepEqual(dt.rules, ['schema', 'shacl']);
  assert.match(dt.message, /\[also SHACL sh:datatype xsd:integer:\s+The datatype is not literal/);
  assert.deepEqual(rt.rules, ['shacl']);
  assert.equal(ps.find(p => p.code === 'id-uuid')!.rule, 'file');
  assert.ok(ps.every(p => p.rule));
});

test('the editor gets one summary for many cross-file references and never more than 1000 problems', () => {
  const mk = (n: number, code: string, severity: 'error' | 'hint') => Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1, severity, code, message: code }));
  const anchor = { start: 0, end: 1 };
  const refs = problemsForEditor([...mk(3264, 'unresolved-reference', 'hint'), ...mk(2, 'datatype', 'error')], anchor);
  assert.equal(refs.length, 3);
  assert.match(refs.find(p => p.code === 'unresolved-reference')!.message, /^3264 references point to objects that are not in this file/);
  const many = problemsForEditor([...mk(900, 'id-uuid', 'hint'), ...mk(300, 'datatype', 'error')], anchor);
  assert.equal(many.length, 1000);
  assert.equal(many.filter(p => p.code === 'datatype').length, 300);
  assert.match(many[many.length - 1].message, /^201 more issues/);
});

// ---- Cross-file references ----------------------------------------------------------------
import { ObjectScanner, datasetLookup, dependencyClosure, normalizeRef, objectsFromAnalysis, scanObjects } from '../src/core/crossIndex';

const CIM16 = 'xmlns:cim="http://iec.ch/TC57/2013/CIM-schema-cim16#" xmlns:md="http://iec.ch/TC57/61970-552/ModelDescription/1#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';
const header = (id: string, profile: string, deps: string[] = []) =>
  `<md:FullModel rdf:about="urn:uuid:${id}"><md:Model.profile>${profile}</md:Model.profile>${deps.map(d => `<md:Model.DependentOn rdf:resource="urn:uuid:${d}"/>`).join('')}</md:FullModel>`;
const EQ_ID = '11111111-1111-4111-8111-111111111111';
const EQ = `<rdf:RDF ${CIM16}>${header(EQ_ID, 'http://entsoe.eu/CIM/EquipmentCore/3/1')}
  <cim:BaseVoltage rdf:ID="_bv1"><cim:BaseVoltage.nominalVoltage>400</cim:BaseVoltage.nominalVoltage></cim:BaseVoltage>
  <cim:ACLineSegment rdf:ID="_line1"><cim:IdentifiedObject.name>L1</cim:IdentifiedObject.name></cim:ACLineSegment>
  <cim:Substation rdf:ID="_sub1"/>
</rdf:RDF>`;
const tp = (deps: string[]) => `<rdf:RDF ${CIM16}>${header('22222222-2222-4222-8222-222222222222', 'http://entsoe.eu/CIM/Topology/4/1', deps)}
  <cim:TopologicalNode rdf:ID="_tn1">
    <cim:IdentifiedObject.name>TN1</cim:IdentifiedObject.name>
    <cim:TopologicalNode.BaseVoltage rdf:resource="#_line1"/>
    <cim:TopologicalNode.ConnectivityNodeContainer rdf:resource="#_nowhere"/>
  </cim:TopologicalNode>
  <cim:TopologicalNode rdf:ID="_tn2">
    <cim:IdentifiedObject.name>TN2</cim:IdentifiedObject.name>
    <cim:TopologicalNode.BaseVoltage rdf:resource="#_bv1"/>
    <cim:TopologicalNode.ConnectivityNodeContainer rdf:resource="#_sub1"/>
  </cim:TopologicalNode>
</rdf:RDF>`;

test('cross-file identifiers are compared in one form', () => {
  for (const v of ['#_ABC-1', '_abc-1', 'urn:uuid:abc-1', '#abc-1']) assert.equal(normalizeRef(v), 'abc-1');
  assert.equal(normalizeRef('http://entsoe.eu/x#y'), undefined);
});

test('scanObjects reads ids, classes and the model id without a full parse', async () => {
  const o = (await scanObjects(EQ, 'eq.xml'))!;
  assert.equal(o.ids.size, 3);
  assert.equal(o.types[o.ids.get('line1')!], 'http://iec.ch/TC57/2013/CIM-schema-cim16#ACLineSegment');
  assert.deepEqual(o.models, [EQ_ID]);
  // The live form (from an open editor) agrees with the scan.
  const live = objectsFromAnalysis(run(EQ), 'eq.xml');
  assert.deepEqual([...live.ids.keys()].sort(), [...o.ids.keys()].sort());
  assert.deepEqual(live.models, [EQ_ID]);
});

test('references into another file: wrong class and dangling are reported', async () => {
  const dataset = datasetLookup([(await scanObjects(EQ, 'eq.xml'))!], 'tp.xml');
  const a = analyze(tp([EQ_ID]), { indexes, dataset });
  const ps = validate(a);
  const wrong = ps.filter(p => p.code === 'reference-type');
  assert.equal(wrong.length, 1, JSON.stringify(ps.map(p => p.message)));
  assert.match(wrong[0].message, /ACLineSegment \(defined in eq\.xml\)/);
  const dangling = ps.filter(p => p.code === 'dangling-reference');
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].rule, 'dataset');
  assert.equal(dangling[0].severity, 'warning');
  assert.match(dangling[0].message, /#_nowhere/);
  assert.ok(!ps.some(p => p.code === 'unresolved-reference'));
  assert.ok(!validate(a, { ...DEFAULT_VALIDATE_OPTIONS, danglingReferences: 'off' }).some(p => p.code === 'dangling-reference'));
});

test('a dependency missing from the folder (boundary) keeps references unresolved, not dangling', async () => {
  const dataset = datasetLookup([(await scanObjects(EQ, 'eq.xml'))!], 'tp.xml');
  const ps = validate(analyze(tp([EQ_ID, '99999999-9999-4999-8999-999999999999']), { indexes, dataset }));
  assert.ok(!ps.some(p => p.code === 'dangling-reference'));
  const u = ps.find(p => p.code === 'unresolved-reference')!;
  assert.match(u.message, /depends on/);
  // The wrong class is still found.
  assert.ok(ps.some(p => p.code === 'reference-type'));
});

test('NC file pointing into a CGMES 2.4.15 EQ: classes matched by name across versions', async () => {
  const ae = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:nc="http://entsoe.eu/ns/nc#" xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:dcterms="http://purl.org/dc/terms/#" xmlns:md="http://iec.ch/TC57/61970-552/ModelDescription/1#">
  <md:FullModel rdf:about="urn:uuid:33333333-3333-4333-8333-333333333333"><dcterms:conformsTo>http://entsoe.eu/ns/CIM/AssessedElement-EU/2.2</dcterms:conformsTo><md:Model.DependentOn rdf:resource="urn:uuid:${EQ_ID}"/></md:FullModel>
  <nc:AssessedElement rdf:ID="_ae1"><nc:AssessedElement.ConductingEquipment rdf:resource="#_bv1"/></nc:AssessedElement>
  <nc:AssessedElement rdf:ID="_ae2"><nc:AssessedElement.ConductingEquipment rdf:resource="#_line1"/></nc:AssessedElement>
  <nc:AssessedElement rdf:ID="_ae3"><nc:AssessedElement.ConductingEquipment rdf:resource="#_gone"/></nc:AssessedElement>
</rdf:RDF>`;
  const dataset = datasetLookup([(await scanObjects(EQ, 'eq.xml'))!], 'ae.xml');
  const ps = validate(analyze(ae, { indexes, dataset }));
  const wrong = ps.filter(p => p.code === 'reference-type');
  assert.equal(wrong.length, 1, JSON.stringify(ps.map(p => p.message)));
  assert.match(wrong[0].message, /#_bv1 is a BaseVoltage/);
  assert.equal(ps.filter(p => p.code === 'dangling-reference').length, 1);
});

test('the scanner gives the same result whatever the pieces the file is read in', async () => {
  const whole = (await scanObjects(EQ, 'eq.xml'))!;
  for (const size of [1, 7, 64, 333]) {
    const s = new ObjectScanner('eq.xml');
    for (let i = 0; i < EQ.length; i += size) s.push(EQ.slice(i, i + size));
    const o = s.end()!;
    assert.deepEqual([...o.ids.entries()].map(([k, t]) => [k, o.types[t]]), [...whole.ids.entries()].map(([k, t]) => [k, whole.types[t]]), `size ${size}`);
    assert.deepEqual(o.models, whole.models);
  }
  const notCim = new ObjectScanner('x.xml');
  notCim.push('<root>' + ' '.repeat(30000) + '</root>');
  assert.equal(notCim.end(), undefined);
});

test('SSH objects described with rdf:about must exist in the EQ, with the same class', async () => {
  const ssh = `<rdf:RDF ${CIM16}>${header('44444444-4444-4444-8444-444444444444', 'http://entsoe.eu/CIM/SteadyStateHypothesis/1/1', [EQ_ID])}
  <cim:ACLineSegment rdf:about="#_line1"/>
  <cim:EnergyConsumer rdf:about="#_bv1"><cim:EnergyConsumer.p>1</cim:EnergyConsumer.p></cim:EnergyConsumer>
  <cim:EnergyConsumer rdf:about="#_ghost"><cim:EnergyConsumer.p>1</cim:EnergyConsumer.p></cim:EnergyConsumer>
</rdf:RDF>`;
  const dataset = datasetLookup([(await scanObjects(EQ, 'eq.xml'))!], 'ssh.xml');
  const ps = validate(analyze(ssh, { indexes, dataset })).filter(p => p.code === 'reference-type' || p.code === 'dangling-reference');
  assert.deepEqual(ps.map(p => p.code).sort(), ['dangling-reference', 'reference-type']);
  assert.match(ps.find(p => p.code === 'reference-type')!.message, /described here as an EnergyConsumer, but it is a BaseVoltage in eq\.xml/);
  assert.match(ps.find(p => p.code === 'dangling-reference')!.message, /#_ghost/);
});

test('the scanner reads the header: dependencies, profile and time', async () => {
  const text = tp([EQ_ID, '99999999-9999-4999-8999-999999999999']).replace('</md:FullModel>', '<md:Model.scenarioTime>2024-05-01T10:30:00Z</md:Model.scenarioTime></md:FullModel>');
  for (const size of [5, 100000]) {
    const s = new ObjectScanner('tp.xml');
    for (let i = 0; i < text.length; i += size) s.push(text.slice(i, i + size));
    const o = s.end()!;
    assert.deepEqual(o.dependsOn, [EQ_ID, '99999999-9999-4999-8999-999999999999']);
    assert.deepEqual(o.profiles, ['http://entsoe.eu/CIM/Topology/4/1']);
    assert.equal(o.time, '2024-05-01T10:30:00Z');
  }
  assert.deepEqual(objectsFromAnalysis(run(text), 'tp.xml').dependsOn, [EQ_ID, '99999999-9999-4999-8999-999999999999']);
});

test('automatic dataset: dependencies are followed from model to model and preferred', async () => {
  const eq = (await scanObjects(EQ, 'eq.xml'))!;
  // Another EQ in the folder (another version) defines _line1 as a BaseVoltage.
  const other = (await scanObjects(EQ.replace(EQ_ID, '55555555-5555-4555-8555-555555555555').replace('cim:ACLineSegment rdf:ID="_line1"', 'cim:BaseVoltage rdf:ID="_line1"').replace('</cim:ACLineSegment>', '</cim:BaseVoltage>'), 'eq-old.xml'))!;
  const tpo = (await scanObjects(tp([EQ_ID]), 'tp.xml'))!;
  const sv = { file: 'sv.xml', types: [], ids: new Map<string, number>(), models: ['sv'], dependsOn: ['22222222-2222-4222-8222-222222222222'] };
  const closure = dependencyClosure(sv.dependsOn, [eq, other, tpo]);
  assert.deepEqual(closure.files.map(f => f.file), ['tp.xml', 'eq.xml']);
  assert.deepEqual(closure.missing, []);
  const preferred = new Set(['eq.xml']);
  const ps = validate(analyze(tp([EQ_ID]), { indexes, dataset: datasetLookup([eq, other], 'tp.xml', preferred) }));
  // _line1 is taken from the EQ the TP depends on (an ACLineSegment), so it is still the wrong class.
  assert.ok(ps.some(p => p.code === 'reference-type' && /ACLineSegment \(defined in eq\.xml\)/.test(p.message)), JSON.stringify(ps.map(p => p.message)));
  // Without the preference both files answer, and the old EQ's class makes the reference acceptable.
  const loose = validate(analyze(tp([EQ_ID]), { indexes, dataset: datasetLookup([eq, other], 'tp.xml') }));
  assert.ok(!loose.some(p => p.code === 'reference-type' && /#_line1/.test(p.message)));
});

test('elementAt finds the innermost element at any offset (binary search)', () => {
  const text = fixture('eq-2415.xml');
  const doc = parseXml(text);
  const linear = (offset: number) => {
    let found; let list = doc.roots;
    for (;;) {
      let next;
      for (const el of list) {
        const end = el.end >= 0 ? el.end : (el.startTagEnd >= 0 && el.selfClosing ? el.startTagEnd : Number.MAX_SAFE_INTEGER);
        if (offset >= el.start && offset < end) next = el;
        if (el.start > offset) break;
      }
      if (!next) return found;
      found = next; list = next.children;
    }
  };
  for (let o = 0; o < text.length; o += 7) assert.equal(elementAt(doc, o), linear(o), `offset ${o}`);
});

test('a model missing further down the dependencies (TP -> EQ -> boundary) keeps references unresolved', async () => {
  const eqWithBoundary = EQ.replace('</md:Model.profile>', '</md:Model.profile><md:Model.DependentOn rdf:resource="urn:uuid:77777777-7777-4777-8777-777777777777"/>');
  const eq = (await scanObjects(eqWithBoundary, 'eq.xml'))!;
  const missing = dependencyClosure([EQ_ID], [eq]).missing;
  assert.deepEqual(missing, ['77777777-7777-4777-8777-777777777777']);
  const ps = validate(analyze(tp([EQ_ID]), { indexes, dataset: datasetLookup([eq], 'tp.xml', undefined, undefined, missing.map(m => `urn:uuid:${m}`)) }));
  assert.ok(!ps.some(p => p.code === 'dangling-reference'));
  assert.ok(ps.some(p => p.code === 'unresolved-reference' && /77777777/.test(p.message)));
});

test('the identifier hint says what is off and shows the expected format', () => {
  const m = explainUuid('_3c3b5330-e94e-444e-965b-688e0d1a88eb_LA_SLA_CLG', '_')!;
  assert.match(m.split('\n')[0], /extra text "_LA_SLA_CLG" after the UUID/);
  assert.match(m, /Expected: _xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/);
  assert.equal(explainUuid('_3c3b5330-e94e-444e-965b-688e0d1a88eb', '_'), undefined);
  assert.match(explainUuid('_3c3b5330e94e444e965b688e0d1a88eb', '_')!, /no dashes \(expected _3c3b5330-e94e-444e-965b-688e0d1a88eb\)/);
  assert.match(explainUuid('_3c3b533-e94e-444e-965b-688e0d1a88eg', '_')!, /group 1 "3c3b533" has 7 characters, expected 8; group 5 "688e0d1a88eg" has non-hexadecimal "g"/);
  assert.match(explainUuid('3c3b5330-e94e-444e-965b-688e0d1a88eb', '_')!, /does not start with "_"/);
  assert.match(explainUuid('urn:uuid:3c3b5330-e94e-444e-965b-688e0d1a88eb-x', 'urn:uuid:')!, /extra text "-x" after the UUID/);
});

test('NC references accept the classes their SHACL value type lists, from CGMES 2.4.15 or 3.0 (CurrentLimit as an OperationalLimit)', async () => {
  const eq2415 = `<rdf:RDF ${CIM16}><cim:CurrentLimit rdf:ID="_cl16"/></rdf:RDF>`;
  const eq30 = `<rdf:RDF xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <cim:CurrentLimit rdf:ID="_cl30"/><cim:Terminal rdf:ID="_t30"/></rdf:RDF>`;
  const pin = (id: string, target: string) => `<nc:PinOperationalLimit rdf:about="urn:uuid:${id}"><nc:PinOperationalLimit.OperationalLimit rdf:resource="#${target}"/></nc:PinOperationalLimit>`;
  const ra = fixture('ra-25.xml').replace('</rdf:RDF>', [
    pin('a1a1a1a1-0000-4000-8000-000000000001', '_cl16'),
    pin('a1a1a1a1-0000-4000-8000-000000000002', '_cl30'),
    pin('a1a1a1a1-0000-4000-8000-000000000003', '_t30'),
  ].join('\n') + '\n</rdf:RDF>');
  const dataset = datasetLookup([(await scanObjects(eq2415, 'eq2415.xml'))!, (await scanObjects(eq30, 'eq30.xml'))!], 'ra.xml');
  const wrong = validate(analyze(ra, { indexes, dataset })).filter(p => p.code === 'reference-type');
  assert.equal(wrong.length, 1, JSON.stringify(wrong.map(p => p.message)));
  assert.match(wrong[0].message, /#_t30 is a Terminal \(defined in eq30\.xml\)/);
  assert.match(wrong[0].message, /also SHACL sh:in .*CurrentLimit/);
  assert.deepEqual(wrong[0].rules, ['schema', 'shacl']);
});
