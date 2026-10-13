import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, input, signal, untracked, viewChild } from '@angular/core';
import type { PlanNode, QueryPlan, StatementPlan } from '../../../../shared/api-types';
import { Icon } from '../ui/icon';

const intFmt = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });

/** ab diesem Anteil gilt ein Schritt als teuer (rot) bzw. auffällig (orange) */
const HOT = 0.5;
const WARM = 0.2;

interface Row {
  node: PlanNode;
  depth: number;
  /** Pfad im Baum, z. B. "0.2.1" */
  id: string;
  open: boolean;
}

/** Ausführungsplan als aufklappbarer Baum mit Anteilen; rechts die Angaben zum gewählten Schritt */
@Component({
  selector: 'app-plan-view',
  imports: [Icon],
  templateUrl: './plan-view.html',
  styleUrl: './plan-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanView {
  readonly plan = input.required<QueryPlan>();

  protected index = signal(0);
  protected showRaw = signal(false);
  protected collapsed = signal(new Set<PlanNode>());
  protected selected = signal<PlanNode | null>(null);
  protected copied = signal(false);
  private treeEl = viewChild<ElementRef<HTMLElement>>('tree');

  protected readonly stmt = computed<StatementPlan | undefined>(() => this.plan().statements[this.index()]);
  protected readonly analyzed = computed(() => this.plan().analyzed);
  protected readonly rows = computed<Row[]>(() => {
    const out: Row[] = [];
    const closed = this.collapsed();
    const walk = (n: PlanNode, depth: number, id: string) => {
      const open = !closed.has(n);
      out.push({ node: n, depth, id, open });
      if (open) n.children.forEach((c, i) => walk(c, depth + 1, `${id}.${i}`));
    };
    const root = this.stmt()?.root;
    if (root) walk(root, 0, '0');
    return out;
  });
  protected readonly allOpen = computed(() => this.collapsed().size === 0);
  /** „Zuklappen“ hat etwas zu tun: ein Schritt unterhalb der ersten Ebene mit Kindern */
  protected readonly canCollapse = computed(() => {
    const deep = (n: PlanNode, depth: number): boolean => (depth >= 1 && n.children.length > 0) || n.children.some((c) => deep(c, depth + 1));
    const root = this.stmt()?.root;
    return !!root && deep(root, 0);
  });
  protected readonly summary = computed(() => {
    const s = this.stmt();
    if (!s) return '';
    const parts: string[] = [];
    if (s.executionMs !== undefined) parts.push(`Ausführung ${this.ms(s.executionMs)} ms`);
    if (s.planningMs !== undefined) parts.push(`Planung ${this.ms(s.planningMs)} ms`);
    if (s.totalCost !== undefined) parts.push(`Kosten ${this.cost(s.totalCost)}`);
    if (s.shareBy) parts.push(`Anteil nach ${s.shareBy === 'time' ? 'Zeit' : 'geschätzten Kosten'}`);
    return parts.join(' · ');
  });

  constructor() {
    // neuer Plan: erste Anweisung mit Baum, alles aufgeklappt, teuersten Schritt wählen
    effect(() => {
      const p = this.plan();
      untracked(() => {
        const first = p.statements.findIndex((s) => s.root);
        this.pick(first < 0 ? 0 : first);
      });
    });
  }

  protected pick(i: number) {
    this.index.set(i);
    this.showRaw.set(false);
    this.collapsed.set(new Set());
    const all: PlanNode[] = [];
    const walk = (n: PlanNode) => {
      all.push(n);
      n.children.forEach(walk);
    };
    const root = this.plan().statements[i]?.root;
    if (root) walk(root);
    const hottest = all.reduce<PlanNode | null>((best, n) => ((n.share ?? -1) > (best?.share ?? -1) ? n : best), null);
    this.selected.set(hottest ?? root ?? null);
  }

  protected toggle(row: Row, ev?: Event) {
    ev?.stopPropagation();
    if (!row.node.children.length) return;
    const next = new Set(this.collapsed());
    if (next.has(row.node)) next.delete(row.node);
    else next.add(row.node);
    this.collapsed.set(next);
    this.keepSelectionVisible();
  }

  protected toggleAll() {
    if (this.allOpen()) {
      const next = new Set<PlanNode>();
      const walk = (n: PlanNode, depth: number) => {
        // Wurzel und erste Ebene offen lassen
        if (depth >= 1 && n.children.length) next.add(n);
        n.children.forEach((c) => walk(c, depth + 1));
      };
      const root = this.stmt()?.root;
      if (root) walk(root, 0);
      this.collapsed.set(next);
      this.keepSelectionVisible();
    } else this.collapsed.set(new Set());
  }

  /** gewählter Schritt in einem zugeklappten Ast: der sichtbare Vorfahr übernimmt (sonst wären Pfeiltasten tot und das
   *  Detailpanel zeigte einen unsichtbaren Schritt) */
  private keepSelectionVisible() {
    const sel = this.selected();
    const rows = this.rows();
    if (!sel || rows.some((r) => r.node === sel)) return;
    const path: PlanNode[] = [];
    const find = (n: PlanNode): boolean => {
      path.push(n);
      if (n === sel || n.children.some(find)) return true;
      path.pop();
      return false;
    };
    const root = this.stmt()?.root;
    if (root) find(root);
    const shown = new Set(rows.map((r) => r.node));
    this.selected.set([...path].reverse().find((n) => shown.has(n)) ?? rows[0]?.node ?? null);
  }

  protected select(row: Row) {
    this.selected.set(row.node);
    this.treeEl()?.nativeElement.focus();
  }

  /** Pfeiltasten im Baum: auf/ab wählen, rechts/links auf- und zuklappen */
  protected onKey(ev: KeyboardEvent) {
    const rows = this.rows();
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    // nichts (Sichtbares) gewählt: die Tasten beginnen oben
    const i = Math.max(0, rows.findIndex((r) => r.node === this.selected()));
    if (!rows.length) return;
    ev.preventDefault();
    const row = rows[i];
    let target = i;
    if (ev.key === 'ArrowDown') target = Math.min(rows.length - 1, i + 1);
    else if (ev.key === 'ArrowUp') target = Math.max(0, i - 1);
    else if (ev.key === 'Home') target = 0;
    else if (ev.key === 'End') target = rows.length - 1;
    else if (ev.key === 'ArrowRight') {
      if (row.node.children.length && !row.open) return this.toggle(row);
      if (row.open && row.node.children.length) target = i + 1;
    } else if (ev.key === 'ArrowLeft') {
      if (row.node.children.length && row.open) return this.toggle(row);
      const parentId = row.id.split('.').slice(0, -1).join('.');
      const p = rows.findIndex((r) => r.id === parentId);
      if (p >= 0) target = p;
    }
    this.selected.set(rows[target].node);
    queueMicrotask(() => this.treeEl()?.nativeElement.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' }));
  }

  protected copyRaw() {
    const raw = this.stmt()?.raw;
    if (!raw) return;
    void navigator.clipboard.writeText(raw);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  protected heat(n: PlanNode): string {
    const s = n.share ?? 0;
    return s >= HOT ? 'hot' : s >= WARM ? 'warm' : '';
  }

  /** tatsächliche Zeilen weichen stark von der Schätzung ab */
  protected misestimated(n: PlanNode): boolean {
    return n.warnings.some((w) => w.startsWith('Schätzung zu'));
  }

  /** EXPLAIN vor einer Anweisung, die keinen Plan hat (SHOW, SET, DDL …), endet als Syntaxfehler */
  protected syntaxError(error: string): boolean {
    return /syntax/i.test(error);
  }

  protected shortSql(sql: string): string {
    const one = sql.replace(/\s+/g, ' ').trim();
    return one.length > 70 ? one.slice(0, 70) + ' …' : one;
  }

  protected rowsText(n: number | undefined): string {
    if (n === undefined) return '';
    return n < 10 && !Number.isInteger(n) ? String(Math.round(n * 10) / 10) : intFmt.format(n);
  }

  protected cost(n: number | undefined): string {
    if (n === undefined) return '';
    if (n >= 1000) return intFmt.format(n);
    if (n >= 1) return String(Math.round(n * 100) / 100);
    return n === 0 ? '0' : String(Number(n.toPrecision(3)));
  }

  protected ms(n: number | undefined): string {
    if (n === undefined) return '';
    // SQL Server misst ganze Millisekunden
    if (n >= 100 || Number.isInteger(n)) return intFmt.format(n);
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(n < 1 ? 3 : 2);
  }

  protected pct(share: number | undefined): string {
    if (share === undefined) return '';
    const p = Math.round(share * 100);
    return p === 0 && share > 0 ? '< 1 %' : `${p} %`;
  }

  protected barWidth(share: number | undefined): number {
    return Math.max(0, Math.min(100, (share ?? 0) * 100));
  }
}
