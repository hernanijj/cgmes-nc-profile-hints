import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { fixture, indexes, run } from './helpers';
import { analyze, looksLikeCim } from '../src/core/analysis';
import { parsePropertyReferenceList } from '../src/core/propertyReference';
import { DEFAULT_VALIDATE_OPTIONS, explainUuid, problemsForEditor, validate } from '../src/core/validate';
import { complete } from '../src/core/complete';
import { hover, referencesTo } from '../src/core/hover';
import { parseXml, elementAt } from '../src/core/xml';

const codes = (text: string) => validate(run(text)).map(p => p.code);

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
  const at = t.indexOf('rdf:resource="#_7e4b1f2a-1c1d-4e7b-9a10-0b6f8b0f0001"/>\n    <cim:ACLineSegment.foo') + 'rdf:resource="'.length;
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
  const off = validate(a, { ...DEFAULT_VALIDATE_OPTIONS, propertyReferences: false });
  assert.equal(codes(off).length, 0);
  assert.equal(off.filter(p => p.code === 'unresolved-reference').length, 0);

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
import { ObjectScanner, datasetLookup, dependencyClosure, normalizeRef, objectsFromAnalysis, scanObjects, scanReferenceLocations } from '../src/core/crossIndex';

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
  assert.equal(o.objectOffsets.get('line1'), EQ.indexOf('<cim:ACLineSegment rdf:ID="_line1"'));
  assert.deepEqual(o.models, [EQ_ID]);
  // The live form (from an open editor) agrees with the scan.
  const live = objectsFromAnalysis(run(EQ), 'eq.xml');
  assert.deepEqual([...live.ids.keys()].sort(), [...o.ids.keys()].sort());
  assert.equal(live.objectOffsets.get('line1'), o.objectOffsets.get('line1'));
  assert.deepEqual(live.models, [EQ_ID]);
});

