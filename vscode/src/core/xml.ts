// Small, error-tolerant XML scanner that keeps source offsets.
// It is written for CIM/XML and RDFS files, which are shallow and regular,
// and it must cope with half-typed documents while the user is editing.

export interface XmlAttr {
  name: string;
  nameStart: number;
  nameEnd: number;
  value: string;
  /** Offset of the first character inside the quotes (or where it would be). */
  valueStart: number;
  /** Offset just after the last character inside the quotes. */
  valueEnd: number;
  /** Raw value without entity decoding. */
  raw: string;
}

export interface XmlElement {
  name: string;
  start: number;
  nameStart: number;
  nameEnd: number;
  /** Offset just after '>' of the start tag, or -1 when the start tag is not closed. */
  startTagEnd: number;
  selfClosing: boolean;
  /** Offset of '<' of the end tag, or -1 when missing. */
  closeStart: number;
  /** Offset just after the element (end tag '>' or '/>'), or -1 when unclosed. */
  end: number;
  attrs: XmlAttr[];
  children: XmlElement[];
  parent?: XmlElement;
  /** Prefix -> namespace declared on this element or inherited. */
  ns: Map<string, string>;
}

export interface XmlDocument {
  text: string;
  root?: XmlElement;
  /** All top-level elements (normally just one). */
  roots: XmlElement[];
  problems: { start: number; end: number; message: string }[];
}

// Character tests by code (a regular expression per character is the parser's main cost on large files).
const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 11 || c === 12 || c === 160;
/** Anything but whitespace, = / > " ' < (and the end of the text). */
const isNameChar = (c: number) => c === c && !isSpace(c) && c !== 61 && c !== 47 && c !== 62 && c !== 34 && c !== 39 && c !== 60;

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e: string) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return m;
  });
}

export function parseXml(text: string): XmlDocument {
  const doc: XmlDocument = { text, roots: [], problems: [] };
  const stack: XmlElement[] = [];
  const n = text.length;
  let i = 0;

  const top = () => stack[stack.length - 1];

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const e = text.indexOf('?>', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (text.startsWith('<!', i)) {
      const e = text.indexOf('>', i + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (text[i + 1] === '/') {
      // End tag
      let j = i + 2;
      while (j < n && isNameChar(text.charCodeAt(j))) j++;
      const name = text.slice(i + 2, j);
      const gt = text.indexOf('>', j);
      const nextLt = text.indexOf('<', j);
      const tagEnd = gt < 0 || (nextLt >= 0 && nextLt < gt) ? j : gt + 1;
      // Find the matching open element.
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== name) k--;
      if (k < 0) {
        doc.problems.push({ start: i, end: tagEnd, message: `Unexpected end tag </${name}>` });
      } else {
        for (let u = stack.length - 1; u > k; u--) {
          const el = stack[u];
          doc.problems.push({ start: el.nameStart, end: el.nameEnd, message: `Element <${el.name}> is not closed` });
        }
        const el = stack[k];
        el.closeStart = i;
        el.end = tagEnd;
        stack.length = k;
      }
      i = tagEnd;
      continue;
    }

    // Start tag
    let j = i + 1;
    while (j < n && isNameChar(text.charCodeAt(j))) j++;
    const parent = top();
    const el: XmlElement = {
      name: text.slice(i + 1, j),
      start: i,
      nameStart: i + 1,
      nameEnd: j,
      startTagEnd: -1,
      selfClosing: false,
      closeStart: -1,
      end: -1,
      attrs: [],
      children: [],
      parent,
      ns: parent ? parent.ns : new Map(),
    };
    // Attributes
    while (j < n) {
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (j >= n) break;
      const c = text[j];
      if (c === '>') { el.startTagEnd = j + 1; j++; break; }
      if (c === '/' && text[j + 1] === '>') { el.startTagEnd = j + 2; el.selfClosing = true; el.end = j + 2; j += 2; break; }
      if (c === '<') break; // unclosed start tag
      if (c === '/') { j++; continue; }
      const ns = j;
      while (j < n && isNameChar(text.charCodeAt(j))) j++;
      if (j === ns) { j++; continue; }
      const attr: XmlAttr = { name: text.slice(ns, j), nameStart: ns, nameEnd: j, value: '', valueStart: j, valueEnd: j, raw: '' };
      let k = j;
      while (k < n && isSpace(text.charCodeAt(k))) k++;
      if (text[k] === '=') {
        k++;
        while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
        const q = text[k];
        if (q === '"' || q === "'") {
          let e = k + 1;
          while (e < n && text[e] !== q && text[e] !== '\n' && text[e] !== '<') e++;
          attr.valueStart = k + 1;
          attr.valueEnd = e;
          attr.raw = text.slice(k + 1, e);
          j = text[e] === q ? e + 1 : e;
        } else {
          let e = k;
          while (e < n && !isSpace(text.charCodeAt(e)) && text.charCodeAt(e) !== 62) e++;
          attr.valueStart = k;
          attr.valueEnd = e;
          attr.raw = text.slice(k, e);
          j = e;
        }
        attr.value = decodeEntities(attr.raw);
      }
      el.attrs.push(attr);
    }
    if (el.startTagEnd < 0) el.end = j; // start tag still being typed
    // Namespace declarations
    let nsCopied = false;
    for (const a of el.attrs) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) {
        if (!nsCopied) { el.ns = new Map(el.ns); nsCopied = true; }
        el.ns.set(a.name === 'xmlns' ? '' : a.name.slice(6), a.value.trim());
      }
    }
    if (parent) parent.children.push(el); else doc.roots.push(el);
    if (!el.selfClosing && el.startTagEnd >= 0) stack.push(el);
    i = el.startTagEnd >= 0 ? el.startTagEnd : j;
  }
  for (const el of stack) {
    doc.problems.push({ start: el.nameStart, end: el.nameEnd, message: `Element <${el.name}> is not closed` });
  }
  doc.root = doc.roots[0];
  return doc;
}

