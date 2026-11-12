// Converts the RDFS/SHACL files under source-schemas/ into the compact JSON
// bundles the extension ships with (profiles/*.json).
//   npm run build:profiles

import * as fs from 'fs';
import * as path from 'path';
import { buildBundle, BundleMeta, SourceFile } from '../src/core/bundle';

const ROOT = path.resolve(__dirname, '..', '..');

const PACKAGES: (BundleMeta & { dir: string })[] = [
  { id: 'cgmes-2.4.15', family: 'CGMES', version: '2.4.15', label: 'CGMES 2.4.15', idStyle: 'rdfID', dir: 'source-schemas/cgmes/2.4.15' },
  { id: 'cgmes-3.0', family: 'CGMES', version: '3.0', label: 'CGMES 3.0', idStyle: 'rdfID', dir: 'source-schemas/cgmes/3.0' },
  { id: 'ncp-2.2', family: 'NCP', version: '2.2', label: 'NC profiles 2.2', idStyle: 'rdfID', dir: 'source-schemas/ncp/2.2' },
  { id: 'ncp-2.4', family: 'NCP', version: '2.4', label: 'NC profiles 2.4', idStyle: 'rdfID', dir: 'source-schemas/ncp/2.4' },
  { id: 'ncp-2.5', family: 'NCP', version: '2.5', label: 'NC profiles 2.5', idStyle: 'rdfID', dir: 'source-schemas/ncp/2.5' },
];

function walk(dir: string, ext: RegExp): SourceFile[] {
  if (!fs.existsSync(dir)) return [];
  const out: SourceFile[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (ext.test(e.name)) out.push({ name: e.name, text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

fs.mkdirSync(path.join(ROOT, 'profiles'), { recursive: true });
for (const pkg of PACKAGES) {
  const dir = path.join(ROOT, pkg.dir);
  const bundle = buildBundle(
    { ...pkg, source: pkg.dir },
    walk(path.join(dir, 'schema'), /\.rdf$/i).filter(f => !/SHACL/i.test(f.name)),
    walk(path.join(dir, 'shapes'), /\.ttl$/i),
  );
  const out = path.join(ROOT, 'profiles', `${pkg.id}.json`);
  fs.writeFileSync(out, JSON.stringify(bundle));
  const summary = bundle.profiles
    .map(p => `${p.keyword}(${Object.keys(p.classes).length}c/${Object.keys(p.properties).length}p)`)
    .join(' ');
  console.log(`${pkg.label}: ${summary} -> ${path.relative(ROOT, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}
