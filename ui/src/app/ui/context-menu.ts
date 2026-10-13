import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, Injectable, signal, viewChild, effect } from '@angular/core';
import { Icon } from './icon';

export interface MenuItem {
  label?: string;
  icon?: string;
  hint?: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ContextMenuService {
  readonly menu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** vor dem Öffnen fokussiert: bekommt den Fokus beim Schließen zurück */
  private before: HTMLElement | null = null;

  open(ev: MouseEvent, items: MenuItem[]): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.remember();
    // per Menütaste bzw. Umschalt+F10 geöffnet: kein Mauspunkt – unter dem Element, das das Ereignis bekam
    const el = ev.currentTarget instanceof Element ? ev.currentTarget : ev.target instanceof Element ? ev.target : null;
    if (ev.button === 0 && ev.clientX === 0 && ev.clientY === 0 && el) {
      const r = el.getBoundingClientRect();
      this.menu.set({ x: r.left + 24, y: r.bottom, items });
      return;
    }
    this.menu.set({ x: ev.clientX, y: ev.clientY, items });
  }

  /** als Menü eines Knopfs: unter dem Element */
  openBelow(el: Element, items: MenuItem[]): void {
    this.remember();
    const r = el.getBoundingClientRect();
    this.menu.set({ x: r.left, y: r.bottom + 2, items });
  }

  private remember(): void {
    const a = document.activeElement;
    this.before = a instanceof HTMLElement && a !== document.body ? a : null;
  }

  close(): void {
    if (!this.menu()) return;
    this.menu.set(null);
    // Fokus zurück (Tastatur ging sonst ins Leere), sofern ihn nicht inzwischen etwas anderes hat (z. B. ein Dialog)
    const b = this.before;
    this.before = null;
    if (b)
      setTimeout(() => {
        const a = document.activeElement;
        if (b.isConnected && (!a || a === document.body)) b.focus();
      }, 0);
  }
}

@Component({
  selector: 'app-context-menu',
  imports: [Icon],
  template: `
    @if (svc.menu(); as m) {
      <div class="backdrop" (mousedown)="svc.close()" (contextmenu)="$event.preventDefault(); svc.close()"></div>
      <div #box class="menu" [style.left.px]="m.x" [style.top.px]="m.y" role="menu" (keydown)="onMenuKey($event)">
        @for (it of m.items; track $index) {
          @if (it.separator) {
            <div class="sep"></div>
          } @else {
            <button type="button" role="menuitem" tabindex="-1" [disabled]="it.disabled" (click)="run(it)">
              <span class="ic">@if (it.icon) {<app-icon [name]="it.icon" />}</span>
              <span class="label">{{ it.label }}</span>
              @if (it.hint) {<span class="hint">{{ it.hint }}</span>}
            </button>
          }
        }
      </div>
    }
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 900;
    }
    .menu {
      position: fixed;
      z-index: 901;
      min-width: 200px;
      max-width: 420px;
      /* lange Menüs (Grid mit vielen Verweisen) scrollen, statt über den Fensterrand zu ragen */
      max-height: calc(100vh - 8px);
      overflow-y: auto;
      padding: 4px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: var(--shadow);
    }
    button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 5px 10px 5px 6px;
      border: 0;
      border-radius: 4px;
      background: none;
      text-align: left;
      cursor: pointer;
      &:hover:not(:disabled),
      &:focus-visible {
        background: var(--sel);
        outline: none;
      }
      &:disabled {
        opacity: 0.45;
        cursor: default;
      }
    }
    .ic {
      width: 16px;
      display: inline-flex;
      color: var(--fg-dim);
    }
    .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hint {
      color: var(--fg-faint);
      font-size: 11px;
    }
    .sep {
      height: 1px;
      margin: 4px 2px;
      background: var(--border);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextMenu {
  protected svc = inject(ContextMenuService);
  private box = viewChild<ElementRef<HTMLElement>>('box');

  constructor() {
    // im Fenster halten
    effect(() => {
      const el = this.box()?.nativeElement;
      const m = this.svc.menu();
      if (!el || !m) return;
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth) el.style.left = Math.max(0, window.innerWidth - r.width - 4) + 'px';
      if (r.bottom > window.innerHeight) el.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
      // Tastatur: der erste Eintrag hat den Fokus
      el.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    });
  }

  /** Pfeile auf/ab bzw. Pos1/Ende wandern über die Einträge (rundum), Tab schließt; Enter/Leertaste lösen den Knopf aus */
  protected onMenuKey(ev: KeyboardEvent) {
    const items = [...(this.box()?.nativeElement.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (ev.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (ev.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
    else if (ev.key === 'Home') next = items[0];
    else if (ev.key === 'End') next = items[items.length - 1];
    else if (ev.key === 'Tab') {
      ev.preventDefault();
      this.svc.close();
      return;
    } else return;
    ev.preventDefault();
    next?.focus();
  }

  protected run(it: MenuItem) {
    this.svc.close();
    it.action?.();
  }

  @HostListener('document:keydown.escape')
  onEsc() {
    this.svc.close();
  }
}
