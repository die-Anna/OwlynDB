import type { Dialect, RoutineInfo } from '../shared/api-types';
import { commentText, quoteIdent } from '../shared/sql-util';

const KEYWORD: Record<RoutineInfo['kind'], string> = { procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER' };

/**
 * SQL Server speichert den Text der letzten Anweisung – auch „ALTER PROCEDURE …“, mit Kommentaren davor. Der Kopf
 * hinter den Kommentaren wird zu CREATE OR ALTER (ab 2016 SP1): legt an, was fehlt, und ändert, was da ist.
 */
export function createOrAlter(ddl: string): string {
  const m = /^((?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*\s*)(CREATE\s+OR\s+ALTER|CREATE|ALTER)(\s+)(PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)\b/i.exec(ddl);
  if (!m) return ddl;
  return `${m[1]}CREATE OR ALTER${m[3]}${m[4]}${ddl.slice(m[0].length)}`;
}

/**
 * Text einer Routine zum Ansehen und Ändern im Abfrage-Tab. Ausgeführt wird nichts von selbst; das Skript ist so
 * vorbereitet, dass F5 die Routine ändert (SQL Server CREATE OR ALTER, PostgreSQL CREATE OR REPLACE bei Funktionen,
 * MySQL mit DELIMITER – dort muss die alte Fassung vorher gelöscht werden, die Zeile dafür steht auskommentiert da).
 */
export function editorScript(dialect: Dialect, schema: string, r: RoutineInfo, ddl: string): string {
  const q = (s: string) => quoteIdent(dialect, s);
  const kw = KEYWORD[r.kind];
  if (dialect === 'mysql') {
    return (
      `-- MySQL kennt kein CREATE OR REPLACE für ${r.kind === 'trigger' ? 'Trigger' : 'Routinen'}: zum Ändern erst löschen, dann neu anlegen.\n` +
      // Namen mit Zeilenumbruch: hinter dem Umbruch wäre die auskommentierte Zeile wieder lebendiges SQL
      `-- ${commentText(`DROP ${kw} IF EXISTS ${q(r.name)};`)}\n` +
      `DELIMITER ;;\n${ddl.trim()} ;;\nDELIMITER ;\n`
    );
  }
  if (dialect === 'postgres') {
    if (r.kind === 'trigger') {
      return `-- zum Ändern erst löschen, dann neu anlegen:\n-- ${commentText(`DROP TRIGGER IF EXISTS ${q(r.name)} ON ${q(schema)}.${q(r.table ?? '')};`)}\n${ddl.trim()};\n`;
    }
    // pg_get_functiondef liefert schon CREATE OR REPLACE
    return `${ddl.trim()};\n`;
  }
  // SQL Server (ab 2016 SP1): CREATE OR ALTER ändert die bestehende Routine
  return `${createOrAlter(ddl.trim())}\nGO\n`;
}

/**
 * Text für den Dump: optional vorher löschen, dann anlegen. MySQL ohne DEFINER (anderer Server, andere Benutzer)
 * und mit eigenem Trennzeichen, SQL Server je Routine ein eigener Batch.
 */
export function dumpScript(dialect: Dialect, schema: string, r: RoutineInfo, ddl: string, drop: boolean): string {
  const q = (s: string) => quoteIdent(dialect, s);
  const kw = KEYWORD[r.kind];
  if (dialect === 'mysql') {
    const body = ddl.trim().replace(/\s+DEFINER\s*=\s*\S+@\S+/i, '');
    return (drop ? `DROP ${kw} IF EXISTS ${q(r.name)};\n` : '') + `DELIMITER ;;\n${body} ;;\nDELIMITER ;\n`;
  }
  if (dialect === 'postgres') {
    if (r.kind === 'trigger') {
      return (drop ? `DROP TRIGGER IF EXISTS ${q(r.name)} ON ${q(schema)}.${q(r.table ?? '')};\n` : '') + `${ddl.trim()};\n`;
    }
    const args = r.args ?? '';
    return (drop ? `DROP ${kw} IF EXISTS ${q(schema)}.${q(r.name)}(${args});\n` : '') + `${ddl.trim()};\n`;
  }
  // gespeichert ist der Text der letzten Anweisung, womöglich ein ALTER – das scheiterte, wo die Routine fehlt
  return (drop ? `DROP ${kw} IF EXISTS ${q(schema)}.${q(r.name)};\nGO\n` : '') + `${createOrAlter(ddl.trim())}\nGO\n`;
}
