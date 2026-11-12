// "CIM Issues" view: every diagnostic the extension reports on the active file, split by where
// the rule comes from (RDFS schema, SHACL, reference data, CIM/XML file rules), then grouped by
// severity or by check, with the object it belongs to. Clicking an issue jumps to it.

import * as vscode from 'vscode';
import { RuleSource } from './core/validate';
import { DatasetNode } from './datasetUi';

type GroupBy = 'severity' | 'code';

interface Section { kind: 'section'; label: string; tooltip: string; icon: vscode.ThemeIcon; groups: Group[]; count: number }
interface Group { kind: 'group'; label: string; icon: vscode.ThemeIcon; issues: Issue[] }
/** also: the other rule sets the same problem breaks (it is listed in each of their sections). */
/** owner is worked out when the issue is first shown (it needs the file's analysis). */
interface Issue { kind: 'issue'; uri: vscode.Uri; d: vscode.Diagnostic; doc: vscode.TextDocument; owner?: string | null; also?: string }
interface DatasetHead { kind: 'dataset'; node: DatasetNode }
interface DatasetFile { kind: 'dsfile'; file: DatasetNode['files'][number]; active: boolean }
type Node = DatasetHead | DatasetFile | Section | Group | Issue;

type Rule = RuleSource;

/** Diagnostic.source for the rule sets a problem breaks; also what the Problems panel shows. */
export function sourceLabel(rules: readonly Rule[]): string {
  if (rules.includes('schema') && rules.includes('shacl')) return 'CGMES schema + SHACL';
  return { schema: 'CGMES schema', shacl: 'CGMES SHACL', reference: 'CGMES reference data', file: 'CIM/XML', dataset: 'CGMES dataset' }[rules[0] ?? 'schema'];
}

const SECTIONS: { rule: Rule; label: string; tooltip: string; icon: string }[] = [
  { rule: 'schema', label: 'Schema (RDFS)', icon: 'symbol-class',
    tooltip: 'Classes, properties, multiplicities, data types and enumerations from the RDFS profile definitions.' },
  { rule: 'shacl', label: 'SHACL', icon: 'shield',
    tooltip: 'Everything a SHACL shape rejects, including what the RDFS rejects too ("also schema").' },
  { rule: 'dataset', label: 'Cross-file references', icon: 'references',
    tooltip: 'Checks against the other CIM files of the folder (EQ, SSH, TP, SV, NC profiles): dangling references, and objects described with rdf:about that are missing or of another class there. A reference to an object of the wrong class in another file is listed under Schema or SHACL, naming that file.' },
  { rule: 'reference', label: 'Reference data', icon: 'book',
    tooltip: 'Values checked against ENTSO-E reference data (PropertyReference list).' },
  { rule: 'file', label: 'File and identifiers', icon: 'file-code',
    tooltip: 'XML syntax, namespace prefixes, header, identifiers and references between objects.' },
];
const SHORT: Record<Rule, string> = { schema: 'schema', shacl: 'SHACL', reference: 'reference data', file: 'file', dataset: 'dataset' };

const SEVERITIES: { s: vscode.DiagnosticSeverity; label: string; icon: string; color: string }[] = [
  { s: vscode.DiagnosticSeverity.Error, label: 'Errors', icon: 'error', color: 'problemsErrorIcon.foreground' },
  { s: vscode.DiagnosticSeverity.Warning, label: 'Warnings', icon: 'warning', color: 'problemsWarningIcon.foreground' },
  { s: vscode.DiagnosticSeverity.Information, label: 'Infos', icon: 'info', color: 'problemsInfoIcon.foreground' },
  { s: vscode.DiagnosticSeverity.Hint, label: 'Hints', icon: 'lightbulb', color: 'problemsInfoIcon.foreground' },
];

function severityIcon(s: vscode.DiagnosticSeverity): vscode.ThemeIcon {
  const e = SEVERITIES.find(x => x.s === s)!;
  return new vscode.ThemeIcon(e.icon, new vscode.ThemeColor(e.color));
}

