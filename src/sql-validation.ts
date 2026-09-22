import { FacetError } from './errors.js';

/** Reject statement delimiters outside SQLite quotes/comments before prepare().
 * node:sqlite prepare() ignores trailing statements; never depend on it for this check.
 * This is a lexical boundary check, not a SQL parser or an authorization mechanism.
 */
export function validateSingleSql(sql: string): void {
  if (sql.includes('\0')) throw new FacetError('INVALID_ARGUMENT', 'SQL must not contain NUL bytes');
  let first = '';
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new FacetError('INVALID_ARGUMENT', 'Unterminated SQL comment');
      i = end + 2; continue;
    }
    if (c === ';') throw new FacetError('INVALID_ARGUMENT', 'Only one SQL statement is allowed; omit the trailing semicolon');
    if (!first) {
      const match = /^[a-z]+/i.exec(sql.slice(i));
      first = match?.[0].toUpperCase() ?? '';
      if (first !== 'SELECT' && first !== 'WITH') throw new FacetError('INVALID_ARGUMENT', 'Only SELECT or WITH queries are allowed');
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const endQuote = c === '[' ? ']' : c;
      let closed = false; i++;
      while (i < sql.length) {
        if (sql[i++] !== endQuote) continue;
        if (c !== '[' && sql[i] === endQuote) { i++; continue; }
        closed = true; break;
      }
      if (!closed) throw new FacetError('INVALID_ARGUMENT', 'Unterminated SQL quote');
      continue;
    }
    if (c === '(') depth++;
    if (c === ')' && --depth < 0) throw new FacetError('INVALID_ARGUMENT', 'Unbalanced SQL parentheses');
    i++;
  }
  if (!first || depth !== 0) throw new FacetError('INVALID_ARGUMENT', 'Empty SQL or unbalanced parentheses');
}
