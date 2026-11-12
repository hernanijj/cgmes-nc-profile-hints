import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Analysis, analyze, looksLikeCim, objectOf, qname } from './core/analysis';
import { complete, CompletionResult, ItemKind } from './core/complete';
import { definitionAt, hover, referenceAt, referencesAt, referencesTo } from './core/hover';
import { FileObjects, normalizeRef, ReferenceLocation, scanReferenceLocations } from './core/crossIndex';
import { localName } from './core/model';
import { documentSnippet, propertySnippet } from './core/templates';
import { DEFAULT_VALIDATE_OPTIONS, Problem, problemsForEditor, validate, ValidateOptions } from './core/validate';
import { elementAt } from './core/xml';
import { DatasetService, key as datasetFileKey } from './datasetService';
import { DatasetUi } from './datasetUi';
import { IssuesView, revealIssue, sourceLabel } from './issuesView';
import { ProfileStore } from './profileStore';

const SELECTOR: vscode.DocumentSelector = [{ language: 'xml' }, { pattern: '**/*.{rdf,cimxml}' }];
const OVERRIDES_KEY = 'cgmes.documentOverrides';

interface Override { version?: string; profiles?: string[] }

let store: ProfileStore;
let state: vscode.Memento;
const cache = new Map<string, { version: number; analysis: Analysis }>();
/**
 * Analyses of recently closed files (VS Code closes a preview tab when another file is opened in
 * its place), kept up to a total text size so switching back does not read the file again.
 */
const closed = new Map<string, Analysis>();
const CLOSED_BUDGET = 40 * 1048576;

function rememberClosed(uri: string, a: Analysis) {
  closed.delete(uri);
  closed.set(uri, a);
  let total = 0;
  for (const x of closed.values()) total += x.doc.text.length;
  for (const [k, x] of closed) {
    if (total <= CLOSED_BUDGET) break;
    closed.delete(k);
    total -= x.doc.text.length;
  }
}

/** Bumped when settings or profile definitions change: every result is then out of date. */
let configGeneration = 0;

function cfg() {
  return vscode.workspace.getConfiguration('cgmes');
}

function getOverride(doc: { uri: vscode.Uri }): Override {
  return state.get<Record<string, Override>>(OVERRIDES_KEY, {})[doc.uri.toString()] ?? {};
}

/** Analysis of a file that is not open in the editor (read from disk for a dataset check). */
function analyzeText(uri: vscode.Uri, text: string): Analysis {
  const o = getOverride({ uri });
  return analyze(text, {
    indexes: store.indexes,
    version: o.version ?? cfg().get<string>('version', 'auto'),
    profiles: o.profiles,
    idStyle: cfg().get<'auto' | 'rdfID' | 'urnUuid'>('idStyle', 'auto'),
    propertyReferences: store.propertyReferences,
  });
}

/** positionAt for a text that has no TextDocument. */
function positionsOf(text: string): (offset: number) => vscode.Position {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return offset => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return new vscode.Position(lo, offset - starts[lo]);
  };
}

async function setOverride(doc: vscode.TextDocument, o: Override) {
  const all = { ...state.get<Record<string, Override>>(OVERRIDES_KEY, {}) };
  all[doc.uri.toString()] = { ...all[doc.uri.toString()], ...o };
  await state.update(OVERRIDES_KEY, all);
  cache.delete(doc.uri.toString());
  closed.delete(doc.uri.toString());
}

/**
 * The first lines of a document. Every getText() of a whole document builds a new string (32 MB
 * for a large EQ), so checks that only need a bounded prefix read just that.
 */
function headOf(doc: vscode.TextDocument): string {
  return doc.getText(new vscode.Range(new vscode.Position(0, 0), doc.positionAt(20000)));
}

function isEmptyDoc(doc: vscode.TextDocument): boolean {
  return doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end) < 20000 && doc.getText().trim() === '';
}

function isCimDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'xml' || /\.(rdf|cimxml)$/i.test(doc.fileName);
}

function hasXmlExtension(doc: vscode.TextDocument): boolean {
  return /\.xml$/i.test(doc.fileName);
}

const candidateCache = new WeakMap<vscode.TextDocument, { version: number; ok: boolean }>();

function isCandidate(doc: vscode.TextDocument): boolean {
  if (!isCimDocument(doc)) return false;
  const hit = candidateCache.get(doc);
  if (hit && hit.version === doc.version) return hit.ok;
  const ok = looksLikeCim(headOf(doc)) || isEmptyDoc(doc);
  candidateCache.set(doc, { version: doc.version, ok });
  return ok;
}

