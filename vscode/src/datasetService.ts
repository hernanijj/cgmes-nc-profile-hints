// Keeps an index of the objects in the other CIM files next to each open file (a CGM's EQ, SSH, TP,
// SV, or NC profiles that reference each other), for cross-file reference checks.
// Files are scanned in the background, one folder at a time, yielding often, and only again when
// they change on disk. Files open in the editor are taken from their current text instead.
//
// Which files a file is checked against (its dataset):
// - automatic: the models its header depends on (md:Model.DependentOn, followed from model to
//   model) are preferred; any other CIM file of the folder still resolves references they lack;
// - selected: the files the user chose ("Validate together"), remembered per workspace.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Analysis } from './core/analysis';
import { DatasetLookup, FileObjects, ObjectScanner, datasetLookup, dependencyClosure, normalizedDeps, objectsFromAnalysis } from './core/crossIndex';

const CIM_FILE = /\.(xml|rdf|cimxml)$/i;

interface FileState { mtimeMs: number; size: number; objects?: FileObjects }
interface FolderState { files: Map<string, FileState>; ready: boolean; dirty: boolean; queued: boolean; watcher?: vscode.FileSystemWatcher }

function sameObjects(a: FileObjects, b: FileObjects): boolean {
  if (a.ids.size !== b.ids.size) return false;
  for (const [id, t] of a.ids) {
    const u = b.ids.get(id);
    if (u === undefined || a.types[t] !== b.types[u]) return false;
  }
  return true;
}

/** Reads a file in 1 MB pieces (never the whole text at once), yielding between pieces. */
async function scanFile(p: string, file: string, shouldStop: () => boolean): Promise<FileObjects | undefined> {
  const scanner = new ObjectScanner(file);
  const stream = fs.createReadStream(p, { encoding: 'utf8', highWaterMark: 1 << 20 });
  try {
    for await (const chunk of stream) {
      scanner.push(chunk as string);
      if (!scanner.ok || shouldStop()) return undefined;
      await new Promise<void>(r => setImmediate(r));
    }
  } finally {
    stream.destroy();
  }
  return scanner.end();
}

export const key = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const MANUAL_KEY = 'cgmes.dataset.selected';

interface Entry { path: string; objects: FileObjects }

/** The files a file is checked against, for the dataset bar. */
export interface DatasetInfo {
  mode: 'automatic' | 'selected';
  /** The file itself and the files it is checked against (selected), or the models it depends on (automatic). */
  files: { path: string; objects?: FileObjects }[];
  /** Automatic: every other CIM file of the folder, used for references the dependencies lack. */
  others: number;
  /** Models the file depends on that are in none of the files (e.g. the boundary set). */
  missing: string[];
}

export class DatasetService implements vscode.Disposable {
  private readonly folders = new Map<string, FolderState>();
  /** Files open in the editor, from their latest analysis. */
  private readonly live = new Map<string, Entry>();
  /** Files chosen with "Validate together" (keys), or undefined for automatic. */
  private selected?: Map<string, string>;
  private queue: Promise<void> = Promise.resolve();
  /** Changes whenever what a file is checked against may have changed (index, selection, open files' objects). */
  generation = 0;
  private disposed = false;
  private warnedSize = new Set<string>();

  constructor(
    private readonly log: vscode.OutputChannel,
    /** Called when a folder's index was (re)built, so open files there can be validated again. */
    private readonly onUpdated: (folder: string) => void,
    private readonly state: vscode.Memento,
  ) {
    const saved = state.get<string[]>(MANUAL_KEY);
    if (saved?.length) this.selected = new Map(saved.map(p => [key(p), p]));
  }

  /** The selected files (original paths), or undefined in automatic mode. */
  get selection(): string[] | undefined {
    return this.selected && [...this.selected.values()];
  }

  /** Check these files against each other only (undefined or empty: back to automatic). */
  async select(files: string[] | undefined): Promise<void> {
    this.selected = files?.length ? new Map(files.map(p => [key(p), p])) : undefined;
    this.generation++;
    await this.state.update(MANUAL_KEY, this.selection);
    for (const p of files ?? []) this.ensure(path.dirname(p));
  }

  isSelected(file: string): boolean {
    return !!this.selected?.has(key(file));
  }

  private settings() {
    const c = vscode.workspace.getConfiguration('cgmes');
    return {
      enabled: c.get<boolean>('crossFile.enabled', true),
      extra: c.get<string[]>('crossFile.extraFolders', []),
      maxBytes: c.get<number>('crossFile.maxTotalSizeMB', 1000) * 1024 * 1024,
    };
  }