export class IssuesView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private sections: Section[] = [];
  private head?: DatasetHead;
  private uri: vscode.Uri | undefined;
  private groupBy: GroupBy;
  readonly tree: vscode.TreeView<Node>;

  /** owner(uri, offset) names the object an issue sits in, e.g. "ACLineSegment 'Line 1'". */
  constructor(
    private readonly problems: (uri: vscode.Uri) => readonly vscode.Diagnostic[] | undefined,
    private readonly rulesOf: (d: vscode.Diagnostic) => readonly Rule[],
    private readonly owner: (doc: vscode.TextDocument, offset: number) => string | undefined,
    private readonly accept: (doc: vscode.TextDocument) => boolean,
    private readonly state: vscode.Memento,
    /** The files the active file is checked against (dataset bar). */
    private readonly datasetNode: () => DatasetNode | undefined = () => undefined,
  ) {
    this.groupBy = state.get<GroupBy>('cgmes.issues.groupBy', 'severity');
    this.tree = vscode.window.createTreeView('cgmes.issues', { treeDataProvider: this, showCollapseAll: true });
    void vscode.commands.executeCommand('setContext', 'cgmes.issues.groupBy', this.groupBy);
  }

  async toggleGrouping(): Promise<void> {
    this.groupBy = this.groupBy === 'severity' ? 'code' : 'severity';
    await this.state.update('cgmes.issues.groupBy', this.groupBy);
    await vscode.commands.executeCommand('setContext', 'cgmes.issues.groupBy', this.groupBy);
    this.refresh();
  }

  /** Rebuilds the view for the active editor (call when it or its diagnostics change). */
  refresh(): void {
    const ed = vscode.window.activeTextEditor;
    // With no active editor (focus in a panel) keep showing the last CIM file.
    if (ed) this.uri = this.accept(ed.document) ? ed.document.uri : undefined;
    const doc = this.uri && vscode.workspace.textDocuments.find(d => d.uri.toString() === this.uri!.toString());
    const list = doc ? [...(this.problems(doc.uri) ?? [])] : [];
    list.sort((a, b) => a.range.start.compareTo(b.range.start));
    const issues: Issue[] = list.map(d => ({ kind: 'issue', uri: doc!.uri, d, doc: doc! }));

    this.sections = SECTIONS.map(sec => {
      // A problem that breaks several rule sets is listed in each section, marked "also …".
      const mine = issues.filter(i => this.rulesOf(i.d).includes(sec.rule)).map(i => {
        const others = this.rulesOf(i.d).filter(r => r !== sec.rule).map(r => SHORT[r]);
        return { ...i, also: others.length ? `also ${others.join(', ')}` : undefined };
      });
      return { kind: 'section' as const, label: sec.label, tooltip: sec.tooltip, icon: new vscode.ThemeIcon(sec.icon), groups: this.group(mine), count: mine.length };
    }).filter(sec => sec.count);
    const ds = doc ? this.datasetNode() : undefined;
    this.head = ds && { kind: 'dataset', node: ds };
    const count = (s: vscode.DiagnosticSeverity) => issues.filter(i => i.d.severity === s).length;
    this.tree.badge = issues.length ? { value: issues.length, tooltip: `${issues.length} CIM issues` } : undefined;
    this.tree.description = doc ? `${count(0)} errors, ${count(1)} warnings, ${count(2) + count(3)} other` : undefined;
    this.tree.message = !doc ? 'Open a CIM/XML file to see its issues.'
      : !issues.length ? `No issues in ${doc.uri.path.split('/').pop()}.` : undefined;
    this.changed.fire(undefined);
  }

  private group(issues: Issue[]): Group[] {
    if (this.groupBy === 'severity') {
      return SEVERITIES
        .map(s => ({ kind: 'group' as const, label: s.label, icon: severityIcon(s.s), issues: issues.filter(i => i.d.severity === s.s) }))
        .filter(g => g.issues.length);
    }
    const byCode = new Map<string, Issue[]>();
    for (const i of issues) {
      const c = String(i.d.code ?? 'other');
      byCode.set(c, [...(byCode.get(c) ?? []), i]);
    }
    return [...byCode.entries()]
      .map(([code, is]) => ({ kind: 'group' as const, label: code, icon: severityIcon(Math.min(...is.map(i => i.d.severity))), issues: is }))
      .sort((a, b) => b.issues.length - a.issues.length || a.label.localeCompare(b.label));
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.head ? [this.head, ...this.sections] : this.sections;
    if (node.kind === 'dataset') {
      return node.node.files.map(file => ({ kind: 'dsfile' as const, file, active: file.uri.toString() === this.uri?.toString() }));
    }
    return node.kind === 'section' ? node.groups : node.kind === 'group' ? node.issues : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'dataset') {
      // Starts folded: the sections below are what matters most of the time.
      const item = new vscode.TreeItem(node.node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'cgmes.dataset';
      item.description = node.node.description;
      item.tooltip = new vscode.MarkdownString(node.node.tooltip);
      item.iconPath = new vscode.ThemeIcon('references');
      item.contextValue = 'cgmesDataset';
      return item;
    }
    if (node.kind === 'dsfile') {
      const item = new vscode.TreeItem(node.file.label, vscode.TreeItemCollapsibleState.None);
      item.description = (node.active ? 'this file · ' : '') + node.file.description;
      item.resourceUri = node.file.uri;
      item.iconPath = new vscode.ThemeIcon(node.active ? 'arrow-right' : 'file-code');
      item.command = { command: 'vscode.open', title: 'Open', arguments: [node.file.uri] };
      return item;
    }
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      const n = (s: vscode.DiagnosticSeverity) => node.groups.flatMap(g => g.issues).filter(i => i.d.severity === s).length;
      const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
      item.description = [plural(n(0), 'error'), plural(n(1), 'warning'), n(2) + n(3) ? `${n(2) + n(3)} other` : ''].filter(Boolean).join(', ');
      item.tooltip = node.tooltip;
      item.iconPath = node.icon;
      return item;
    }
    if (node.kind === 'group') {
      // Long groups (e.g. thousands of references into EQ) start folded.
      const item = new vscode.TreeItem(node.label, node.issues.length > 200 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.issues.length);
      item.iconPath = node.icon;
      return item;
    }
    const { d } = node;
    if (node.owner === undefined) node.owner = this.owner(node.doc, node.doc.offsetAt(d.range.start)) ?? null;
    const item = new vscode.TreeItem(d.message.split('\n')[0], vscode.TreeItemCollapsibleState.None);
    const where = `line ${d.range.start.line + 1}`;
    item.description = [where, node.owner, this.groupBy === 'severity' ? d.code : undefined, node.also].filter(Boolean).join(' · ');
    item.tooltip = new vscode.MarkdownString(`**${d.code ?? ''}** · ${where}${node.owner ? ` · ${node.owner}` : ''}\n\n${d.message}`);
    item.iconPath = severityIcon(d.severity);
    item.command = { command: 'cgmes.revealIssue', title: 'Go to issue', arguments: [node.uri, d.range] };
    return item;
  }
}

export async function revealIssue(uri: vscode.Uri, range: vscode.Range): Promise<void> {
  const ed = await vscode.window.showTextDocument(uri, { selection: range, preserveFocus: false });
  ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
