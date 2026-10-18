import { ChangeDetectionStrategy, Component, computed, inject, signal, effect, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { DbObject, Dialect, RoutineInfo, RoutineKind, SavedConnection } from '../../../../shared/api-types';
import { objectName, selectTop } from '../../../../shared/sql-util';
import { api, message } from '../core/api';
import { keys, systemName } from '../core/platform';
import { AppState } from '../core/state';
import { ContextMenuService, MenuItem } from '../ui/context-menu';
import { Theme } from '../ui/theme';
import { DumpService } from '../dump-dialog/dump-dialog';
import { ObjectSearchService } from '../object-search/object-search';
import { SettingsService } from '../settings-dialog/settings-dialog';
import { Icon } from '../ui/icon';
import { KeysPipe } from '../ui/keys.pipe';

type Kind = 'connection' | 'database' | 'schema' | 'object' | 'folder' | 'routine';

const FOLDER_LABEL: Record<RoutineKind, string> = { procedure: 'Prozeduren', function: 'Funktionen', trigger: 'Trigger' };

class Node {
  readonly expanded = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly children = signal<Node[] | null>(null);

  constructor(
    readonly kind: Kind,
    readonly label: string,
    readonly connectionId: string,
    readonly database = '',
    readonly schema = '',
    readonly object?: DbObject,
    readonly system = false,
    readonly routine?: RoutineInfo,
    /** Ordner: Routinen dieser Art (schon geladen) */
    readonly items?: Node[],
  ) {}

  get key(): string {
    const r = this.routine;
    const extra = r ? `${r.kind}\u0000${r.table ?? ''}\u0000${r.args ?? ''}` : '';
    return [this.kind, this.connectionId, this.database, this.schema, this.object?.name ?? this.label, extra].join('\u0000');
  }
}

const SYSTEM_DBS: Record<Dialect, Set<string>> = {
  mysql: new Set(['information_schema', 'performance_schema', 'mysql', 'sys']),
  mssql: new Set(['master', 'model', 'msdb', 'tempdb']),
  postgres: new Set(),
  elasticsearch: new Set(),
};

/** Elasticsearch: Suche über die Konsole als Vorlage für einen neuen Abfrage-Tab */
function esSearchTemplate(index: string): string {
  // Name kodiert wie im Treiber: ein % im Namen (erlaubt) gälte im Pfad sonst als Escape
  return `GET ${encodeURIComponent(index)}/_search\n{\n  "query": { "match_all": {} },\n  "size": 100\n}\n`;
}

@Component({
  selector: 'app-tree',
  imports: [Icon, NgTemplateOutlet, KeysPipe],
  templateUrl: './tree.html',
  styleUrl: './tree.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Tree {
  protected state = inject(AppState);
  private menu = inject(ContextMenuService);
  private dumps = inject(DumpService);
  private search = inject(ObjectSearchService);
  protected settings = inject(SettingsService);
  private theme = inject(Theme);
  protected filter = signal('');
  protected selectedKey = signal<string | null>(null);

  /** Wurzelknoten je Verbindung; bleiben erhalten, solange die Verbindung existiert */
  private roots = new Map<string, Node>();
  protected readonly rootNodes = computed(() => {
    const conns = this.state.connections();
    const next = new Map<string, Node>();
    for (const c of conns) next.set(c.id, this.roots.get(c.id) ?? new Node('connection', c.name, c.id));
    this.roots = next;
    return conns.map((c) => next.get(c.id)!);
  });

  constructor() {
    // geänderte Zugangsdaten: Baum der Verbindung neu laden lassen
    effect(() => {
      const st = this.state.status();
      untracked(() => {
        for (const [id, n] of this.roots) {
          // auch nach einem Fehler (Passwort korrigiert): die alte Meldung gehört nicht mehr zur Verbindung
          if ((st[id]?.state ?? 'idle') === 'idle' && (n.children() || n.error())) {
            n.children.set(null);
            n.expanded.set(false);
            n.error.set(null);
          }
        }
      });
    });
    // nach dem Einspielen: Datenbanken der Verbindung neu laden (neue Datenbank, neue Tabellen)
    effect(() => {
      const done = this.dumps.imported();
      if (!done) return;
      untracked(() => {
        const root = this.roots.get(done.connectionId);
        if (root?.children()) void this.refresh(root);
      });
    });
  }

  /** Menü am Kopf des Baums: Einstellungen als Datei */
  protected settingsMenu(ev: MouseEvent) {
    this.menu.openBelow(ev.currentTarget as Element, [
      {
        label: 'Einstellungen exportieren …',
        icon: 'download',
        disabled: !this.state.connections().length,
        action: () => this.settings.open('export'),
      },
      { label: 'Einstellungen importieren …', icon: 'upload', action: () => this.settings.open('import') },
      { separator: true },
      // Darstellung: Haken an der gewählten
      ...([
        ['system', `Darstellung wie ${systemName}`],
        ['light', 'Darstellung hell'],
        ['dark', 'Darstellung dunkel'],
      ] as const).map(([mode, label]) => ({ label, icon: this.theme.mode() === mode ? 'check' : undefined, action: () => this.theme.setMode(mode) })),
    ]);
  }

  protected conn(id: string): SavedConnection | undefined {
    return this.state.connection(id);
  }

  protected visibleChildren(n: Node): Node[] {
    const list = n.children() ?? [];
    const f = this.filter().trim().toLowerCase();
    if (!f) return list;
    // Ordner bleiben stehen (ihr Inhalt wird gefiltert), Tabellen/Views/Routinen nach Namen
    return list.filter((c) => (c.kind !== 'object' && c.kind !== 'routine') || c.label.toLowerCase().includes(f));
  }

  protected rows(n: DbObject): string {
    if (n.rows == null) return '';
    const r = n.rows;
    if (r < 1000) return String(r);
    if (r < 1_000_000) return (r / 1000).toFixed(r < 10_000 ? 1 : 0) + 'k';
    return (r / 1_000_000).toFixed(1) + 'M';
  }

  protected async toggle(n: Node, ev?: Event) {
    ev?.stopPropagation();
    if (n.kind === 'object' || n.kind === 'routine') return;
    // aufgeklappt, aber ohne Kinder (Verbinden oder Laden fehlgeschlagen): erneut versuchen statt nur zuzuklappen
    if (n.expanded() && (n.children() || n.loading())) {
      // die Auswahl lag darunter: sie geht auf den zugeklappten Knoten (sonst wäre kein Knoten per Tab erreichbar)
      const sel = this.selectedKey();
      if (sel && sel !== n.key && this.contains(n, sel)) this.select(n);
      n.expanded.set(false);
      return;
    }
    n.expanded.set(true);
    if (!n.children()) await this.load(n);
  }

  protected async load(n: Node) {
    n.loading.set(true);
    n.error.set(null);
    try {
      n.children.set(await this.fetchChildren(n));
    } catch (e) {
      n.error.set(message(e));
      n.children.set(null);
      this.state.noteError(n.connectionId, e);
    } finally {
      n.loading.set(false);
    }
  }

  private async fetchChildren(n: Node): Promise<Node[]> {
    const id = n.connectionId;
    const dialect = this.state.dialect(id);
    switch (n.kind) {
      case 'connection': {
        await this.state.ensureConnected(id);
        const dbs = await api.listDatabases(id);
        const sys = SYSTEM_DBS[dialect];
        const nodes = dbs.map((d) => new Node('database', d, id, d, '', undefined, sys.has(d)));
        // Systemdatenbanken nach hinten
        nodes.sort((a, b) => Number(a.system) - Number(b.system));
        const def = this.conn(id)?.database;
        const target = nodes.find((x) => x.database === def) ?? (nodes.filter((x) => !x.system).length === 1 ? nodes.find((x) => !x.system) : undefined);
        if (target) void this.toggle(target);
        return nodes;
      }
      case 'database': {
        // MySQL: Datenbank = Schema; Elasticsearch: der Cluster, darunter direkt Indizes und Aliase
        if (dialect === 'mysql' || dialect === 'elasticsearch') return this.objectNodes(n, '');
        const schemas = await api.listSchemas(id, n.database);
        // nur ein Schema: Ebene überspringen
        if (schemas.length === 1) return this.objectNodes(n, schemas[0]);
        const nodes = schemas.map((s) => new Node('schema', s, id, n.database, s));
        const main = nodes.find((x) => x.schema === (dialect === 'mssql' ? 'dbo' : 'public'));
        if (main) void this.toggle(main);
        return nodes;
      }
      case 'schema':
        return this.objectNodes(n, n.schema);
      case 'folder':
        return n.items ?? [];
      default:
        return [];
    }
  }

  private async objectNodes(parent: Node, schema: string): Promise<Node[]> {
    const [objs, routines] = await Promise.all([
      api.listObjects(parent.connectionId, parent.database, schema),
      // Routinen sind Beiwerk: fehlen Rechte, bleibt der Rest sichtbar
      api.listRoutines(parent.connectionId, parent.database, schema).catch(() => [] as RoutineInfo[]),
    ]);
    // Tabellen vor Views
    objs.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'table' ? -1 : 1));
    const nodes = objs.map((o) => new Node('object', o.name, parent.connectionId, parent.database, schema, o));
    for (const kind of ['procedure', 'function', 'trigger'] as const) {
      const list = routines.filter((r) => r.kind === kind);
      if (!list.length) continue;
      // überladene Funktionen (PostgreSQL): mit Argumenten unterscheiden
      const twice = new Set(list.filter((r, i) => list.findIndex((x) => x.name === r.name) !== i).map((r) => r.name));
      const label = (r: RoutineInfo) => (twice.has(r.name) ? `${r.name}(${r.args ?? ''})` : r.name);
      const items = list.map((r) => new Node('routine', label(r), parent.connectionId, parent.database, schema, undefined, false, r));
      nodes.push(new Node('folder', `${FOLDER_LABEL[kind]} (${list.length})`, parent.connectionId, parent.database, schema, undefined, false, undefined, items));
    }
    return nodes;
  }

  /** Text der Prozedur/Funktion/des Triggers in einem Abfrage-Tab öffnen (zum Ansehen oder Ändern) */
  private async openRoutine(n: Node) {
    // Doppelklick: nicht zweimal laden und zwei gleiche Tabs samt Sitzung öffnen
    if (n.loading()) return;
    const r = n.routine!;
    n.loading.set(true);
    n.error.set(null);
    try {
      const script = await api.getRoutineDdl({ connectionId: n.connectionId, database: n.database, schema: n.schema, ...r });
      this.state.openQuery(n.connectionId, n.database, script);
    } catch (e) {
      n.error.set(message(e));
    } finally {
      n.loading.set(false);
    }
  }

  /** Vorlage für den Aufruf einer Prozedur */
  private callTemplate(dialect: Dialect, n: Node): string {
    const name = dialect === 'mysql' ? objectName(dialect, { schema: '', name: n.routine!.name }) : objectName(dialect, { schema: n.schema, name: n.routine!.name });
    if (dialect === 'mssql') return `EXEC ${name};`;
    // Argumentnamen sind frei wählbar: ein „*/“ darin beendete den Kommentar, der Rest würde ausführbares SQL
    return `CALL ${name}(${n.routine?.args ? '/* ' + n.routine.args.replace(/\*\//g, '* /') + ' */' : ''});`;
  }

  /** Knoten wählen: Markierung im Baum, und „Neue Abfrage“ nimmt seine Verbindung und Datenbank */
  protected select(n: Node) {
    this.selectedKey.set(n.key);
    this.state.pickInTree(n.connectionId, n.database);
  }

  protected click(n: Node) {
    this.select(n);
    if (n.kind === 'object') this.openData(n);
    else if (n.kind === 'routine') void this.openRoutine(n);
    else void this.toggle(n);
  }

  private openData(n: Node) {
    this.state.openTable({ connectionId: n.connectionId, database: n.database, schema: n.schema, name: n.object!.name, kind: n.object!.kind });
  }

  /**
   * Schema für Aktionen auf der Datenbank: das einzige (Ebene übersprungen bzw. laut Server), sonst das Hauptschema, wenn es
   * es gibt, sonst das erste – nie ein festes public/dbo, das in dieser Datenbank fehlt (auch bei zugeklappter Datenbank)
   */
  private async mainSchema(n: Node): Promise<string> {
    const dialect = this.state.dialect(n.connectionId);
    if (dialect === 'mysql' || dialect === 'elasticsearch') return '';
    const kids = n.children();
    const only = kids?.find((c) => c.kind === 'object' || c.kind === 'folder');
    if (only) return only.schema;
    let schemas = kids?.filter((c) => c.kind === 'schema').map((c) => c.schema) ?? [];
    if (!schemas.length) {
      await this.state.ensureConnected(n.connectionId);
      schemas = await api.listSchemas(n.connectionId, n.database);
    }
    const main = dialect === 'mssql' ? 'dbo' : 'public';
    return schemas.length === 1 || !schemas.includes(main) ? (schemas[0] ?? main) : main;
  }

  /** Aktion mit dem Schema der Datenbank; scheitert die Schemaliste, steht der Fehler am Knoten */
  private withMainSchema(n: Node, run: (schema: string) => void) {
    n.error.set(null);
    this.mainSchema(n).then(run, (e) => n.error.set(message(e)));
  }

  private copy(text: string) {
    void navigator.clipboard.writeText(text);
  }

  protected contextMenu(ev: MouseEvent, n: Node) {
    this.select(n);
    const id = n.connectionId;
    const dialect = this.state.dialect(id);
    // Elasticsearch: nur lesen – kein Dump, Vergleich, ER-Diagramm, keine Sitzungsliste
    const es = dialect === 'elasticsearch';
    const connected = this.state.status()[id]?.state === 'connected';
    let items: MenuItem[];
    switch (n.kind) {
      case 'connection':
        items = [
          { label: 'Neue Abfrage', icon: 'query', action: () => this.state.openQuery(id, this.conn(id)?.database) },
          { label: 'Objekte suchen …', icon: 'search', hint: keys('Strg+Umschalt+F'), action: () => this.search.open(id) },
          ...(es ? [] : [{ label: 'Sitzungen und laufende Abfragen', icon: 'activity', action: () => this.state.openSessions(id) }]),
          { separator: true },
          ...(connected
            ? [
                // Server neu gestartet, Netz weg gewesen: neuer Treiber, die Tabs bleiben offen
                { label: 'Neu verbinden', icon: 'refresh', action: () => void this.reconnect(n) },
                { label: 'Trennen', icon: 'unplug', action: () => void this.disconnect(n) },
              ]
            : // nach einem Fehler war der Knoten noch aufgeklappt – toggle() klappte dann nur zu
              [{ label: 'Verbinden', icon: 'link', action: () => void this.refresh(n) }]),
          { label: 'Aktualisieren', icon: 'refresh', action: () => void this.refresh(n) },
          { label: 'Bearbeiten …', icon: 'edit', action: () => this.state.editing.set(id) },
          // alle Einstellungen samt Passwort übernommen, z. B. für „prod-lesend“ oder eine zweite Datenbank auf demselben Server
          { label: 'Duplizieren', icon: 'copy', action: () => void this.duplicate(n) },
          { separator: true },
          { label: 'Löschen …', icon: 'trash', action: () => void this.remove(n) },
        ];
        break;
      case 'database':
        if (es) {
          items = [
            { label: 'Neue Abfrage', icon: 'query', action: () => this.state.openQuery(id, n.database) },
            { label: 'Aktualisieren', icon: 'refresh', action: () => void this.refresh(n) },
            { label: 'Objekte suchen …', icon: 'search', hint: keys('Strg+Umschalt+F'), action: () => this.search.open(id) },
            { separator: true },
            { label: 'Namen kopieren', icon: 'copy', action: () => this.copy(n.database) },
          ];
          break;
        }
        items = [
          { label: 'Neue Abfrage hier', icon: 'query', action: () => this.state.openQuery(id, n.database) },
          { label: 'Aktualisieren', icon: 'refresh', action: () => void this.refresh(n) },
          { label: 'Objekte suchen …', icon: 'search', hint: keys('Strg+Umschalt+F'), action: () => this.search.open(id) },
          {
            label: 'Schema vergleichen …',
            icon: 'compare',
            // PostgreSQL/SQL Server: das Hauptschema der Datenbank
            action: () => this.withMainSchema(n, (schema) => this.state.openCompare({ connectionId: id, database: n.database, schema })),
          },
          {
            label: 'Daten vergleichen …',
            icon: 'datacompare',
            action: () => this.withMainSchema(n, (schema) => this.state.openDataCompare({ connectionId: id, database: n.database, schema, table: '' }, { all: true })),
          },
          { label: 'ER-Diagramm', icon: 'diagram', action: () => this.withMainSchema(n, (schema) => this.state.openEr(id, n.database, schema)) },
          { separator: true },
          { label: 'Dump erstellen …', icon: 'download', action: () => this.dumps.open({ mode: 'dump', connectionId: id, database: n.database }) },
          { label: 'SQL-Datei einspielen …', icon: 'upload', action: () => this.dumps.open({ mode: 'import', connectionId: id, database: n.database }) },
          { label: 'Kopieren nach …', icon: 'clone', action: () => this.dumps.open({ mode: 'copy', connectionId: id, database: n.database }) },
          { separator: true },
          { label: 'Namen kopieren', icon: 'copy', action: () => this.copy(n.database) },
        ];
        break;
      case 'schema':
        items = [
          { label: 'Neue Abfrage hier', icon: 'query', action: () => this.state.openQuery(id, n.database) },
          { label: 'Aktualisieren', icon: 'refresh', action: () => void this.refresh(n) },
          { label: 'Dump erstellen …', icon: 'download', action: () => this.dumps.open({ mode: 'dump', connectionId: id, database: n.database, schema: n.schema }) },
          { label: 'Kopieren nach …', icon: 'clone', action: () => this.dumps.open({ mode: 'copy', connectionId: id, database: n.database, schema: n.schema }) },
          { label: 'Schema vergleichen …', icon: 'compare', action: () => this.state.openCompare({ connectionId: id, database: n.database, schema: n.schema }) },
          {
            label: 'Daten vergleichen …',
            icon: 'datacompare',
            action: () => this.state.openDataCompare({ connectionId: id, database: n.database, schema: n.schema, table: '' }, { all: true }),
          },
          { label: 'ER-Diagramm', icon: 'diagram', action: () => this.state.openEr(id, n.database, n.schema) },
          { label: 'Namen kopieren', icon: 'copy', action: () => this.copy(n.schema) },
        ];
        break;
      case 'folder':
        items = [{ label: 'Aktualisieren', icon: 'refresh', action: () => this.refreshParentOf(n) }];
        break;
      case 'routine': {
        const r = n.routine!;
        items = [
          { label: 'Im Editor öffnen', icon: 'query', action: () => void this.openRoutine(n) },
          ...(r.kind === 'procedure' ? [{ label: 'Aufruf in neuer Abfrage', icon: 'play', action: () => this.state.openQuery(id, n.database, this.callTemplate(dialect, n)) }] : []),
          { separator: true },
          { label: 'Namen kopieren', icon: 'copy', action: () => this.copy(objectName(dialect, { schema: dialect === 'mysql' ? '' : n.schema, name: n.routine!.name })) },
        ];
        break;
      }
      case 'object': {
        const ref = { schema: n.schema, name: n.object!.name };
        if (es) {
          items = [
            { label: 'Daten anzeigen', icon: 'table', action: () => this.openData(n) },
            { label: 'Suche in neuer Abfrage', icon: 'query', action: () => this.state.openQuery(id, n.database, esSearchTemplate(ref.name)) },
            { label: 'SQL in neuer Abfrage', icon: 'query', action: () => this.state.openQuery(id, n.database, selectTop(dialect, ref, 100)) },
            { separator: true },
            { label: 'Namen kopieren', icon: 'copy', action: () => this.copy(ref.name) },
          ];
          break;
        }
        items = [
          { label: 'Daten anzeigen', icon: 'table', action: () => this.openData(n) },
          { label: 'SELECT in neuer Abfrage', icon: 'query', action: () => this.state.openQuery(id, n.database, selectTop(dialect, ref, 100)) },
          ...(n.object!.kind === 'table'
            ? [
                { label: 'ER-Diagramm ab hier', icon: 'diagram', action: () => this.state.openEr(id, n.database, n.schema, n.object!.name) },
                {
                  label: 'Daten vergleichen …',
                  icon: 'datacompare',
                  action: () => this.state.openDataCompare({ connectionId: id, database: n.database, schema: n.schema, table: n.object!.name }),
                },
              ]
            : []),
          {
            label: 'Dump erstellen …',
            icon: 'download',
            action: () => this.dumps.open({ mode: 'dump', connectionId: id, database: n.database, schema: n.schema, table: n.object!.name }),
          },
          {
            label: 'Kopieren nach …',
            icon: 'clone',
            action: () => this.dumps.open({ mode: 'copy', connectionId: id, database: n.database, schema: n.schema, table: n.object!.name }),
          },
          { separator: true },
          { label: 'Namen kopieren', icon: 'copy', action: () => this.copy(objectName(dialect, ref)) },
        ];
        break;
      }
    }
    this.menu.open(ev, items);
  }

  protected async refresh(n: Node) {
    n.expanded.set(true);
    await this.load(n);
  }

  /** Ordner haben vorgeladene Kinder: das Schema bzw. die Datenbank darüber neu laden */
  private refreshParentOf(folder: Node) {
    const find = (list: Node[] | null): Node | undefined => {
      for (const c of list ?? []) {
        if (c.children()?.includes(folder)) return c;
        const hit = find(c.children());
        if (hit) return hit;
      }
      return undefined;
    };
    const parent = find([...this.roots.values()]);
    if (parent) void this.refresh(parent);
  }

  private async reconnect(n: Node) {
    n.error.set(null);
    try {
      await this.state.reconnect(n.connectionId);
      if (n.children()) await this.refresh(n);
    } catch (e) {
      n.error.set(message(e));
    }
  }

  private async disconnect(n: Node) {
    try {
      if (!(await this.state.closeTabsOf(n.connectionId))) return;
      await this.state.disconnect(n.connectionId);
      n.expanded.set(false);
      n.children.set(null);
    } catch (e) {
      n.error.set(message(e));
    }
  }

  /** Kopie samt Einstellungen und Passwort anlegen, im Baum wählen und gleich zum Anpassen (Name, Datenbank) öffnen */
  private async duplicate(n: Node) {
    n.error.set(null);
    try {
      const copy = await api.duplicateConnection(n.connectionId);
      this.state.connections.set(await api.listConnections());
      const root = this.rootNodes().find((r) => r.connectionId === copy.id);
      if (root) this.select(root);
      else this.state.pickInTree(copy.id, '');
      this.state.editing.set(copy.id);
    } catch (e) {
      n.error.set(message(e));
    }
  }

  private async remove(n: Node) {
    const c = this.conn(n.connectionId);
    if (!c || !confirm(`Verbindung „${c.name}" löschen?`)) return;
    // Fehler (z. B. connections.json gesperrt) am Knoten zeigen – die Tabs sind dann schon zu, die Verbindung bleibt
    try {
      if (!(await this.state.closeTabsOf(c.id))) return;
      await api.deleteConnection(c.id);
      this.state.connections.set(await api.listConnections());
    } catch (e) {
      n.error.set(message(e));
    }
  }

  protected nodeIcon(n: Node): string {
    switch (n.kind) {
      case 'connection':
        return 'server';
      case 'database':
        return 'database';
      case 'schema':
        return 'schema';
      case 'folder':
        return 'schema';
      case 'routine':
        return n.routine!.kind === 'procedure' ? 'proc' : n.routine!.kind === 'function' ? 'func' : 'trigger';
      default:
        return n.object!.kind === 'view' ? 'view' : 'table';
    }
  }

  /** Suche in der zuletzt gewählten Verbindung (sonst der ersten) */
  protected openSearch() {
    const id = this.state.currentConnection() ?? this.state.connections()[0]?.id;
    if (id) this.search.open(id);
  }

  protected routineTitle(n: Node): string {
    const r = n.routine!;
    if (r.kind === 'trigger') return `${r.name} (auf ${r.table}) – Klick öffnet den Text`;
    return `${r.name}${r.args !== undefined ? '(' + r.args + ')' : ''} – Klick öffnet den Text`;
  }

  /** per Tab erreichbar: der gewählte Knoten, ohne Auswahl der erste */
  protected tabStop(n: Node): boolean {
    const sel = this.selectedKey();
    return sel ? sel === n.key : this.rootNodes()[0] === n;
  }

  private contains(n: Node, key: string): boolean {
    return (n.children() ?? []).some((c) => c.key === key || this.contains(c, key));
  }

  /**
   * Baum mit der Tastatur: Pfeil auf/ab zur nächsten Zeile, rechts aufklappen bzw. zum ersten Kind, links zuklappen bzw.
   * zum Elternknoten, Pos1/Ende, Enter wie Klick (Tabelle öffnen, Routine öffnen, auf- und zuklappen). Kontextmenü über
   * die Menütaste bzw. Umschalt+F10 (contextmenu-Ereignis der Zeile).
   */
  protected onKey(ev: KeyboardEvent, n: Node) {
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const row = ev.currentTarget as HTMLElement;
    const rows = [...(row.closest('.tree')?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? [])];
    const i = rows.indexOf(row);
    const level = (el?: HTMLElement) => Number(el?.getAttribute('aria-level') ?? 0);
    const go = (el?: HTMLElement) => {
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    };
    const branch = n.kind !== 'object' && n.kind !== 'routine';
    switch (ev.key) {
      case 'ArrowDown':
        go(rows[i + 1]);
        break;
      case 'ArrowUp':
        go(rows[i - 1]);
        break;
      case 'Home':
        go(rows[0]);
        break;
      case 'End':
        go(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (branch && !n.expanded()) void this.toggle(n);
        else if (branch && level(rows[i + 1]) === level(row) + 1) go(rows[i + 1]);
        break;
      case 'ArrowLeft':
        if (branch && n.expanded()) void this.toggle(n);
        else go(rows.slice(0, i).reverse().find((r) => level(r) === level(row) - 1));
        break;
      case 'Enter':
        this.click(n);
        break;
      default:
        return;
    }
    ev.preventDefault();
  }

  protected statusOf(n: Node) {
    return this.state.status()[n.connectionId]?.state ?? 'idle';
  }

  /** Verbindung bestand und ist unterbrochen */
  protected lostOf(n: Node): boolean {
    const s = this.state.status()[n.connectionId];
    return s?.state === 'error' && !!s.lost;
  }
}