  private foldersFor(file: string): string[] {
    const s = this.settings();
    if (!s.enabled) return [];
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const extra = s.extra.map(f => f.replace(/^~(?=[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~'))
      .map(f => (path.isAbsolute(f) || !ws ? f : path.join(ws, f)));
    return [...new Set([path.dirname(file), ...extra].map(f => path.resolve(f)))];
  }

  /** Everything indexed in these folders, with open files taken from the editor. Undefined until all are indexed. */
  private filesIn(folders: string[]): Map<string, Entry> | undefined {
    const all = new Map<string, Entry>();
    let ready = true;
    for (const f of folders) {
      const st = this.folders.get(key(f));
      if (!st?.ready) { this.ensure(f); ready = false; continue; }
      for (const [p, fs_] of st.files) if (fs_.objects) all.set(key(p), { path: p, objects: fs_.objects });
    }
    if (!ready) return undefined;
    const fk = new Set(folders.map(key));
    for (const [k, e] of this.live) if (all.has(k) || fk.has(key(path.dirname(e.path)))) all.set(k, e);
    return all;
  }

  /** The dataset of a file: what it is checked against. Undefined while files are being indexed. */
  private datasetOf(file: string, deps: readonly string[]): { mode: DatasetInfo['mode']; files: Entry[]; preferred: Entry[]; missing: string[] } | undefined {
    const k = key(file);
    if (this.selected?.has(k)) {
      const members = [...this.selected.values()];
      const all = this.filesIn([...new Set(members.map(p => path.dirname(p)))]);
      if (!all) return undefined;
      const files = members.map(p => all.get(key(p))).filter((e): e is Entry => !!e && key(e.path) !== k);
      const closure = dependencyClosure(normalizedDeps(deps), files.map(e => e.objects));
      return { mode: 'selected', files, preferred: files, missing: closure.missing };
    }
    const folders = this.foldersFor(file);
    if (!folders.length) return undefined;
    const all = this.filesIn(folders);
    if (!all) return undefined;
    all.delete(k);
    const files = [...all.values()];
    const closure = dependencyClosure(normalizedDeps(deps), files.map(e => e.objects));
    const inClosure = new Set(closure.files);
    return { mode: 'automatic', files, preferred: files.filter(e => inClosure.has(e.objects)), missing: closure.missing };
  }

  /** The other files' objects for a file, or undefined while they are not indexed yet. */
  lookupFor(file: string, deps: readonly string[] = []): DatasetLookup | undefined {
    if (!this.settings().enabled) return undefined;
    const d = this.datasetOf(file, deps);
    return d && datasetLookup(d.files.map(e => e.objects), key(file), new Set(d.preferred.map(e => e.objects.file)), d.mode === 'selected' ? 'the selected dataset' : undefined, d.missing.map(m => `urn:uuid:${m}`));
  }

  /** What a file is checked against, for the dataset bar. */
  info(file: string, deps: readonly string[] = []): DatasetInfo | undefined {
    if (!this.settings().enabled) return undefined;
    const d = this.datasetOf(file, deps);
    if (!d) return undefined;
    const self = { path: file, objects: this.live.get(key(file))?.objects };
    const shown = d.mode === 'selected' ? d.files : d.preferred;
    return { mode: d.mode, files: [self, ...shown], others: d.mode === 'automatic' ? d.files.length - d.preferred.length : 0, missing: d.missing };
  }

  /** The dependencies of a file as its last analysis or index entry has them. */
  dependsOnOf(file: string): string[] {
    const k = key(file);
    const live = this.live.get(k)?.objects.dependsOn;
    if (live) return live;
    const st = this.folders.get(key(path.dirname(file)));
    return st?.files.get(file)?.objects?.dependsOn ?? [...(st?.files ?? [])].find(([p]) => key(p) === k)?.[1].objects?.dependsOn ?? [];
  }

  /** The CIM files that could be chosen for a file's dataset: its folders and the current selection. */
  candidates(file: string): { path: string; objects?: FileObjects }[] {
    const folders = [...new Set([...this.foldersFor(file), path.dirname(file), ...(this.selection ?? []).map(p => path.dirname(p))])];
    const all = this.filesIn(folders) ?? new Map<string, Entry>();
    for (const [k, p] of this.selected ?? []) if (!all.has(k)) all.set(k, { path: p, objects: undefined! });
    return [...all.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Waits (at most timeoutMs) until the folders of a file are indexed. */
  async whenReady(file: string, timeoutMs: number): Promise<void> {
    const folders = this.foldersFor(file);
    folders.forEach(f => this.ensure(f));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && folders.some(f => !this.folders.get(key(f))?.ready)) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  /** Records the objects of a file open in the editor; true when they changed (other files need a new check). */
  setLive(file: string, a: Analysis): boolean {
    const next = objectsFromAnalysis(a, key(file));
    // Just opened: compare with what the index read from disk (usually the same text).
    const prev = this.live.get(key(file))?.objects ?? this.indexed(file);
    this.live.set(key(file), { path: file, objects: next });
    const changed = !prev || !sameObjects(prev, next);
    if (changed) this.generation++;
    return changed;
  }

  /** The objects the index read from disk for a file, if any. */
  private indexed(file: string): FileObjects | undefined {
    const k = key(file);
    const st = this.folders.get(key(path.dirname(file)));
    if (!st) return undefined;
    for (const [p, f] of st.files) if (key(p) === k) return f.objects;
    return undefined;
  }

  /** Whether a file's folder takes part in cross-file checks (setting on, real file). */
  covers(file: string): boolean {
    return this.foldersFor(file).length > 0;
  }

  /** Waits (at most timeoutMs) until the folders of these files are indexed. */
  async whenAllReady(files: string[], timeoutMs: number): Promise<void> {
    const folders = [...new Set(files.map(f => path.dirname(f)))];
    folders.forEach(f => this.ensure(f));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && folders.some(f => !this.folders.get(key(f))?.ready)) await new Promise(r => setTimeout(r, 50));
  }

  removeLive(file: string): boolean {
    const prev = this.live.get(key(file))?.objects;
    this.live.delete(key(file));
    // Closed without saving changes: the other files are checked against the saved text again.
    const disk = this.indexed(file);
    const changed = !!prev && (!disk || !sameObjects(prev, disk));
    if (changed) this.generation++;
    return changed;
  }

  /** Forget everything (settings changed). */
  reset(): void {
    for (const st of this.folders.values()) st.watcher?.dispose();
    this.folders.clear();
    this.generation++;
  }

  private ensure(folder: string): void {
    const k = key(folder);
    let st = this.folders.get(k);
    // Indexed and current, or a build is already queued.
    if (st && (!st.dirty || st.queued)) return;
    if (!st) {
      st = { files: new Map(), ready: false, dirty: true, queued: false };
      this.folders.set(k, st);
      try {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), '*.{xml,rdf,cimxml,XML,RDF}'));
        const changed = () => { const s = this.folders.get(k); if (s) { s.dirty = true; this.ensure(folder); } };
        w.onDidChange(changed); w.onDidCreate(changed); w.onDidDelete(changed);
        st.watcher = w;
      } catch { /* no watching: rebuilt on reload */ }
    }
    st.dirty = true;
    st.queued = true;
    const state = st;
    this.queue = this.queue.then(() => this.build(folder, state)).catch(e => {
      state.queued = false;
      state.ready = true;
      this.log.appendLine(`Cross-file index of ${folder} failed: ${(e as Error).message}`);
    });
  }

  private async build(folder: string, st: FolderState): Promise<void> {
    st.queued = false;
    if (this.disposed || !st.dirty || this.folders.get(key(folder)) !== st) return;
    st.dirty = false;
    const started = Date.now();
    let names: string[];
    try {
      names = (await fs.promises.readdir(folder)).filter(n => CIM_FILE.test(n));
    } catch {
      names = [];
    }
    const { maxBytes } = this.settings();
    let total = 0;
    let scanned = 0;
    let removed = 0;
    const seen = new Set<string>();
    const progress = vscode.window.setStatusBarMessage(`$(sync~spin) CGMES: indexing ${names.length} files in ${path.basename(folder)}…`);
    try {
      for (const n of names.sort()) {
        if (this.disposed) return;
        const p = path.join(folder, n);
        let stat: fs.Stats;
        try { stat = await fs.promises.stat(p); } catch { continue; }
        if (!stat.isFile()) continue;
        if (total + stat.size > maxBytes) {
          if (!this.warnedSize.has(key(folder))) {
            this.warnedSize.add(key(folder));
            this.log.appendLine(`Cross-file index of ${folder} stops at ${Math.round(total / 1048576)} MB (cgmes.crossFile.maxTotalSizeMB).`);
          }
          break;
        }
        total += stat.size;
        seen.add(p);
        const old = st.files.get(p);
        if (old && old.mtimeMs === stat.mtimeMs && old.size === stat.size) continue;
        const objects = await scanFile(p, key(p), () => this.disposed);
        if (this.disposed) return;
        st.files.set(p, { mtimeMs: stat.mtimeMs, size: stat.size, objects });
        scanned++;
      }
      for (const p of [...st.files.keys()]) if (!seen.has(p)) { st.files.delete(p); removed++; }
    } finally {
      progress.dispose();
    }
    st.ready = true;
    const count = [...st.files.values()].reduce((s, f) => s + (f.objects?.ids.size ?? 0), 0);
    this.log.appendLine(`Cross-file index of ${folder}: ${st.files.size} files, ${count} objects (${scanned} scanned, ${Date.now() - started} ms).`);
    if (scanned || removed) this.generation++;
    this.onUpdated(folder);
    // Files changed while indexing: index again (only the changed ones are read).
    if (st.dirty) this.ensure(folder);
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }
}