function getAnalysis(doc: vscode.TextDocument): Analysis {
  const key = doc.uri.toString();
  const hit = cache.get(key);
  if (hit && hit.version === doc.version) return hit.analysis;
  // Reopened with the same text: reuse the analysis from when it was closed.
  const old = closed.get(key);
  if (old) {
    closed.delete(key);
    if (old.doc.text === doc.getText()) {
      cache.set(key, { version: doc.version, analysis: old });
      return old;
    }
  }
  const o = getOverride(doc);
  const configured = cfg().get<string>('version', 'auto');
  const analysis = analyze(doc.getText(), {
    indexes: store.indexes,
    version: o.version ?? configured,
    profiles: o.profiles,
    idStyle: cfg().get<'auto' | 'rdfID' | 'urnUuid'>('idStyle', 'auto'),
    propertyReferences: store.propertyReferences,
  });
  cache.set(key, { version: doc.version, analysis });
  return analysis;
}

interface Summary { label?: string; isCim: boolean; profiles: string; sub: string; source: string }

function summaryOf(a: Analysis): Summary {
  return {
    label: a.index?.bundle.label,
    isCim: a.isCim,
    profiles: a.active.map(p => p.keyword).join('+') || 'no profile',
    sub: a.subProfiles.size ? ` (${[...a.subProfiles].join('+')})` : '',
    source: a.profileSource,
  };
}

function validateOptions(): ValidateOptions {
  const c = cfg();
  return {
    unresolvedReferences: c.get('validation.unresolvedReferences', DEFAULT_VALIDATE_OPTIONS.unresolvedReferences),
    requiredProperties: c.get('validation.requiredProperties', DEFAULT_VALIDATE_OPTIONS.requiredProperties),
    checkIdFormat: c.get('validation.identifierFormat', DEFAULT_VALIDATE_OPTIONS.checkIdFormat),
    danglingReferences: c.get('validation.danglingReferences', DEFAULT_VALIDATE_OPTIONS.danglingReferences),
    propertyReferences: c.get('validation.propertyReferences', DEFAULT_VALIDATE_OPTIONS.propertyReferences),
  };
}