export function attr(el: XmlElement, name: string): XmlAttr | undefined {
  return el.attrs.find(a => a.name === name);
}

/** Text content of a leaf element (entity-decoded, markup stripped). */
export function textContent(doc: XmlDocument, el: XmlElement): string {
  if (el.selfClosing || el.startTagEnd < 0) return '';
  const end = el.closeStart >= 0 ? el.closeStart : (el.children[0]?.start ?? el.startTagEnd);
  let s = doc.text.slice(el.startTagEnd, end);
  if (el.children.length) s = s.replace(/<[^>]*>/g, '');
  if (s.includes('<![CDATA[')) s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(s);
}

/** Offsets of the text content (between the tags). */
export function contentRange(el: XmlElement): { start: number; end: number } | undefined {
  if (el.selfClosing || el.startTagEnd < 0 || el.closeStart < 0) return undefined;
  return { start: el.startTagEnd, end: el.closeStart };
}

export function splitQName(name: string): { prefix: string; local: string } {
  const i = name.indexOf(':');
  return i < 0 ? { prefix: '', local: name } : { prefix: name.slice(0, i), local: name.slice(i + 1) };
}

/** Expand a QName against the element's namespace scope. */
export function expandName(el: XmlElement, name: string): string | undefined {
  const { prefix, local } = splitQName(name);
  if (prefix === 'xml') return 'http://www.w3.org/XML/1998/namespace' + local;
  const ns = el.ns.get(prefix);
  return ns === undefined ? undefined : ns + local;
}

/** Innermost element whose range contains offset. */
export function elementAt(doc: XmlDocument, offset: number): XmlElement | undefined {
  const endOf = (el: XmlElement) => el.end >= 0 ? el.end : (el.startTagEnd >= 0 && el.selfClosing ? el.startTagEnd : Number.MAX_SAFE_INTEGER);
  let found: XmlElement | undefined;
  let list = doc.roots;
  for (;;) {
    // Siblings are in document order: binary search for the last one starting at or before offset.
    let lo = 0, hi = list.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= offset) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let next: XmlElement | undefined;
    // The one before can still contain it when the last one is unclosed (a document being typed).
    for (let k = at; k >= 0 && k >= at - 1; k--) {
      if (offset < endOf(list[k])) { next = list[k]; break; }
    }
    if (!next) return found;
    found = next;
    list = next.children;
  }
}
