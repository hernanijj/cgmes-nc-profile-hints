// Loads the bundled profile packages and any user-provided RDFS/SHACL folders.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildBundle, SourceFile } from './core/bundle';
import { VersionBundle } from './core/model';
import { ProfileIndex } from './core/profileIndex';
import { PropertyReferenceList, parsePropertyReferenceList } from './core/propertyReference';

export interface SchemaFolderSetting {
  label?: string;
  folder: string;
  id?: string;
  family?: string;
  version?: string;
}

export class ProfileStore {
  private _indexes: ProfileIndex[] = [];
  private _propertyReferences: PropertyReferenceList | undefined;
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(private readonly extensionPath: string, private readonly log: vscode.OutputChannel) {}

  get indexes(): ProfileIndex[] { return this._indexes; }
  get propertyReferences(): PropertyReferenceList | undefined { return this._propertyReferences; }

  async reload(): Promise<void> {
    const out: ProfileIndex[] = [];
    const folders = vscode.workspace.getConfiguration('cgmes').get<SchemaFolderSetting[]>('schemaFolders') ?? [];
    for (const f of folders) {
      try {
        const b = loadFolder(f);
        if (b.profiles.length) {
          out.push(new ProfileIndex(b));
          this.log.appendLine(`Loaded ${b.label} from ${f.folder}: ${b.profiles.map(p => p.keyword).join(', ')}`);
        } else {
          this.log.appendLine(`No RDFS profiles found in ${f.folder}`);
        }
      } catch (e) {
        this.log.appendLine(`Failed to load ${f.folder}: ${(e as Error).message}`);
        void vscode.window.showWarningMessage(`CGMES: could not load schema folder ${f.folder}`);
      }
    }
    const dir = path.join(this.extensionPath, 'profiles');
    for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : []) {
      const bundle = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as VersionBundle;
      if (out.some(i => i.bundle.id === bundle.id)) continue; // user folder overrides bundled data
      out.push(new ProfileIndex(bundle));
    }
    this._indexes = out;
    this._propertyReferences = this.loadPropertyReferences(dir);
    this.onDidChange.fire();
  }

  /** The cgmes.propertyReferenceList file, else a profiles/property-references.* file shipped with the extension. */
  private loadPropertyReferences(dir: string): PropertyReferenceList | undefined {
    const setting = vscode.workspace.getConfiguration('cgmes').get<string>('propertyReferenceList', '').trim();
    const bundled = fs.existsSync(dir) ? fs.readdirSync(dir).find(f => /^property-references?\./i.test(f)) : undefined;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const fromSetting = setting && (path.isAbsolute(expandHome(setting)) || !ws ? expandHome(setting) : path.join(ws, setting));
    const file = fromSetting || (bundled ? path.join(dir, bundled) : undefined);
    if (!file) return undefined;
    try {
      const list = parsePropertyReferenceList(fs.readFileSync(file, 'utf8'), path.basename(file));
      if (!list.names.length) {
        this.log.appendLine(`No property names found in ${file}`);
        return undefined;
      }
      this.log.appendLine(`Loaded ${list.names.length} PropertyReference names from ${file}`);
      return list;
    } catch (e) {
      this.log.appendLine(`Failed to read ${file}: ${(e as Error).message}`);
      void vscode.window.showWarningMessage(`CGMES: could not read the PropertyReference list ${file}`);
      return undefined;
    }
  }
}

function walk(dir: string, ext: RegExp, depth = 0): SourceFile[] {
  if (depth > 4 || !fs.existsSync(dir)) return [];
  const out: SourceFile[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext, depth + 1));
    else if (ext.test(e.name)) out.push({ name: e.name, text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

function expandHome(p: string): string {
  return p.replace(/^~(?=[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~');
}

export function loadFolder(f: SchemaFolderSetting): VersionBundle {
  const folder = expandHome(f.folder);
  const rdfs = walk(folder, /\.rdf$/i).filter(s => !/SHACL/i.test(s.name) && !/<sh:NodeShape|sh:PropertyShape/.test(s.text.slice(0, 20000)));
  const shapes = walk(folder, /\.ttl$/i);
  const version = f.version ?? (/(\d+(?:\.\d+)+)/.exec(folder)?.[1] ?? path.basename(folder));
  const family = f.family ?? (/ncp|nc\b/i.test(folder) ? 'NCP' : 'CGMES');
  const label = f.label ?? `${family} ${version}`;
  const id = f.id ?? `${family.toLowerCase()}-${version}`;
  return buildBundle({ id, family, version, label, source: folder }, rdfs, shapes);
}
