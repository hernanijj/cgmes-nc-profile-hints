import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {Engine,byteOffset,utf16Offset,expandSnippet,snippet} from '../src/worker';
const root=path.resolve(__dirname,'../..');

test('NCP 2.4 is offered for versions, profiles and new documents',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgmes-ncp24-'));
 try {
  const engine=new Engine(root,path.join(tmp,'settings.json'));
  const r={id:1,revision:0,file:path.join(tmp,'ae.xml'),text:'',position:0,command:'versions'};
  const versions=await engine.handle(r);
  assert.ok(versions.items.some((i:any)=>i.argument?.version==='ncp-2.4'));
  const profiles=await engine.handle({...r,command:'profiles'});
  const choice=profiles.items.find((i:any)=>i.argument?.version==='ncp-2.4' && i.argument.profiles?.[0]==='AE');
  assert.ok(choice);
  await engine.handle({...r,command:choice.command,argument:choice.argument});
  assert.deepEqual(new Engine(root,path.join(tmp,'settings.json')).overrides[r.file],{version:'ncp-2.4',profiles:['AE']});
  const docs=await engine.handle({...r,command:'new'});
  const doc=docs.items.find((i:any)=>i.label==='NC profiles 2.4 / AE');
  assert.ok(doc);
  const text=doc.argument.text;
  assert.match(text,/xmlns:dcat="http:\/\/www\.w3\.org\/ns\/dcat#"/);
  assert.match(text,/xmlns:dcterms="http:\/\/purl\.org\/dc\/terms\/"/);
  assert.match(text,/<dcat:Dataset rdf:(?:ID="_[0-9a-f-]+"|about="urn:uuid:[0-9a-f-]+")>/);
  assert.match(text,/<dcterms:conformsTo>https:\/\/ap-voc\.cim4\.eu\/DatasetMetadata\/3\.0<\/dcterms:conformsTo>/);
  assert.match(text,/<dcterms:conformsTo>https:\/\/ap-voc\.cim4\.eu\/AssessedElement\/2\.4<\/dcterms:conformsTo>/);
  for(const property of ['dcterms:identifier','dcat:isVersionOf','dcat:startDate','dcat:version']) assert.match(text,new RegExp(`<${property}(?:>|\\s)`));
  assert.match(text,/<dcat:version>1\.0\.0<\/dcat:version>/);
  assert.doesNotMatch(text,/<md:FullModel|xmlns:md=/);
  const selected=engine.analysis(text,path.join(tmp,'new-ae.xml'));
  assert.equal(selected.isCim,true);
  assert.equal(selected.index?.bundle.id,'ncp-2.4');
  assert.deepEqual(selected.active.map(p=>p.keyword).sort(),['AE','DM']);
  const validation=await engine.handle({...r,file:path.join(tmp,'new-ae.xml'),text,command:'validate'});
  assert.ok(!validation.items.some((i:any)=>['xml','undeclared-prefix','unknown-header-profile'].includes(i.code)));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('worker honors validation.propertyReferences for files and selected datasets',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgmes-property-reference-'));
 try {
  const file=path.join(tmp,'a.xml'), sibling=path.join(tmp,'b.xml');
  const text='<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:nc="http://entsoe.eu/ns/nc#" xmlns:md="http://iec.ch/TC57/61970-552/ModelDescription/1#"><md:FullModel rdf:about="urn:uuid:model"><md:Model.profile>http://entsoe.eu/ns/CIM/RemedialAction-EU/2.2</md:Model.profile></md:FullModel><nc:PinEquipment rdf:about="urn:uuid:invalid"><nc:PinEquipment.PropertyReference rdf:resource="http://energy.referencedata.eu/PropertyReference/Switch.opne"/></nc:PinEquipment></rdf:RDF>';
  fs.writeFileSync(sibling,text);
  const config=path.join(tmp,'settings.json'), engine=new Engine(root,config);
  engine.selected=[file,sibling];
  const r={id:1,revision:0,file,text,position:0,command:'validateDataset'};
  const enabled=await engine.handle(r);
  assert.deepEqual(enabled.items.filter((i:any)=>i.code==='property-reference').map((i:any)=>i.file).sort(),[file,sibling].sort());
  engine.settings['validation.propertyReferences']=false;engine.save();
  const disabled=await new Engine(root,config).handle(r);
  assert.deepEqual(disabled.items,enabled.items.filter((i:any)=>i.code!=='property-reference'));
  assert.ok(disabled.items.length>0);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('schema folders skip RDF SHACL by filename and content without stdout output',(t)=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgmes-schema-'));
 try {
  const folder=path.join(tmp,'schemas');fs.mkdirSync(folder);
  const wrap=(body:string)=>`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:owl="http://www.w3.org/2002/07/owl#" xmlns:dcat="http://www.w3.org/ns/dcat#" xmlns:sh="http://www.w3.org/ns/shacl#"><rdfs:Class rdf:about="https://example.org/Equipment"/>${body}</rdf:RDF>`;
  fs.writeFileSync(path.join(folder,'AssessedElementProfile.rdf'),wrap('<owl:Ontology rdf:about="https://example.org/AE"><dcat:keyword>AE</dcat:keyword></owl:Ontology>'));
  fs.writeFileSync(path.join(folder,'Named_ShAcL.rdf'),wrap(''));
  fs.writeFileSync(path.join(folder,'Node.rdf'),wrap('<sh:NodeShape rdf:about="https://example.org/node"/>'));
  fs.writeFileSync(path.join(folder,'Property.rdf'),wrap('<sh:PropertyShape rdf:about="https://example.org/property"/>'));
  const config=path.join(tmp,'settings.json');
  fs.writeFileSync(config,JSON.stringify({schemaFolders:[{folder,id:'ncp-2.4',family:'NCP',version:'2.4'}]}));
  const stdout=t.mock.method(process.stdout,'write',()=>true);
  let engine:Engine;
  try{engine=new Engine(root,config);}finally{stdout.mock.restore();}
  assert.equal(stdout.mock.callCount(),0);
  const custom=engine.indexes.filter(i=>i.bundle.id==='ncp-2.4');
  assert.equal(custom.length,1);
  assert.deepEqual(custom[0].profiles.map(p=>p.keyword),['AE']);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('UTF-8 editor positions round-trip Unicode including astral characters',()=>{const text='ação ⚡ 😀 <cim:X>';for(const index of [0,1,4,5,7,10,text.length])assert.equal(utf16Offset(text,byteOffset(text,index)),index);});
test('snippet expansion preserves values and removes VS Code syntax',()=>{assert.equal(expandSnippet('${1:name} ${2|true,false|} ${3} $0 \\$x'),'name true   $x');});
test('snippet fields preserve byte ranges, choices and linked defaults',()=>{
 const s=snippet('é ${1:😀} ${2|true,false|} ${1} $0');
 assert.equal(s.text,'é 😀 true 😀 ');assert.deepEqual(s.fields.map(f=>f.index),[1,2,1,0]);
 assert.deepEqual(s.fields[0],{index:1,start:3,end:7});
 assert.deepEqual(s.fields[1].choices,['true','false']);
 assert.equal(Buffer.from(s.text).subarray(s.fields[2].start,s.fields[2].end).toString(),'😀');
});
test('worker engine supports profile choices, completions, diagnostics and persistent overrides',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgmes-npp-'));try{
 const engine=new Engine(root,path.join(tmp,'settings.json'));
 const r={id:1,command:'profiles',file:path.join(tmp,'file.xml'),text:'<',position:1,revision:0};
 const profiles=await engine.handle(r);assert.ok(profiles.items.length>5);
 const completions=await engine.handle({...r,command:'complete'});assert.ok(completions.items.length>5);assert.ok(completions.items.every((i:any)=>!i.edits[0].text.includes('${')));
 await engine.handle({...r,command:'setProfile',argument:{version:'cgmes-2.4.15',profiles:['EQ']}});
 const reopened=new Engine(root,path.join(tmp,'settings.json'));assert.deepEqual(reopened.overrides[r.file].profiles,['EQ']);
 const text=fs.readFileSync(path.join(root,'test/fixtures/eq-2415.xml'),'utf8');
 const result=await engine.handle({...r,text,position:0,command:'validate'});assert.ok(result.items.some((i:any)=>i.code==='datatype'));assert.ok(result.items.some((i:any)=>i.code==='missing-required'));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('unsupported RDF documents receive no CIM checks and expose an explicit status',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgmes-unsupported-'));
 try{
  const engine=new Engine(root,path.join(tmp,'settings.json'));
  const r={id:1,revision:0,file:path.join(tmp,'notes.rdf'),text:'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="urn:example:item"/></rdf:RDF>',position:10};
  const issues=await engine.handle({...r,command:'validate'});
  assert.deepEqual(issues.items,[]);
  assert.equal(issues.status,'Not a supported CIM file');
  assert.deepEqual((await engine.handle({...r,command:'validateDataset'})).items,[]);
  assert.deepEqual((await engine.handle({...r,command:'complete'})).items,[]);
  assert.equal((await engine.handle({...r,command:'hover'})).text,'');
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('only .xml CIM files are validated while other CIM extensions retain editor hints',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgmes-xml-only-validation-'));
 try{
  const engine=new Engine(root,path.join(tmp,'settings.json'));
  const text=fs.readFileSync(path.join(root,'test/fixtures/eq-2415.xml'),'utf8');
  const position=text.indexOf('cim:ACLineSegment')+5;
  for(const extension of ['rdf','cimxml']){
   const file=path.join(tmp,`model.${extension}`);
   const result=await engine.handle({id:1,revision:0,file,text,position,command:'validate'});
   assert.deepEqual(result.items,[]);
   assert.equal(result.status,'CIM validation requires a .xml file');
   assert.ok((await engine.handle({id:2,revision:0,file,text,position,command:'hover'})).text);
  }
  const xmlFile=path.join(tmp,'model.XML');
  const xmlResult=await engine.handle({id:3,revision:0,file:xmlFile,text,position,command:'validate'});
  assert.ok(xmlResult.items.length>0);
  assert.doesNotMatch(xmlResult.status,/requires a \.xml file/);

  const sibling=path.join(tmp,'sibling.rdf');fs.writeFileSync(sibling,text);
  engine.selected=[xmlFile,sibling];
  const dataset=await engine.handle({id:4,revision:0,file:xmlFile,text,position,command:'validateDataset'});
  assert.ok(dataset.items.length>0);
  assert.ok(dataset.items.every((item:any)=>item.file===xmlFile));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('open dataset selection lists open CIM files and restores the current selection',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgmes-open-dataset-'));
 try{
  const active=path.join(tmp,'active.xml'),sibling=path.join(tmp,'other folder','sibling.xml'),reference=path.join(tmp,'reference.rdf');
  const text=fs.readFileSync(path.join(root,'test/fixtures/eq-2415.xml'),'utf8');
  const engine=new Engine(root,path.join(tmp,'settings.json'));engine.selected=[sibling];
  const selection=await engine.handle({id:1,revision:0,file:active,text,position:0,command:'openDatasetSelection',buffers:[
   {file:sibling,text},{file:reference,text},{file:path.join(tmp,'notes.rdf'),text:'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>'}
  ]});
  assert.equal(selection.kind,'datasetSelection');
  assert.deepEqual(selection.items.map((item:any)=>item.file).sort(),[active,sibling,reference].sort());
  assert.equal(selection.items.find((item:any)=>item.file===sibling).checked,true);
  assert.equal(selection.items.find((item:any)=>item.file===active).checked,false);
  assert.match(selection.items.find((item:any)=>item.file===reference).label,/reference only/);
  await engine.handle({id:2,revision:0,file:active,text,position:0,command:'dataset',argument:[active,reference]});
  assert.deepEqual(new Engine(root,path.join(tmp,'settings.json')).selected,[active,reference]);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('mRID searches find definitions and references only in the selected dataset',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgmes-mrid-search-'));
 try{
  const definition=path.join(tmp,'eq.xml'),reference=path.join(tmp,'ssh.xml'),outside=path.join(tmp,'outside.xml');
  const wrap=(body:string)=>`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="http://iec.ch/TC57/2013/CIM-schema-cim16#">${body}</rdf:RDF>`;
  const definitionText=wrap('<cim:ACLineSegment rdf:ID="_line"/>');
  const referenceText=wrap('<cim:Terminal rdf:ID="_terminal"><cim:Terminal.ConductingEquipment rdf:resource="#_line"/></cim:Terminal>');
  const outsideText=wrap('<cim:Terminal rdf:ID="_outside"><cim:Terminal.ConductingEquipment rdf:resource="#_line"/></cim:Terminal>');
  const engine=new Engine(root,path.join(tmp,'settings.json'));engine.selected=[definition,reference];
  const r={id:1,revision:0,file:definition,text:definitionText,position:0,command:'findDefinitionById',argument:'urn:uuid:line',buffers:[{file:reference,text:referenceText},{file:outside,text:outsideText}]};
  const definitions=await engine.handle(r);
  assert.equal(definitions.kind,'searchResults');
  assert.equal(definitions.items.length,1);
  assert.equal(definitions.items[0].file,definition);
  assert.match(definitions.items[0].label,/ACLineSegment/);
  const references=await engine.handle({...r,command:'findReferencesById',argument:'#_line'});
  assert.equal(references.items.length,1);
  assert.equal(references.items[0].file,reference);
  assert.equal(Buffer.from(referenceText).subarray(references.items[0].start,references.items[0].end).toString(),'#_line');
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('selected dataset uses unsaved sibling content and detects disappeared targets',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgmes-dataset-'));
 try {
  const a=path.join(tmp,'a.xml'), b=path.join(tmp,'b.xml');
  const wrap=(s:string)=>`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="http://iec.ch/TC57/2013/CIM-schema-cim16#">${s}</rdf:RDF>`;
  const text=wrap('<cim:Terminal rdf:ID="_terminal"><cim:Terminal.ConductingEquipment rdf:resource="#_line"/></cim:Terminal>');
  fs.writeFileSync(a,text);fs.writeFileSync(b,wrap('<cim:ACLineSegment rdf:ID="_line"/>'));
  const engine=new Engine(root,path.join(tmp,'settings.json'));engine.selected=[a,b];
  const r={id:1,command:'validate',file:a,text,position:0,revision:0};
  let result=await engine.handle(r);assert.ok(!result.items.some((i:any)=>i.code==='dangling-reference'));
  result=await engine.handle({...r,buffers:[{file:b,text:wrap('')}]});assert.ok(result.items.some((i:any)=>i.code==='dangling-reference'));
  engine.settings['crossFile.enabled']=false;result=await engine.handle(r);assert.ok(!result.items.some((i:any)=>i.code==='dangling-reference'));
  engine.settings['crossFile.enabled']=true;
  engine.settings.workspaceFolder=tmp;
  await engine.handle({...r,command:'datasetFolder',argument:'.'});
  assert.deepEqual(engine.selected.sort(),[a,b].sort());
  const members=await engine.handle({...r,command:'datasetMembers'});assert.equal(members.items.length,2);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('CGMES 3.0 EQ detects header and resolves ACLineSegment hover',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgmes3-npp-'));
 try{const engine=new Engine(root,path.join(tmp,'settings.json'));engine.settings['crossFile.enabled']=false;
 const text='<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:md="http://iec.ch/TC57/61970-552/ModelDescription/1#"><md:FullModel rdf:about="urn:uuid:model"><md:Model.profile>http://iec.ch/TC57/ns/CIM/CoreEquipment-EU/3.0</md:Model.profile></md:FullModel><cim:ACLineSegment rdf:ID="_line"><cim:ACLineSegment.r>1.2</cim:ACLineSegment.r></cim:ACLineSegment></rdf:RDF>';
 const r={id:1,revision:0,file:path.join(tmp,'eq.xml'),text,command:'hover',position:byteOffset(text,text.indexOf('cim:ACLineSegment')+8)};
 assert.equal(engine.analysis(text,r.file).index?.bundle.id,'cgmes-3.0');
 assert.match((await engine.handle(r)).text,/ACLineSegment/);
 const result=await engine.handle({...r,command:'validate'});assert.ok(!result.items.some((i:any)=>i.code==='unknown-class'||i.code==='unknown-header-profile'));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
