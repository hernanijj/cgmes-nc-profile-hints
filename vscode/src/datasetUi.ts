// The dataset bar: which files the active CIM file is checked against, shown in the status bar
// and at the top of the CIM Issues view, with a menu to choose the files or go back to automatic.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileObjects } from './core/crossIndex';
import { indexForHeader } from './core/profileIndex';
import { DatasetInfo, DatasetService } from './datasetService';
import { ProfileStore } from './profileStore';

const CIM_FILE = /\.(xml|rdf|cimxml)$/i;

export interface DatasetActions {
  /** Validates these files (open ones in the editor, the others from disk). */
  validate(files: string[], title: string): Promise<void>;
  /** The selection changed: check the open files again. */
  changed(): void;
}

/** What the CIM Issues view shows above the sections. */
export interface DatasetNode {
  label: string;
  description: string;
  tooltip: string;
  files: { uri: vscode.Uri; label: string; description: string }[];
}

export class DatasetUi implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  private readonly subs: vscode.Disposable[] = [];
  private current?: { file: string; info?: DatasetInfo };

  constructor(private readonly dataset: DatasetService, private readonly store: ProfileStore, private readonly actions: DatasetActions) {
    this.item.command = 'cgmes.dataset.menu';
    this.subs.push(
      this.item,
      vscode.commands.registerCommand('cgmes.dataset.menu', () => this.menu()),
      vscode.commands.registerCommand('cgmes.dataset.choose', () => this.choose()),
      vscode.commands.registerCommand('cgmes.dataset.automatic', () => this.automatic()),
      vscode.commands.registerCommand('cgmes.dataset.validate', () => this.validateSelection()),
      vscode.commands.registerCommand('cgmes.dataset.validateTogether', (uri?: vscode.Uri, uris?: vscode.Uri[]) => this.validateTogether(uri, uris)),
    );
  }

  /** "EQ · 2024-01-01T00:00:00Z" for a file, from its header. */
  describe(o: FileObjects | undefined): string {
    if (!o) return '';
    const uris = o.profiles ?? [];
    const index = indexForHeader(this.store.indexes, uris);
    const keywords = index ? index.profilesForHeader(uris).matched.map(p => p.keyword) : [];
    return [keywords.join('+'), o.time].filter(Boolean).join(' · ');
  }

  private activeFile(): string | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    return doc?.uri.scheme === 'file' && CIM_FILE.test(doc.fileName) ? doc.uri.fsPath : undefined;
  }

  /** Rebuilds the status bar entry for the active file (call when it or the index changes). */
  refresh(): void {
    const file = this.activeFile() ?? this.current?.file;
    if (!file || !vscode.workspace.getConfiguration('cgmes').get('crossFile.enabled', true)) { this.item.hide(); return; }
    const deps = this.dataset.dependsOnOf(file);
    const info = this.dataset.info(file, deps);
    this.current = { file, info };
    if (!info) {
      this.item.text = '$(sync~spin) Dataset';
      this.item.tooltip = 'Indexing the CIM files next to this file…';
    } else {
      const n = info.files.length;
      this.item.text = info.mode === 'selected' ? `$(references) Dataset: ${n} selected` : `$(references) Dataset: auto (${n})`;
      this.item.tooltip = this.tooltip(info);
    }
    if (this.activeFile()) this.item.show(); else this.item.hide();
  }

  private tooltip(info: DatasetInfo): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(info.mode === 'selected'
      ? '**Dataset: selected files**, checked against each other only.\n\n'
      : '**Dataset: automatic**, the models this file depends on (`md:Model.DependentOn`).\n\n');
    for (const f of info.files) md.appendMarkdown(`- ${path.basename(f.path).replace(/[\\`*_[\]]/g, '\\$&')} ${this.describe(f.objects) ? `(${this.describe(f.objects)})` : ''}\n`);
    if (info.others) md.appendMarkdown(`\n${info.others} other CIM file${info.others === 1 ? '' : 's'} of the folder resolve references these lack.\n`);
    if (info.missing.length) md.appendMarkdown(`\nNot found: ${info.missing.length} model${info.missing.length === 1 ? '' : 's'} it depends on (e.g. the boundary set), so references into ${info.missing.length === 1 ? 'it' : 'them'} stay hints.\n`);
    md.appendMarkdown('\nClick to choose the files.');
    return md;
  }

  /** The node at the top of the CIM Issues view. */
  issuesNode(problemsOf: (uri: vscode.Uri) => readonly vscode.Diagnostic[] | undefined): DatasetNode | undefined {
    const info = this.current?.info;
    if (!info) return undefined;
    const files = info.files.map(f => {
      const uri = vscode.Uri.file(f.path);
      const ps = problemsOf(uri);
      const count = (s: vscode.DiagnosticSeverity) => ps?.filter(d => d.severity === s).length ?? 0;
      const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
      const counts = ps ? `${plural(count(0), 'error')}, ${plural(count(1), 'warning')}` : 'not validated';
      return { uri, label: path.basename(f.path), description: [this.describe(f.objects), counts].filter(Boolean).join(' · ') };
    });
    return {
      label: info.mode === 'selected' ? `Dataset: ${files.length} selected files` : `Dataset: automatic (${files.length} files)`,
      description: info.missing.length ? `${info.missing.length} ${info.missing.length === 1 ? 'dependency' : 'dependencies'} not found` : '',
      tooltip: this.tooltip(info).value,
      files,
    };
  }

  private async menu(): Promise<void> {
    const sel = this.dataset.selection;
    type Item = vscode.QuickPickItem & { run: () => Promise<void> | void };
    const items: Item[] = [
      { label: '$(checklist) Choose the files to validate together…', run: () => this.choose() },
      { label: '$(sparkle) Automatic', description: sel ? '' : 'in use', detail: 'Each file is checked against the models its header depends on, and the rest of its folder.', run: () => this.automatic() },
    ];
    if (sel) items.push({ label: '$(play) Validate the selected files again', description: `${sel.length} files`, run: () => this.validateSelection() });
    const pick = await vscode.window.showQuickPick(items, { title: 'CGMES dataset' });
    await pick?.run();
  }

  private async choose(): Promise<void> {
    const file = this.activeFile() ?? this.current?.file ?? this.dataset.selection?.[0];
    if (!file) { void vscode.window.showInformationMessage('Open a CIM file first, or select files in the Explorer and use "CGMES: Validate together".'); return; }
    await this.dataset.whenReady(file, 3000);
    const sel = new Set((this.dataset.selection ?? []).map(p => path.resolve(p).toLowerCase()));
    const inUse = new Set((this.dataset.info(file, this.dataset.dependsOnOf(file))?.files ?? []).map(f => path.resolve(f.path).toLowerCase()));
    const dir = path.dirname(file);
    const items = this.dataset.candidates(file).map(c => ({
      label: path.basename(c.path),
      description: this.describe(c.objects),
      detail: path.dirname(c.path) === dir ? undefined : path.dirname(c.path),
      picked: sel.size ? sel.has(path.resolve(c.path).toLowerCase()) : inUse.has(path.resolve(c.path).toLowerCase()),
      path: c.path,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Validate together',
      placeHolder: 'Tick the files to check against each other (none or one: back to automatic)',
    });
    if (!picked) return;
    if (picked.length < 2) { await this.automatic(); return; }
    await this.useSelection(picked.map(p => p.path));
  }

  private async validateTogether(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
    const chosen = (uris?.length ? uris : uri ? [uri] : []).filter(u => u.scheme === 'file').map(u => u.fsPath);
    const files: string[] = [];
    for (const p of chosen) {
      let st: fs.Stats;
      try { st = await fs.promises.stat(p); } catch { continue; }
      if (st.isDirectory()) {
        for (const n of (await fs.promises.readdir(p)).sort()) if (CIM_FILE.test(n)) files.push(path.join(p, n));
      } else if (CIM_FILE.test(p)) files.push(p);
    }
    if (files.length < 2) {
      void vscode.window.showInformationMessage('Select two or more CIM files (or a folder) in the Explorer to validate them together.');
      return;
    }
    await this.useSelection(files);
  }

  private async useSelection(files: string[]): Promise<void> {
    await this.dataset.select(files);
    this.actions.changed();
    await this.actions.validate(files, `CGMES: validating ${files.length} files together`);
  }

  private async automatic(): Promise<void> {
    if (!this.dataset.selection) return;
    await this.dataset.select(undefined);
    this.actions.changed();
    this.refresh();
  }

  private async validateSelection(): Promise<void> {
    const sel = this.dataset.selection;
    if (sel) await this.actions.validate(sel, `CGMES: validating ${sel.length} files together`);
  }

  dispose(): void {
    this.subs.forEach(s => s.dispose());
  }
}
