import ts from 'typescript';
import type {Plugin} from 'vite';
import {english} from '../src/i18n/catalog';

const displayAttributes = new Set(['title', 'aria-label', 'aria-description', 'alt', 'placeholder', 'label', 'description', 'caption', 'message', 'hint', 'detail', 'empty', 'heading', 'subtitle', 'unit', 'name', 'help', 'prefix', 'suffix', 'actionLabel']);
const messageFields = new Set(['error','viewError','preferenceError','message','reason','notice','diagnostic','description','warning','lastError']);
const storedMessages = /^(?:set(?:Error|Saved|Message|Warning|Feedback|Notice)|Error)$/;
const has = (key:string) => Object.hasOwn(english,key);
const quote = JSON.stringify;

/** Localize authored UI strings before React compiles JSX. Data bindings are kept intact. */
export function localizeSource(file: string, source: string): string | undefined {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const pos = (n:ts.Node) => n.getStart(tree);
  const raw = (n:ts.Node) => source.slice(pos(n), n.end);
  let changed = false;
  const mark = (text:string) => { changed = true; return text; };
  function literal(value: string): string | undefined {
    if (has(value)) return '__mlText('+quote(value)+')';
    const key=value.trim();
    if (!key || !has(key)) return;
    const index=value.indexOf(key), before=value.slice(0,index), after=value.slice(index+key.length);
    return '('+[before && quote(before), '__mlText('+quote(key)+')', after && quote(after)].filter(Boolean).join(' + ')+')';
  }
  function children(n:ts.Node):string {
    let start=pos(n), result='';
    n.forEachChild(child => {
      const at=ts.isJsxText(child) ? child.pos : pos(child);
      result+=source.slice(start,at)+visit(child);
      start=child.end;
    });
    return result+source.slice(start,n.end);
  }
  function visit(n:ts.Node):string {
    const p=n.parent;
    if (ts.isTypeNode(n) || ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTaggedTemplateExpression(n)) return raw(n);
    if (ts.isJsxText(n)) {
      const value=source.slice(n.pos,n.end);
      if (!value.trim()) return value;
      const expression=literal(value);
      return expression ? mark('{'+expression+'}') : value;
    }
    if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer)) {
      if (!displayAttributes.has(n.name.getText(tree))) return raw(n);
      const expression=literal(n.initializer.text);
      return expression ? mark(n.name.getText(tree)+'={'+expression+'}') : raw(n);
    }
    if (ts.isStringLiteralLike(n)) {
      if (p && ((ts.isPropertyAssignment(p) && p.name===n) || ts.isElementAccessExpression(p) || ts.isCaseClause(p))) return raw(n);
      if (n.text==='tr-TR' && p && (ts.isCallExpression(p)||ts.isNewExpression(p)) &&
          /(?:Intl\.(?:NumberFormat|DateTimeFormat|Collator)|\.toLocale(?:DateString|TimeString|String))$/.test(p.expression.getText(tree)))
        return mark('__mlLocale()');
      const expression=literal(n.text);
      return expression ? mark(expression) : raw(n);
    }
    if (ts.isTemplateExpression(n)) {
      const key=n.head.text+n.templateSpans.map((s,i)=>'{'+i+'}'+s.literal.text).join('');
      if (has(key)) return mark('__mlText('+[quote(key), ...n.templateSpans.map(s=>visit(s.expression))].join(', ')+')');
    }
    // Keep queued notifications and errors in their source language until displayed.
    if ((ts.isCallExpression(n)||ts.isNewExpression(n)) && storedMessages.test(n.expression.getText(tree))) return raw(n);
    if (ts.isJsxExpression(n) && n.expression && (!ts.isJsxAttribute(p) || displayAttributes.has(p.name.getText(tree)))) {
      const expression=n.expression;
      const value=visit(expression);
      if (/\b(?:error|viewError|preferenceError|diagnostic|message|warning|notice|reason|saved|feedback)\b/i.test(expression.getText(tree)) &&
          !/=>|<\w/.test(value) && (ts.isIdentifier(expression)||ts.isPropertyAccessExpression(expression)||ts.isBinaryExpression(expression))) {
        return mark('{__mlMessage('+value+')}');
      }
      return '{'+value+'}';
    }
    if (ts.isPropertyAccessExpression(n) && messageFields.has(n.name.text) && p &&
        !ts.isPropertyAccessExpression(p) && !(ts.isBinaryExpression(p) && p.left===n && p.operatorToken.kind===ts.SyntaxKind.EqualsToken))
      return mark('__mlMessage('+children(n)+')');
    if (ts.isCallExpression(n) && n.expression.getText(tree)==='useMemo' && n.arguments.length===2 && ts.isArrayLiteralExpression(n.arguments[1])) {
      const array=n.arguments[1], values=array.elements.map(visit);
      return mark('useMemo('+visit(n.arguments[0])+', ['+[...values,'__mlLocale()'].join(', ')+'])');
    }
    if (ts.isVariableStatement(n) && ts.isSourceFile(p)) {
      const updates:string[]=[];
      for (const d of n.declarationList.declarations) {
        if (!d.initializer || !ts.isIdentifier(d.name) || ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) continue;
        const initial=visit(d.initializer);
        if (initial.includes('__mlText(') || initial.includes('__mlLocale(')) updates.push(d.name.text+' = '+initial);
      }
      const value=children(n);
      if (updates.length) return mark(value.replace(/^(export\s+)?const\b/, '$1let')+'\n__mlSubscribe(() => { '+updates.join('; ')+'; });');
      return value;
    }
    return children(n);
  }
  let start=0, out='';
  for(const statement of tree.statements) {
    out+=source.slice(start,pos(statement))+visit(statement);
    start=statement.end;
  }
  if (!changed) return;
  const root=file.slice(0,file.lastIndexOf('/src/')+5), depth=file.slice(root.length).split('/').length-1;
  const relative=depth?'../'.repeat(depth):'./';
  return 'import {translate as __mlText, serviceMessage as __mlMessage} from '+quote(relative+'i18n/catalog')+';\n'+
    'import {currentLocale as __mlLocale, subscribeLanguage as __mlSubscribe} from '+quote(relative+'i18n/locale')+';\n'+out+source.slice(start);
}

export function localizeUi(): Plugin {
  return {name:'midgard-offline-language', enforce:'pre', transform(source,id) {
    const file=id.split('?')[0].replaceAll('\\','/');
    if (!/\/src\/(?:App\.tsx|(?:components|hooks|domain|shared)\/[^/]+\.tsx?)$/.test(file) || file.endsWith('.test.ts')) return;
    return localizeSource(file,source);
  }};
}