test('the scanner indexes references and locates them across chunks', async () => {
  const text = tp([EQ_ID]);
  const parsed = analyze(text, { indexes });
  const localReferences = referencesTo(parsed, 'urn:uuid:line1');
  assert.equal(localReferences.length, 1);
  assert.equal(text.slice(localReferences[0].start, localReferences[0].end), '#_line1');
  const uri = 'http://example.org/object#remote';
  const absolute = `<rdf:RDF xmlns:cim="http://iec.ch/TC57/2013/CIM-schema-cim16#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><cim:BaseVoltage rdf:about="${uri}"><cim:BaseVoltage.BaseVoltage rdf:resource="${uri}"/></cim:BaseVoltage></rdf:RDF>`;
  assert.equal(referencesTo(analyze(absolute, { indexes }), uri).length, 1);

  const indexed = new ObjectScanner('tp.xml');
  for (let i = 0; i < text.length; i += 23) indexed.push(text.slice(i, i + 23));
  const objects = indexed.end()!;
  assert.ok(objects.references.has('line1'));

  const target = new ObjectScanner('tp.xml', 'line1');
  for (let i = 0; i < text.length; i += 23) target.push(text.slice(i, i + 23));
  target.end();
  const offset = text.indexOf('#_line1');
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) ?? []).length;
  const character = offset - before.lastIndexOf('\n') - 1;
  assert.deepEqual(target.referenceLocations, [{ offset, line, character, length: '#_line1'.length }]);

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cgmes-nav-'));
  const file = path.join(folder, 'tp.xml');
  try {
    fs.writeFileSync(file, text);
    assert.deepEqual(await scanReferenceLocations(file, '#_line1'), [{ offset, line, character, length: '#_line1'.length }]);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
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
  const sv = { file: 'sv.xml', types: [], ids: new Map<string, number>(), objectOffsets: new Map<string, number>(), references: new Set<string>(), models: ['sv'], dependsOn: ['22222222-2222-4222-8222-222222222222'] };
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

test('CGMES 3.0 EQ: version and profiles come from the header, required properties from RDFS and SHACL', () => {
  const a = run(fixture('eq-30.xml'));
  assert.equal(a.index?.bundle.id, 'cgmes-3.0');
  assert.deepEqual(a.active.map(p => p.keyword), ['EQ', 'OP']);
  assert.equal(a.idStyle, 'rdfID');
  // The ConnectivityNode's container lives in another file: only a hint.
  const ps = validate(a).filter(p => p.code !== 'unresolved-reference');
  assert.deepEqual(ps.map(p => p.code), ['missing-required'], ps.map(p => p.message).join('\n'));
  assert.match(ps[0].message, /ACLineSegment\.x/);
});

test('CGMES 3.0 SSH is told apart from 2.4.15 SSH by its header, not only by the profile name', () => {
  const a = run(fixture('ssh-30.xml'));
  assert.equal(a.index?.bundle.id, 'cgmes-3.0');
  assert.deepEqual(a.active.map(p => p.keyword), ['SSH']);
  assert.deepEqual(validate(a), []);
  // A 2.4.15 SSH header still picks 2.4.15.
  const old = fixture('ssh-30.xml')
    .replace('http://iec.ch/TC57/ns/CIM/SteadyStateHypothesis-EU/3.0', 'http://entsoe.eu/CIM/SteadyStateHypothesis/1/1')
    .replace('http://iec.ch/TC57/CIM100#', 'http://iec.ch/TC57/2013/CIM-schema-cim16#');
  assert.equal(run(old).index?.bundle.id, 'cgmes-2.4.15');
  // No header: the namespace and the classes decide between CGMES 3.0 and the NC profiles (both CIM100).
  const noHeader = fixture('eq-30.xml').replace(/<md:FullModel[\s\S]*<\/md:FullModel>/, '');
  assert.equal(run(noHeader).index?.bundle.id, 'cgmes-3.0');
});

test('CGMES 3.0 conditional (Complex) SHACL rules do not make properties required', () => {
  const i = indexes.find(x => x.bundle.id === 'cgmes-3.0')!;
  const C = 'http://iec.ch/TC57/CIM100#';
  // 61970-600-1 Equipment Complex: Terminal.ConnectivityNode only for node-breaker models.
  assert.equal(i.propDef(C + 'Terminal.ConnectivityNode')?.shacl?.minCount, undefined);
  // 61970-600-1 Prof10 Header Complex: DependentOn only for some profiles.
  assert.equal(i.propDef('http://iec.ch/TC57/61970-552/ModelDescription/1#Model.DependentOn')?.shacl?.minCount, undefined);
  // The header SHACL (61970-552-Header-...) applies to the header profile.
  assert.equal(i.propDef('http://iec.ch/TC57/61970-552/ModelDescription/1#Model.description')?.shacl?.minCount, 1);
  // Value rules of Complex files are kept, e.g. a positive nominal voltage.
  assert.ok(i.propDef(C + 'BaseVoltage.nominalVoltage')?.shacl?.minExclusive !== undefined);
  const missing = validate(run(fixture('eq-30.xml').replace(/<cim:BaseVoltage\.nominalVoltage>380/, '<cim:BaseVoltage.nominalVoltage>-5')));
  assert.ok(missing.some(p => p.code === 'range' && /nominalVoltage/.test(p.message)), missing.map(p => p.message).join('\n'));
});

test('an NC file pointing into a CGMES 3.0 EQ has its references judged with the CGMES 3.0 classes', async () => {
  const eq = (await scanObjects(fixture('eq-30.xml'), 'eq.xml'))!;
  const ae = (target: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:nc="http://entsoe.eu/ns/nc#" xmlns:dcat="http://www.w3.org/ns/dcat#" xmlns:dcterms="http://purl.org/dc/terms/#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <dcat:Dataset rdf:about="urn:uuid:1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6">
    <dcterms:conformsTo>http://entsoe.eu/ns/CIM/AssessedElement-EU/2.2</dcterms:conformsTo>
  </dcat:Dataset>
  <nc:AssessedElement rdf:about="urn:uuid:2e3f4a5b-6c7d-4e8f-9a01-b2c3d4e5f6a7">
    <nc:AssessedElement.ConductingEquipment rdf:resource="urn:uuid:${target}"/>
  </nc:AssessedElement>
</rdf:RDF>`;
  const typeErrors = (target: string) => validate(analyze(ae(target), { indexes, dataset: datasetLookup([eq], 'ae.xml') }))
    .filter(p => p.code === 'reference-type').map(p => p.message);
  // The line is a ConductingEquipment in CGMES 3.0 (the NC profiles do not know ACLineSegment).
  assert.deepEqual(typeErrors('0d3e2f1a-4b5c-4d6e-9f70-8a9b0c1d2e03'), []);
  // A ConnectivityNode (not known to the NC profiles either) is not.
  assert.match(typeErrors('7c6b5a4f-3e2d-4c1b-9a0f-8e7d6c5b4a05').join('\n'), /must reference a ConductingEquipment, but .* is a ConnectivityNode \(defined in eq\.xml\)/);
});
