import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { analyze, Analysis, qname } from './core/analysis';
import { complete } from './core/complete';
import { hover, definitionAt, referencesAt } from './core/hover';
import { ProfileIndex } from './core/profileIndex';
import { buildBundle, SourceFile } from './core/bundle';
import { parsePropertyReferenceList } from './core/propertyReference';
import { validate, DEFAULT_VALIDATE_OPTIONS, Problem } from './core/validate';
import { datasetLookup, dependencyClosure, normalizedDeps, normalizeRef, ObjectScanner, objectsFromAnalysis, FileObjects } from './core/crossIndex';
import { documentSnippet, propertySnippet } from './core/templates';
import { elementAt, XmlElement } from './core/xml';

export const utf16Offset = (s: string, bytes: number) => Buffer.from(s).subarray(0, bytes).toString('utf8').length;
export const byteOffset = (s: string, chars: number) => Buffer.byteLength(s.slice(0, chars));
// Convert the VS Code snippet grammar emitted by the shared templates, retaining editable defaults.
export function snippet(s:string) {
  let text='';const fields:{index:number;start:number;end:number;choices?:string[]}[]=[];
  const re=/\\([\\$},|])|\$\{(\d+)(?::((?:\\.|[^}])*))?(?:\|((?:\\.|[^}])*?)\|)?\}|\$(\d+)/g;
  let last=0;const defaults=new Map<number,string>();
  for(const m of s.matchAll(re)) {
    text+=s.slice(last,m.index);last=m.index!+m[0].length;
    if(m[1]){text+=m[1];continue;}
    const index=Number(m[2]??m[5]);
    const choices=m[4]?.split(/(?<!\\),/).map(x=>x.replace(/\\([\\$},|])/g,'$1'));
    const value=(m[3]?.replace(/\\([\\$},|])/g,'$1'))??choices?.[0]??defaults.get(index)??'';
    defaults.set(index,value);const start=Buffer.byteLength(text);text+=value;
    fields.push({index,start,end:Buffer.byteLength(text),...(choices?{choices}:{})});
  }
  text+=s.slice(last);return {text,fields};
}
export const expandSnippet=(s:string)=>snippet(s).text;
type Request = { id: number; command: string; file: string; text: string; position: number; revision: number; argument?: any; buffers?: {file:string;text:string}[] };
export class Engine {
  indexes: ProfileIndex[] = [];
  propertyReferences: ReturnType<typeof parsePropertyReferenceList> | undefined;
  settings: any = {};
  overrides: Record<string, any> = {};
  selected: string[] = [];
  cache = new Map<string, {stamp:string; objects:FileObjects | undefined}>();
  constructor(readonly root: string, readonly config: string, readonly workspace:string=root) { this.reload(); }
  resolve(s:string) {return path.resolve(this.settings.workspaceFolder??this.workspace,s.replace(/^~(?=[\\/])/,process.env.USERPROFILE??process.env.HOME??'~'));}
  reload() {
    this.settings = fs.existsSync(this.config) ? JSON.parse(fs.readFileSync(this.config,'utf8')) : {};
    this.overrides = this.settings.documentOverrides ?? {};
    this.selected = this.settings.datasetFiles ?? [];
    this.indexes = [];
    const walk = (dir:string, re:RegExp): SourceFile[] => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => e.isSymbolicLink() ? [] : e.isDirectory() ? walk(path.join(dir,e.name),re) : re.test(e.name) ? [{name:e.name,text:fs.readFileSync(path.join(dir,e.name),'utf8')}] : []);
    for (const f of this.settings.schemaFolders ?? []) {
      const folder=this.resolve(f.folder),version=f.version ?? (/(\d+(?:\.\d+)+)/.exec(folder)?.[1]??path.basename(folder)), family=f.family ?? (/ncp|nc\b/i.test(folder)?'NCP':'CGMES');
      const rdfs=walk(folder,/\.rdf$/i).filter(s=>!/SHACL/i.test(s.name) && !/<sh:NodeShape|sh:PropertyShape/.test(s.text.slice(0,20000)));
      this.indexes.push(new ProfileIndex(buildBundle({id:f.id ?? `${family.toLowerCase()}-${version}`,version,family,label:f.label ?? f.folder},rdfs,walk(folder,/\.ttl$/i))));
    }
    for (const f of fs.readdirSync(path.join(this.root,'profiles')).filter(f=>f.endsWith('.json'))) {
      const b=JSON.parse(fs.readFileSync(path.join(this.root,'profiles',f),'utf8'));
      if (!this.indexes.some(i=>i.bundle.id===b.id)) this.indexes.push(new ProfileIndex(b));
    }
    const ref=this.settings.propertyReferenceList ? this.resolve(this.settings.propertyReferenceList) : path.join(this.root,'profiles','property-references.rdf');
    this.propertyReferences=fs.existsSync(ref) ? parsePropertyReferenceList(fs.readFileSync(ref,'utf8'),path.basename(ref)) : undefined;
    this.cache.clear();
  }
  save() { fs.mkdirSync(path.dirname(this.config),{recursive:true}); fs.writeFileSync(this.config,JSON.stringify({...this.settings,documentOverrides:this.overrides,datasetFiles:this.selected},null,2)); }
  analysis(text:string,file:string):Analysis { return analyze(text,{indexes:this.indexes,version:this.overrides[file]?.version ?? this.settings.version ?? 'auto',profiles:this.overrides[file]?.profiles,idStyle:this.settings.idStyle ?? 'auto',propertyReferences:this.propertyReferences}); }
  async dataset(r:Request,a:Analysis) {
    if (this.settings['crossFile.enabled']===false) return [];
    const files = new Set<string>(this.selected.map(f=>this.resolve(f)));
    if (!this.selected.length) for (const folder of [path.dirname(r.file),...(this.settings['crossFile.extraFolders'] ?? []).map((f:string)=>this.resolve(f))]) {
      if (!path.isAbsolute(folder) || !fs.existsSync(folder)) continue;
      for (const f of fs.readdirSync(folder,{withFileTypes:true})) if(f.isFile() && /\.(xml|rdf|cimxml)$/i.test(f.name)) files.add(path.join(folder,f.name));
    }
    const buffers = new Map((r.buffers??[]).map(b=>[b.file,b.text])); buffers.set(r.file,r.text);
    const out:FileObjects[]=[]; let total=0;
    for (const file of files) {
      if (buffers.has(file)) {
        const analysis=this.analysis(buffers.get(file)!,file);
        if(analysis.isCim) out.push(objectsFromAnalysis(analysis,file));
        continue;
      }
      try {
        const st=await fs.promises.stat(file); total+=st.size;
        if(total>(this.settings['crossFile.maxTotalSizeMB']??1000)*1048576) throw new Error('Dataset exceeds crossFile.maxTotalSizeMB; select a smaller dataset.');
        const stamp=`${st.mtimeMs}:${st.size}`; let c=this.cache.get(file);
        if(!c || c.stamp!==stamp) {
          const scan=new ObjectScanner(file);
          for await(const chunk of fs.createReadStream(file,{encoding:'utf8',highWaterMark:1048576})) scan.push(chunk as string);
          c={stamp,objects:scan.end()}; this.cache.set(file,c);
        }
        if(c.objects) out.push(c.objects);
      } catch(e) { if ((e as any).code!=='ENOENT') throw e; }
    }
    const deps=dependencyClosure(normalizedDeps(a.dependsOn),out);
    a.dataset=datasetLookup(out,r.file,new Set(deps.files.map(f=>f.file)),this.selected.length?'the selected dataset':'its folder',deps.missing);
    return out;
  }
  fixes(a:Analysis,p:Problem) {
    const results:any[]=[]; const edit=(start:number,end:number,text:string)=>({start:byteOffset(a.doc.text,start),end:byteOffset(a.doc.text,end),...snippet(text)});
    for(const replacement of (p.data?.replacements as string[] ?? []).slice(0,12)) {
      const edits=[edit(p.start,p.end,replacement)];
      const el=elementAt(a.doc,p.start);
      if((p.code==='wrong-namespace'||p.code==='unknown-property') && el && el.closeStart>=0 && el.nameStart===p.start) edits.push(edit(el.closeStart+2,el.closeStart+2+el.name.length,replacement));
      results.push({label:`Change to ${replacement}`,edits});
    }
    if(p.code==='undeclared-prefix' && a.root && a.index) {
      const prefix=p.data?.prefix as string, uri=a.index.bundle.namespaces[prefix];
      if(uri) results.push({label:`Declare ${prefix}`,edits:[edit(a.root.nameEnd,a.root.nameEnd,` xmlns:${prefix}="${uri}"`)]});
    }
    if(p.code==='missing-required' && a.index) {
      const el=elementAt(a.doc,p.start-1);
      if(el) {
        const props=(p.data?.properties as string[] ?? []).map(u=>a.index!.propDef(u,a.active)).filter(p=>!!p);
        const body=props.map((p,i)=>'  <'+propertySnippet(a,p!,i+1)).join('\n');
        if(el.selfClosing) results.push({label:'Insert required properties',edits:[edit(el.startTagEnd-2,el.startTagEnd,`>\n${body}\n</${el.name}>`)]});
        else if(el.closeStart>=0) results.push({label:'Insert required properties',edits:[edit(el.closeStart,el.closeStart,`\n${body}\n`)]});
      }
    }
    return results;
  }
  async handle(r:Request):Promise<any> {
    if(r.command==='reload') this.reload();
    if(r.command==='setProfile') {this.overrides[r.file]=r.argument;this.save();}
    if(r.command==='dataset') {this.selected=r.argument??[];this.save();}
    if(r.command==='datasetFolder') {
      const folder=this.resolve(r.argument);this.selected=fs.readdirSync(folder,{withFileTypes:true}).filter(f=>f.isFile()&&/\.(xml|rdf|cimxml)$/i.test(f.name)).map(f=>path.join(folder,f.name));this.save();
    }
    if(r.command==='openDatasetSelection') {
      const buffers=new Map((r.buffers??[]).map(b=>[b.file,b.text]));buffers.set(r.file,r.text);
      const selected=new Set(this.selected.map(f=>path.resolve(this.resolve(f)).toLowerCase()));
      const items=[...buffers].flatMap(([file,text])=>{
        if(!path.isAbsolute(file)||!/\.(xml|rdf|cimxml)$/i.test(file)||!this.analysis(text,file).isCim)return [];
        const label=`${path.basename(file)} (${path.dirname(file)})${/\.xml$/i.test(file)?'':' — reference only'}`;
        return [{file,label,checked:this.selected.length?selected.has(path.resolve(file).toLowerCase()):true}];
      });
      return {kind:'datasetSelection',items};
    }
    if(r.command==='profiles' || r.command==='versions' || r.command==='new') return {kind:'choices',items:[...(r.command==='new'?[]:[{label:'Automatic',command:'setProfile',argument:{}}]),...this.indexes.flatMap<any>(i=>r.command==='versions'?[{label:i.bundle.label,command:'setProfile',argument:{version:i.bundle.id}}]:i.profiles.map(p=>({label:`${i.bundle.label} / ${p.keyword}`,command:r.command==='new'?'newText':'setProfile',argument:r.command==='new'?snippet(documentSnippet(i,[p])):{version:i.bundle.id,profiles:[p.keyword]}})))]};
    const a=this.analysis(r.text,r.file), offset=utf16Offset(r.text,r.position);
    const range=(start:number,end:number)=>({start:byteOffset(r.text,start),end:byteOffset(r.text,end)});
    if(r.command==='findDefinitionById'||r.command==='findReferencesById') {
      const requested=String(r.argument??'').trim(),key=normalizeRef(requested);
      if(!key)return {kind:'searchResults',status:'Enter a CIM mRID such as _123, #_123 or urn:uuid:123.',items:[]};
      const indexed=await this.dataset(r,a),buffers=new Map((r.buffers??[]).map(b=>[b.file,b.text]));buffers.set(r.file,r.text);
      const items:any[]=[];
      for(const file of indexed) {
        if(r.command==='findDefinitionById'&&!file.ids.has(key))continue;
        const text=buffers.get(file.file)??await fs.promises.readFile(file.file,'utf8'),source=this.analysis(text,file.file);
        if(!source.isCim)continue;
        const lineStarts=[0];for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10)lineStarts.push(i+1);
        const lineAt=(position:number)=>{let low=0,high=lineStarts.length;while(low+1<high){const middle=(low+high)>>>1;if(lineStarts[middle]<=position)low=middle;else high=middle;}return low+1;};
        if(r.command==='findDefinitionById') {
          for(const object of source.objects)if(normalizeRef(object.id??object.about??'')===key) {
            const start=object.el.nameStart,end=object.el.nameEnd,line=lineAt(start);
            items.push({label:`${path.basename(file.file)}:${line} — ${object.el.name} — ${requested}`,detail:file.file,file:file.file,start:byteOffset(text,start),end:byteOffset(text,end)});
          }
        } else {
          const visit=(element:XmlElement,owner:string)=>{
            for(const attribute of element.attrs)if(attribute.name==='rdf:resource'&&normalizeRef(attribute.value)===key) {
              const start=attribute.valueStart,end=attribute.valueEnd,line=lineAt(start);
              items.push({label:`${path.basename(file.file)}:${line} — ${owner}.${element.name} → ${requested}`,detail:file.file,file:file.file,start:byteOffset(text,start),end:byteOffset(text,end)});
            }
            for(const child of element.children)visit(child,owner);
          };
          if(source.doc.root)for(const child of source.doc.root.children)visit(child,child.name);
        }
      }
      const subject=r.command==='findDefinitionById'?'definitions':'references';
      return {kind:'searchResults',status:`${items.length} ${subject} for ${requested} in ${indexed.length} dataset files.`,items};
    }
    const trimmed=r.text.trim(), unfinishedTag=/<[^>]*$/.test(trimmed);
    if(!a.isCim && r.command!=='datasetMembers' && (a.root || (trimmed.length>0 && !unfinishedTag))) {
      if(r.command==='complete') return {kind:'completion',items:[]};
      if(r.command==='hover') return {kind:'hover',text:''};
      if(['outline','definition','references'].includes(r.command)) return {kind:'locations',items:[]};
      if(r.command==='fix') return {kind:'fixes',items:[]};
      return {kind:'issues',status:'Not a supported CIM file',items:[]};
    }
    if(r.command==='complete') return {kind:'completion',items:complete(a,offset,{insertRequired:this.settings['completion.insertRequiredProperties']!==false}).sort((x,y)=>(x.sortText??x.label).localeCompare(y.sortText??y.label)).map(c=>({label:c.label,detail:c.documentation??c.detail??'',edits:[{...range(c.replaceStart,c.replaceEnd),...snippet(c.insertText)}]}))};
    if(r.command==='hover') return {kind:'hover',text:hover(a,offset)?.markdown??''};
    if(r.command==='outline') return {kind:'locations',items:a.objects.map(o=>({label:`${o.el.name}  ${o.name??o.id??o.about??''}`,file:r.file,...range(o.el.start,o.el.end)})).sort((x,y)=>x.label.localeCompare(y.label))};
    if(r.command==='definition') {const o=definitionAt(a,offset); return {kind:'locations',items:o?[{label:o.name??o.id??o.about,file:r.file,...range(o.el.start,o.el.end)}]:[]};}
    if(r.command==='references') return {kind:'locations',items:referencesAt(a,offset).map(p=>({label:`Line ${r.text.slice(0,p.start).split('\n').length}`,file:r.file,...range(p.start,p.end)}))};
    if(r.command==='datasetMembers') {
      const indexed=await this.dataset(r,a);
      return {kind:'locations',items:indexed.map(f=>({label:`${path.basename(f.file)} — ${(f.profiles??[]).join(', ')} — ${f.ids.size} objects`,detail:f.file,file:f.file,start:0,end:0}))};
    }
    if(a.isCim && !/\.xml$/i.test(r.file)) {
      if(r.command==='fix') return {kind:'fixes',items:[]};
      return {kind:'issues',status:'CIM validation requires a .xml file',items:[]};
    }
    const indexed=await this.dataset(r,a);
    const opts={...DEFAULT_VALIDATE_OPTIONS,requiredProperties:this.settings['validation.requiredProperties']!==false,checkIdFormat:this.settings['validation.identifierFormat']!==false,propertyReferences:this.settings['validation.propertyReferences']!==false,unresolvedReferences:this.settings['validation.unresolvedReferences']??'hint',danglingReferences:this.settings['validation.danglingReferences']??'warning'};
    const problems=this.settings['validation.enabled']===false?[]:validate(a,opts);
    if(r.command==='fix') return {kind:'fixes',items:problems.filter(p=>p.start<=offset && p.end>=offset).flatMap(p=>this.fixes(a,p))};
    const items:any[]=[];
    const add=(text:string,file:string,ps:Problem[])=>{
      // Compute positions once in ascending order, not a full prefix scan for every issue.
      const positions=new Map<number,{byte:number;line:number}>();let at=0,bytes=0,line=1;
      for(const offset of [...new Set(ps.flatMap(p=>[p.start,p.end]))].sort((a,b)=>a-b)){
        const part=text.slice(at,offset);bytes+=Buffer.byteLength(part);for(let j=0;j<part.length;j++)if(part.charCodeAt(j)===10)line++;
        positions.set(offset,{byte:bytes,line});at=offset;
      }
      for(const p of ps) for(const rule of p.rules??[p.rule??'schema']) items.push({label:`[${rule}] ${p.severity} / ${p.code} / ${path.basename(file)}:${positions.get(p.start)!.line} — ${p.message.replace(/\n/g,' ')}`,detail:p.message,file,start:positions.get(p.start)!.byte,end:positions.get(p.end)!.byte,severity:p.severity,rule,code:p.code});};
    add(r.text,r.file,problems);
    if(r.command==='validateDataset') for(const f of indexed) if(f.file!==r.file && /\.xml$/i.test(f.file) && fs.existsSync(f.file) && fs.statSync(f.file).size<=(this.settings['crossFile.maxValidateSizeMB']??60)*1048576) {
      const text=r.buffers?.find(b=>b.file===f.file)?.text??fs.readFileSync(f.file,'utf8'), other=this.analysis(text,f.file);
      const closure=dependencyClosure(normalizedDeps(other.dependsOn),indexed);
      other.dataset=datasetLookup(indexed,f.file,new Set(closure.files.map(x=>x.file)),'the selected dataset',closure.missing);
      add(text,f.file,validate(other,opts));
    }
    return {kind:'issues',status:`${a.index?.bundle.label??'CIM'} / ${a.active.map(p=>p.keyword).join(', ')||'automatic'} / ${problems.length} issues / ${indexed.length} dataset files`,items};
  }
}
if(require.main===module) {
  let engine:Engine;
  const config=process.argv[2] || path.join(process.env.APPDATA??__dirname,'CGMESNotepad','settings.json');
  let queue=Promise.resolve();
  readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
    queue=queue.then(async()=>{let r:any={};try{r=JSON.parse(line);engine??=new Engine(__dirname,config,path.isAbsolute(r.file)?path.dirname(r.file):process.cwd());const result=await engine.handle(r);process.stdout.write(JSON.stringify({id:r.id,revision:r.revision,file:r.file,...result})+'\n');}catch(e){process.stdout.write(JSON.stringify({id:r.id,revision:r.revision,file:r.file,kind:'error',text:(e as Error).message})+'\n');}});
  });
}