const SEVERITY: Record<Problem['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

const KIND: Record<ItemKind, vscode.CompletionItemKind> = {
  class: vscode.CompletionItemKind.Class,
  property: vscode.CompletionItemKind.Field,
  association: vscode.CompletionItemKind.Reference,
  enum: vscode.CompletionItemKind.EnumMember,
  reference: vscode.CompletionItemKind.Reference,
  value: vscode.CompletionItemKind.Value,
  snippet: vscode.CompletionItemKind.Snippet,
};

const problemData = new WeakMap<vscode.Diagnostic, Problem>();

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('CGMES');
  store = new ProfileStore(context.extensionPath, log);
  state = context.workspaceState;
  await store.reload();

  const diagnostics = vscode.languages.createDiagnosticCollection('cgmes');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'cgmes.selectProfile';
  context.subscriptions.push(log, diagnostics, status);

  // Every problem per file; the editor only gets problemsForEditor() of them.
  const allProblems = new Map<string, vscode.Diagnostic[]>();
  const issues = new IssuesView(uri => allProblems.get(uri.toString()), d => { const p = problemData.get(d); return p?.rules ?? [p?.rule ?? 'schema']; }, (doc, offset) => {
    const a = getAnalysis(doc);
    const o = objectOf(a, elementAt(a.doc, offset));
    if (!o) return undefined;
    const t = o.type ? localName(o.type) : o.el.name;
    return o.name ? `${t} '${o.name}'` : t;
  }, doc => isCandidate(doc), context.workspaceState, () => ui.issuesNode(uri => allProblems.get(uri.toString())));
  context.subscriptions.push(
    issues.tree,
    vscode.commands.registerCommand('cgmes.revealIssue', revealIssue),
    vscode.commands.registerCommand('cgmes.issues.groupBySeverity', () => issues.toggleGrouping()),
    vscode.commands.registerCommand('cgmes.issues.groupByCheck', () => issues.toggleGrouping()),
    vscode.commands.registerCommand('cgmes.showIssues', () => vscode.commands.executeCommand('cgmes.issues.focus')),
    vscode.languages.onDidChangeDiagnostics(e => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.uris.some(u => u.toString() === ed.document.uri.toString())) issues.refresh();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => issues.refresh()),
  );

  const timers = new Map<string, NodeJS.Timeout>();
  /** Status bar text of files checked from disk, so switching to one does not need its analysis. */
  const summaries = new Map<string, Summary>();
  const sameFolder = (file: string, folder: string) => path.resolve(path.dirname(file)).toLowerCase() === path.resolve(folder).toLowerCase();
  /** Files validated from disk for a dataset check (not open in the editor). */
  const fromDisk = new Set<string>();
  // Other CIM files of the folder (EQ/SSH/TP/SV, NC profiles): re-check open files when their index changes.
  const dataset = new DatasetService(log, folder => {
    for (const d of vscode.workspace.textDocuments) {
      if (allProblems.has(d.uri.toString()) && d.uri.scheme === 'file' && (sameFolder(d.uri.fsPath, folder) || dataset.isSelected(d.uri.fsPath))) schedule(d);
    }
    const again = [...fromDisk].map(u => vscode.Uri.parse(u).fsPath).filter(f => dataset.isSelected(f));
    if (again.length) scheduleDisk(again);
    ui.refresh();
  }, context.workspaceState);
  context.subscriptions.push(dataset);

  const referenceLocationCache = new Map<string, { mtimeMs: number; size: number; locations: ReferenceLocation[] }>();
  const referenceLocationsOnDisk = async (file: string, ref: string): Promise<ReferenceLocation[]> => {
    const stat = await fs.promises.stat(file);
    const cacheKey = `${datasetFileKey(file)}\0${ref}`;
    const cached = referenceLocationCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.locations;
    const locations = await scanReferenceLocations(file, ref);
    referenceLocationCache.delete(cacheKey);
    referenceLocationCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, locations });
    if (referenceLocationCache.size > 128) referenceLocationCache.delete(referenceLocationCache.keys().next().value!);
    return locations;
  };

  const navigationDataset = async (doc: vscode.TextDocument): Promise<{ objects: FileObjects[]; analyses: Map<string, Analysis>; invalid: Set<string> } | undefined> => {
    if (doc.uri.scheme !== 'file' || !dataset.isSelected(doc.uri.fsPath)) return undefined;
    const selected = dataset.selection ?? [];
    await dataset.whenAllReady(selected, 5000);
    const analyses = new Map<string, Analysis>();
    const invalid = new Set<string>();
    for (const open of vscode.workspace.textDocuments) {
      if (open.uri.scheme !== 'file' || !dataset.isSelected(open.uri.fsPath)) continue;
      const k = datasetFileKey(open.uri.fsPath);
      if (isCandidate(open)) {
        const a = getAnalysis(open);
        if (a.isCim) { analyses.set(k, a); dataset.setLive(open.uri.fsPath, a); }
        else { dataset.removeLive(open.uri.fsPath); invalid.add(k); }
      } else { dataset.removeLive(open.uri.fsPath); invalid.add(k); }
    }
    const objects = dataset.selectedObjects(doc.uri.fsPath);
    if (!objects) {
      void vscode.window.showInformationMessage('The selected CGMES dataset is still indexing. Try navigation again shortly.');
      return undefined;
    }
    return { objects, analyses, invalid };
  };

  /** What a validation depended on besides the file's own text. */
  const generation = () => `${configGeneration}:${dataset.generation}`;
  /** The problems of an analysis and the generation they were found in (skip checks while unchanged). */
  const results = new WeakMap<Analysis, { gen: string; all: vscode.Diagnostic[]; shown: vscode.Diagnostic[] }>();
  /** Files validated from disk: a hash of the text and their problems, reused when the file is opened unchanged. */
  const diskResults = new Map<string, { hash: string; gen: string }>();
  const hashOf = (text: string) => crypto.createHash('sha1').update(text).digest('hex');

  const publish = (uri: vscode.Uri, positionAt: (o: number) => vscode.Position, a: Analysis) => {
    const toDiagnostic = (p: Problem) => {
      const d = new vscode.Diagnostic(new vscode.Range(positionAt(p.start), positionAt(p.end)), p.message, SEVERITY[p.severity]);
      d.source = sourceLabel(p.rules ?? [p.rule ?? 'schema']);
      d.code = p.code;
      problemData.set(d, p);
      return d;
    };
    const problems = validate(a, validateOptions());
    const all = problems.map(toDiagnostic);
    const byProblem = new Map(problems.map((p, i) => [p, all[i]]));
    const anchor = a.header ?? a.root!;
    const shown = problemsForEditor(problems, { start: anchor.nameStart, end: anchor.nameEnd }).map(p => byProblem.get(p) ?? toDiagnostic(p));
    allProblems.set(uri.toString(), all);
    diagnostics.set(uri, shown);
    results.set(a, { gen: generation(), all, shown });
    return all.length;
  };

  const refresh = (doc: vscode.TextDocument) => {
    const clear = () => { allProblems.delete(doc.uri.toString()); diagnostics.delete(doc.uri); };
    if (!isCandidate(doc)) { clear(); removeUnsupportedLive(doc); return; }
    if (!cfg().get('validation.enabled', true)) { clear(); return; }
    const started = Date.now();
    const k = doc.uri.toString();
    // Opened after "Validate together" checked it from disk, and unchanged since: keep those results.
    const disk = diskResults.get(k);
    if (disk && fromDisk.has(k) && !doc.isDirty) {
      diskResults.delete(k);
      if (disk.gen === generation() && disk.hash === hashOf(doc.getText())) { fromDisk.delete(k); return; }
    }
    const a = getAnalysis(doc);
    if (!a.isCim) { clear(); removeUnsupportedLive(doc); return; }
    const analysed = Date.now();
    fromDisk.delete(k);
    if (doc.uri.scheme === 'file') {
      const file = doc.uri.fsPath;
      a.dataset = dataset.lookupFor(file, a.dependsOn);
      // This file's objects changed: the other open files of its dataset may reference them.
      if (dataset.setLive(file, a) && (allProblems.has(doc.uri.toString()) || !hasXmlExtension(doc))) {
        for (const d of vscode.workspace.textDocuments) {
          if (d !== doc && allProblems.has(d.uri.toString()) && d.uri.scheme === 'file' && (sameFolder(d.uri.fsPath, path.dirname(file)) || dataset.isSelected(d.uri.fsPath))) schedule(d);
        }
      }
    }
    if (!hasXmlExtension(doc)) {
      clear();
      diskResults.delete(k);
      fromDisk.delete(k);
      return;
    }
    // Nothing changed since the last check of this text (switching tabs, a file reopened): reuse it.
    const prev = results.get(a);
    if (prev && prev.gen === generation()) {
      if (allProblems.get(k) !== prev.all) { allProblems.set(k, prev.all); diagnostics.set(doc.uri, prev.shown); }
      return;
    }
    const n = publish(doc.uri, o => doc.positionAt(o), a);
    // Timings in the CGMES output channel, to see where the time goes on large files.
    if (Date.now() - started > 300) log.appendLine(`Validated ${path.basename(doc.fileName)}: ${n} problems in ${Date.now() - started} ms (reading ${analysed - started} ms, checks ${Date.now() - analysed} ms).`);
  };

  /** Validates a CIM file that is not open, from disk (part of the selected dataset). */
  const validateFromDisk = async (file: string): Promise<string | undefined> => {
    if (!/\.xml$/i.test(file)) return undefined;
    const uri = vscode.Uri.file(file);
    const maxMB = cfg().get<number>('crossFile.maxValidateSizeMB', 60);
    let size: number;
    try { size = (await fs.promises.stat(file)).size; } catch { return `${path.basename(file)} could not be read`; }
    if (size > maxMB * 1048576) {
      return `${path.basename(file)} (${Math.round(size / 1048576)} MB) is only used to resolve references; open it to validate it, or raise cgmes.crossFile.maxValidateSizeMB`;
    }
    const text = await fs.promises.readFile(file, 'utf8');
    if (!looksLikeCim(text)) return undefined;
    const a = analyzeText(uri, text);
    a.dataset = dataset.lookupFor(file, a.dependsOn);
    publish(uri, positionsOf(text), a);
    fromDisk.add(uri.toString());
    diskResults.set(uri.toString(), { hash: hashOf(text), gen: generation() });
    summaries.set(uri.toString(), summaryOf(a));
    return undefined;
  };

  /** Validates the given files, open ones from the editor and the others from disk, one at a time. */
  const validateFiles = async (files: string[], title: string) => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      await dataset.whenAllReady(files, 5000);
      const notes: string[] = [];
      for (const [i, file] of files.entries()) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `${path.basename(file)} (${i + 1}/${files.length})`, increment: 100 / files.length });
        await new Promise<void>(r => setImmediate(r));
        const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath).toLowerCase() === path.resolve(file).toLowerCase());
        if (doc) refresh(doc);
        else {
          try { const n = await validateFromDisk(file); if (n) notes.push(n); } catch (e) { notes.push(`${path.basename(file)}: ${(e as Error).message}`); }
        }
      }
      for (const n of notes) log.appendLine(`Dataset: ${n}.`);
      if (notes.length) void vscode.window.showWarningMessage(`CGMES dataset: ${notes.join('; ')}.`);
    });
    issues.refresh();
    ui.refresh();
  };

  let diskTimer: NodeJS.Timeout | undefined;
  const pendingDisk = new Set<string>();
  const scheduleDisk = (files: string[]) => {
    files.forEach(f => pendingDisk.add(f));
    clearTimeout(diskTimer);
    diskTimer = setTimeout(() => {
      const list = [...pendingDisk];
      pendingDisk.clear();
      void (async () => { for (const f of list) { await new Promise<void>(r => setImmediate(r)); await validateFromDisk(f).catch(() => undefined); } issues.refresh(); })();
    }, 1000);
  };

  /** Forget diagnostics of files validated from disk that are no longer in the dataset. */
  const dropDisk = () => {
    for (const u of [...fromDisk]) {
      if (dataset.isSelected(vscode.Uri.parse(u).fsPath)) continue;
      fromDisk.delete(u); allProblems.delete(u); diagnostics.delete(vscode.Uri.parse(u));
    }
  };

  const ui = new DatasetUi(dataset, store, {
    validate: validateFiles,
    changed: () => {
      dropDisk();
      for (const d of vscode.workspace.textDocuments) if (allProblems.has(d.uri.toString())) schedule(d);
      issues.refresh();
    },
  });
  context.subscriptions.push(ui);

  const schedule = (doc: vscode.TextDocument) => {
    const k = doc.uri.toString();
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(async () => {
      timers.delete(k);
      // First check of a file: give the folder index a moment so dangling references are not
      // reported as merely unresolved and then changed. It is re-checked when the index is ready anyway.
      if (doc.isClosed) return;
      if (!isCandidate(doc)) { refresh(doc); updateStatus(); ui.refresh(); return; }
      if (doc.uri.scheme === 'file' && !allProblems.has(k) && dataset.covers(doc.uri.fsPath)) await dataset.whenReady(doc.uri.fsPath, 1500);
      if (doc.isClosed) return;
      refresh(doc); updateStatus(); ui.refresh();
    }, allProblems.has(k) ? 250 + Math.min(1000, doc.lineCount / 500) : 0)); // typing: wait for a pause; opening: at once
  };
  const removeUnsupportedLive = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme !== 'file' || !dataset.removeLive(doc.uri.fsPath)) return;
    const file = doc.uri.fsPath;
    for (const other of vscode.workspace.textDocuments) {
      if (other !== doc && allProblems.has(other.uri.toString()) && other.uri.scheme === 'file' &&
          (sameFolder(other.uri.fsPath, path.dirname(file)) || dataset.isSelected(other.uri.fsPath))) schedule(other);
    }
  };
  const updateStatus = () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isCimDocument(ed.document) || isEmptyDoc(ed.document)) { status.hide(); return; }
    if (!isCandidate(ed.document)) {
      if (/<[^>]*$/.test(headOf(ed.document).trim())) { status.hide(); return; }
      status.command = undefined;
      status.text = '$(circle-slash) Not a supported CIM file';
      status.tooltip = 'CIM profile hints and validation are disabled for this document.';
      status.show();
      return;
    }
    const k = ed.document.uri.toString();
    // A file checked from disk and not read again since it was opened: its summary is enough here.
    const hit = cache.get(k);
    const sum = hit?.version === ed.document.version ? summaryOf(hit.analysis) : summaries.get(k) ?? summaryOf(getAnalysis(ed.document));
    if (!sum.label || (!sum.isCim && !isEmptyDoc(ed.document))) { status.hide(); return; }
    status.command = 'cgmes.selectProfile';
    if (!hasXmlExtension(ed.document)) {
      status.text = '$(info) CIM validation requires a .xml file';
      status.tooltip = 'Profile hints are available, but validation only runs for files with the .xml extension.';
      status.show();
      return;
    }
    status.text = `$(symbol-class) ${sum.label} · ${sum.profiles}${sum.sub}`;
    status.tooltip = `CIM profile hints: ${sum.label}, ${sum.profiles} (${sum.source}). Click to change.`;
    status.show();
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => {
      const hit = cache.get(d.uri.toString());
      if (hit && !d.isDirty) rememberClosed(d.uri.toString(), hit.analysis);
      cache.delete(d.uri.toString());
      summaries.delete(d.uri.toString());
      if (d.uri.scheme === 'file') dataset.removeLive(d.uri.fsPath);
      // A file of the selected dataset keeps its problems, checked again from its saved text.
      if (d.uri.scheme === 'file' && dataset.isSelected(d.uri.fsPath) && allProblems.has(d.uri.toString())) { scheduleDisk([d.uri.fsPath]); return; }
      diagnostics.delete(d.uri); allProblems.delete(d.uri.toString());
    }),
    vscode.window.onDidChangeActiveTextEditor(() => { updateStatus(); ui.refresh(); }),
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('cgmes.schemaFolders') || e.affectsConfiguration('cgmes.propertyReferenceList')) await store.reload();
      if (e.affectsConfiguration('cgmes.crossFile.enabled') || e.affectsConfiguration('cgmes.crossFile.extraFolders') || e.affectsConfiguration('cgmes.crossFile.maxTotalSizeMB')) dataset.reset();
      if (e.affectsConfiguration('cgmes')) { configGeneration++; cache.clear(); closed.clear(); vscode.workspace.textDocuments.forEach(refresh); updateStatus(); }
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(SELECTOR, {
      provideCompletionItems(doc, pos) {
        if (!isCandidate(doc)) return undefined;
        const a = getAnalysis(doc);
        const results = complete(a, doc.offsetAt(pos), { insertRequired: cfg().get('completion.insertRequiredProperties', true) });
        return results.map(r => toItem(doc, r));
      },
    }, '<', '"', ':', '.'),

    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover(doc, pos) {
        if (!isCandidate(doc)) return undefined;
        const h = hover(getAnalysis(doc), doc.offsetAt(pos));
        if (!h) return undefined;
        const md = new vscode.MarkdownString(h.markdown);
        return new vscode.Hover(md, new vscode.Range(doc.positionAt(h.start), doc.positionAt(h.end)));
      },
    }),

    vscode.languages.registerDefinitionProvider(SELECTOR, {
      async provideDefinition(doc, pos) {
        if (!isCandidate(doc)) return undefined;
        const a = getAnalysis(doc);
        const local = definitionAt(a, doc.offsetAt(pos));
        if (local) return new vscode.Location(doc.uri, doc.positionAt(local.el.start));
        const ref = referenceAt(a, doc.offsetAt(pos));
        const key = ref && normalizeRef(ref);
        if (!key) return undefined;
        const selected = await navigationDataset(doc);
        if (!selected) return undefined;
        for (const f of selected.objects) {
          const fileKey = datasetFileKey(f.file);
          if (selected.invalid.has(fileKey)) continue;
          const current = selected.analyses.get(fileKey);
          const target = current?.objects.find(o => normalizeRef(o.id ?? o.about ?? '') === key);
          const offset = current ? target?.el.start : f.objectOffsets.get(key);
          if (offset === undefined) continue;
          try {
            const destination = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && datasetFileKey(d.uri.fsPath) === fileKey)
              ?? await vscode.workspace.openTextDocument(vscode.Uri.file(f.file));
            return new vscode.Location(destination.uri, destination.positionAt(offset));
          } catch (e) {
            log.appendLine(`Definition navigation to ${f.file} failed: ${(e as Error).message}`);
            void vscode.window.showWarningMessage(`CGMES could not open ${path.basename(f.file)}. See the CGMES output for details.`);
            return undefined;
          }
        }
        return undefined;
      },
    }),

    vscode.languages.registerReferenceProvider(SELECTOR, {
      async provideReferences(doc, pos) {
        if (!isCandidate(doc)) return undefined;
        const a = getAnalysis(doc);
        const rawRef = referenceAt(a, doc.offsetAt(pos));
        const object = rawRef ? undefined : objectOf(a, elementAt(a.doc, doc.offsetAt(pos)));
        const key = normalizeRef(rawRef ?? object?.id ?? object?.about ?? '');
        if (!key) return referencesAt(a, doc.offsetAt(pos)).map(r => new vscode.Location(doc.uri, new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end))));
        const local = referencesTo(a, key).map(r => new vscode.Location(doc.uri, new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end))));
        const selected = await navigationDataset(doc);
        if (!selected) return local;
        const currentFile = datasetFileKey(doc.uri.fsPath);
        const failures: string[] = [];
        for (const f of selected.objects) {
          const fileKey = datasetFileKey(f.file);
          if (fileKey === currentFile || selected.invalid.has(fileKey) || !f.references.has(key)) continue;
          const current = selected.analyses.get(fileKey);
          if (current) {
            for (const r of referencesTo(current, key)) {
              const destination = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && datasetFileKey(d.uri.fsPath) === datasetFileKey(f.file));
              if (destination) local.push(new vscode.Location(destination.uri, new vscode.Range(destination.positionAt(r.start), destination.positionAt(r.end))));
            }
            continue;
          }
          try {
            for (const r of await referenceLocationsOnDisk(f.file, key)) {
              local.push(new vscode.Location(vscode.Uri.file(f.file), new vscode.Range(r.line, r.character, r.line, r.character + r.length)));
            }
          } catch (e) {
            log.appendLine(`Reference search in ${f.file} failed: ${(e as Error).message}`);
            failures.push(path.basename(f.file));
          }
        }
        if (failures.length) void vscode.window.showWarningMessage(`CGMES could not search references in ${failures.join(', ')}. See the CGMES output for details.`);
        return local;
      },
    }),

    vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
      provideDocumentSymbols(doc) {
        if (!isCandidate(doc)) return undefined;
        const a = getAnalysis(doc);
        if (!a.isCim) return undefined;
        const byType = new Map<string, vscode.DocumentSymbol[]>();
        for (const o of a.objects) {
          const end = o.el.end >= 0 ? o.el.end : o.el.nameEnd;
          const range = new vscode.Range(doc.positionAt(o.el.start), doc.positionAt(end));
          const sel = new vscode.Range(doc.positionAt(o.el.nameStart), doc.positionAt(o.el.nameEnd));
          const sym = new vscode.DocumentSymbol(o.name ?? o.id ?? o.about ?? o.el.name, o.el.name, vscode.SymbolKind.Object, range, sel);
          const t = o.type ? localName(o.type) : o.el.name;
          let list = byType.get(t);
          if (!list) byType.set(t, list = []);
          list.push(sym);
        }
        return [...byType.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([t, syms]) => {
          const g = new vscode.DocumentSymbol(`${t} (${syms.length})`, '', vscode.SymbolKind.Class, syms[0].range.union(syms[syms.length - 1].range), syms[0].selectionRange);
          g.children = syms;
          return g;
        });
      },
    }),

    vscode.languages.registerCodeActionsProvider(SELECTOR, { provideCodeActions }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cgmes.selectVersion', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const pick = await vscode.window.showQuickPick(
        [{ label: 'Automatic', id: 'auto', description: 'detect from namespaces and header' },
          ...store.indexes.map(i => ({ label: i.bundle.label, id: i.bundle.id, description: i.bundle.source }))],
        { placeHolder: 'CIM version for this file' },
      );
      if (!pick) return;
      await setOverride(ed.document, { version: pick.id === 'auto' ? undefined : pick.id, profiles: undefined });
      refresh(ed.document); updateStatus();
    }),

    vscode.commands.registerCommand('cgmes.selectProfile', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const a = getAnalysis(ed.document);
      if (!a.index) return;
      const items: (vscode.QuickPickItem & { keyword?: string; changeVersion?: boolean })[] = [
        { label: '$(versions) Change version…', description: a.index.bundle.label, changeVersion: true },
        { label: 'Automatic', description: 'from md:Model.profile in the header' },
        ...a.index.profiles.map(p => ({ label: p.keyword, keyword: p.keyword, description: p.title, picked: a.active.includes(p) })),
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Profile for this file (${a.index.bundle.label})` });
      if (!pick) return;
      if (pick.changeVersion) return vscode.commands.executeCommand('cgmes.selectVersion');
      await setOverride(ed.document, { profiles: pick.keyword ? [pick.keyword] : undefined });
      refresh(ed.document); updateStatus();
    }),

    vscode.commands.registerCommand('cgmes.newDocument', async () => {
      const ver = await vscode.window.showQuickPick(store.indexes.map(i => ({ label: i.bundle.label, index: i })), { placeHolder: 'CIM version' });
      if (!ver) return;
      const prof = await vscode.window.showQuickPick(
        ver.index.profiles.filter(p => Object.values(p.classes).some(c => c.concrete)).map(p => ({ label: p.keyword, description: p.title, p })),
        { placeHolder: 'Profile' },
      );
      if (!prof) return;
      const doc = await vscode.workspace.openTextDocument({ language: 'xml', content: '' });
      const ed = await vscode.window.showTextDocument(doc);
      await setOverride(doc, { version: ver.index.bundle.id, profiles: [prof.p.keyword] });
      await ed.insertSnippet(new vscode.SnippetString(documentSnippet(ver.index, [prof.p])));
    }),

    vscode.commands.registerCommand('cgmes.reloadProfiles', async () => {
      await store.reload();
      configGeneration++;
      cache.clear();
      closed.clear();
      vscode.workspace.textDocuments.forEach(refresh);
      updateStatus();
      void vscode.window.showInformationMessage(`CGMES: loaded ${store.indexes.map(i => i.bundle.label).join(', ')}`);
    }),

    vscode.commands.registerCommand('cgmes.insertProperties', async (uri: vscode.Uri, elementStart: number, props: string[]) => {
      const ed = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
      if (!ed) return;
      const doc = ed.document;
      const a = getAnalysis(doc);
      const el = elementAt(a.doc, elementStart);
      if (!el || !a.index) return;
      const defs = props.map(p => a.index!.propDef(p, a.active)).filter(<T>(x: T | undefined): x is T => !!x);
      const lineIndent = /^\s*/.exec(doc.lineAt(doc.positionAt(el.start).line).text)![0];
      const unit = ed.options.insertSpaces ? ' '.repeat(Number(ed.options.tabSize) || 2) : '\t';
      const body = defs.map((p, i) => `<${propertySnippet(a, p, i + 1)}`);
      if (el.selfClosing) {
        // <cim:X rdf:ID="..."/>  ->  <cim:X rdf:ID="...">...</cim:X>
        const pos = doc.positionAt(el.startTagEnd - 2);
        const snippet = `>\n${body.map(b => lineIndent + unit + b).join('\n')}\n${lineIndent}</${el.name}`;
        await ed.insertSnippet(new vscode.SnippetString(snippet), new vscode.Range(pos, doc.positionAt(el.startTagEnd - 1)));
        return;
      }
      if (el.closeStart < 0) return;
      const pos = doc.positionAt(el.closeStart);
      const closeLine = doc.lineAt(pos.line);
      const onOwnLine = closeLine.text.slice(0, pos.character).trim() === '';
      const snippet = onOwnLine
        ? body.map(b => unit + b).join('\n' + lineIndent) + '\n' + lineIndent
        : '\n' + body.map(b => lineIndent + unit + b).join('\n') + '\n' + lineIndent;
      await ed.insertSnippet(new vscode.SnippetString(snippet), onOwnLine ? new vscode.Position(pos.line, closeLine.firstNonWhitespaceCharacterIndex) : pos);
    }),
  );

  vscode.workspace.textDocuments.forEach(schedule);
  updateStatus();
  issues.refresh();
}

function toItem(doc: vscode.TextDocument, r: CompletionResult): vscode.CompletionItem {
  const item = new vscode.CompletionItem(r.label, KIND[r.kind]);
  item.detail = r.detail;
  if (r.documentation) item.documentation = new vscode.MarkdownString(r.documentation);
  item.insertText = new vscode.SnippetString(r.insertText);
  item.filterText = r.filterText;
  item.sortText = r.sortText;
  item.range = new vscode.Range(doc.positionAt(r.replaceStart), doc.positionAt(r.replaceEnd));
  if (r.retrigger) item.command = { command: 'editor.action.triggerSuggest', title: 'Pick target' };
  return item;
}

function provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
  const out: vscode.CodeAction[] = [];
  if (!isCandidate(doc)) return out;
  const a = getAnalysis(doc);
  for (const d of ctx.diagnostics) {
    const p = problemData.get(d);
    if (!p) continue;
    const replacements = (p.data?.replacements as string[] | undefined) ?? [];
    if ((p.code === 'wrong-namespace' || p.code === 'unknown-property') && replacements.length) {
      const el = elementAt(a.doc, p.start);
      for (const r of replacements) {
        const fix = new vscode.CodeAction(`Change to ${r}`, vscode.CodeActionKind.QuickFix);
        fix.diagnostics = [d];
        fix.isPreferred = replacements.length === 1;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, d.range, r);
        if (el && el.closeStart >= 0 && el.nameStart === p.start) {
          const s = el.closeStart + 2;
          edit.replace(doc.uri, new vscode.Range(doc.positionAt(s), doc.positionAt(s + el.name.length)), r);
        }
        fix.edit = edit;
        out.push(fix);
      }
    }
    if (p.code === 'property-reference') {
      for (const r of replacements) {
        const fix = new vscode.CodeAction(`Change to ${localName(r)}`, vscode.CodeActionKind.QuickFix);
        fix.diagnostics = [d];
        fix.isPreferred = true;
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(doc.uri, d.range, r);
        out.push(fix);
      }
    }
    if (p.code === 'enum-value') {
      for (const r of replacements.slice(0, 12)) {
        const fix = new vscode.CodeAction(`Use ${localName(r)}`, vscode.CodeActionKind.QuickFix);
        fix.diagnostics = [d];
        fix.isPreferred = replacements.length === 1;
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(doc.uri, d.range, r);
        out.push(fix);
      }
    }
    if (p.code === 'undeclared-prefix' && a.root && a.index) {
      const prefix = p.data?.prefix as string;
      const uri = a.index.bundle.namespaces[prefix];
      if (uri) {
        const fix = new vscode.CodeAction(`Declare xmlns:${prefix}="${uri}"`, vscode.CodeActionKind.QuickFix);
        fix.diagnostics = [d];
        fix.isPreferred = true;
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.insert(doc.uri, doc.positionAt(a.root.nameEnd), ` xmlns:${prefix}="${uri}"`);
        out.push(fix);
      }
    }
    if (p.code === 'missing-required') {
      const props = (p.data?.properties as string[]) ?? [];
      const fix = new vscode.CodeAction(
        props.length === 1 ? `Add ${qname(a, props[0])}` : `Add ${props.length} missing required properties`,
        vscode.CodeActionKind.QuickFix,
      );
      fix.diagnostics = [d];
      fix.isPreferred = true;
      fix.command = { command: 'cgmes.insertProperties', title: 'Add properties', arguments: [doc.uri, p.start - 1, props] };
      out.push(fix);
    }
  }
  return out;
}

export function deactivate() {
  cache.clear();
  closed.clear();
}
