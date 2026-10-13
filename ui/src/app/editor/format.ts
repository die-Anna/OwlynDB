import { format, type SqlLanguage } from 'sql-formatter';
import type { Dialect } from '../../../../shared/api-types';
import { formatRequest, isConsoleRequest, splitEs } from '../../../../shared/es-console';
import { splitSql } from '../../../../shared/sql-splitter';

const LANGUAGE: Record<Dialect, SqlLanguage> = { mysql: 'mysql', postgres: 'postgresql', mssql: 'transactsql', elasticsearch: 'sql' };

export interface FormatResult {
  text: string;
  /** Anweisungen, die unverändert blieben (nicht lesbar für den Formatierer, eigener DELIMITER) */
  skipped: number;
}

/**
 * Jede Anweisung einzeln formatieren; was dazwischen steht (Trennzeichen, GO, DELIMITER, Leerzeilen) bleibt.
 * Was der Formatierer nicht versteht, bleibt unverändert, statt kaputtzugehen.
 * Elasticsearch: Konsolen-Anfragen bekommen einen eingerückten JSON-Body, SQL wie gewohnt.
 */
export function formatSql(text: string, dialect: Dialect): FormatResult {
  const es = dialect === 'elasticsearch';
  const statements = es ? splitEs(text) : splitSql(text, dialect);
  let out = '';
  let pos = 0;
  let skipped = 0;
  for (const st of statements) {
    // zwischen zwei Anweisungen mindestens ein Zeilenumbruch ("…; SELECT" → neue Zeile)
    const between = text.slice(pos, st.start);
    out += pos > 0 && !between.includes('\n') ? between.trimEnd() + '\n' : between;
    // Prozedur-Rümpfe mit eigenem Trennzeichen (MySQL DELIMITER //) nicht anfassen
    let formatted = st.sql;
    if (es && isConsoleRequest(st.sql)) {
      try {
        formatted = formatRequest(st.sql);
      } catch {
        skipped++;
      }
    } else if (!st.delimiter || st.delimiter === ';') {
      try {
        formatted = format(st.sql, { language: LANGUAGE[dialect], keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 }).trimEnd();
      } catch {
        skipped++;
      }
    } else {
      skipped++;
    }
    out += formatted;
    pos = st.end;
  }
  out += text.slice(pos);
  return { text: out, skipped };
}
