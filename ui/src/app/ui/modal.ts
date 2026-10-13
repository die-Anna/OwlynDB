import { afterNextRender, Directive, ElementRef, inject, OnDestroy, output } from '@angular/core';

/** sichtbarer Dialog, Wertbetrachter, Kontextmenü oder aufgeklapptes Panel (Tabs im Hintergrund zählen nicht) */
export function overlayOpen(): boolean {
  return [...document.querySelectorAll('.backdrop, .viewer-backdrop')].some((el) => el.getClientRects().length > 0);
}

/** offene Dialoge in der Reihenfolge des Öffnens */
const stack: Modal[] = [];
let titles = 0;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable="true"]';

/**
 * Modaler Dialog: als Dialog mit Titel angekündigt. Beim Öffnen bekommt das Feld mit autofocus den Fokus (das
 * HTML-Attribut allein wirkt bei nachträglich eingefügten Elementen nicht), sonst der Dialog selbst. Tab läuft am Rand
 * um, statt in Baum und Tabs dahinter zu wandern. Esc schließt auch, wenn der Fokus nicht im Dialog liegt (nach einem
 * Knopf, der sich beim Klick sperrt). Beim Schließen bekommt das vorher fokussierte Element den Fokus zurück.
 */
@Directive({
  selector: '[appModal]',
  host: {
    role: 'dialog',
    'aria-modal': 'true',
    tabindex: '-1',
    '(document:keydown)': 'onKey($event)',
    '(document:focusin)': 'onFocusIn($event)',
  },
})
export class Modal implements OnDestroy {
  /** Esc: der Dialog soll schließen (ob er es tut, entscheidet er selbst, z. B. nicht während er speichert) */
  readonly dismiss = output<void>();
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;

  constructor() {
    stack.push(this);
    afterNextRender(() => {
      const host = this.el.nativeElement;
      const title = host.querySelector('h2');
      if (title && !host.hasAttribute('aria-label')) {
        title.id ||= `modal-title-${++titles}`;
        host.setAttribute('aria-labelledby', title.id);
      }
      if (!host.contains(document.activeElement)) (host.querySelector<HTMLElement>('[autofocus]') ?? host).focus();
    });
  }

  ngOnDestroy(): void {
    stack.splice(stack.indexOf(this), 1);
    const b = this.before;
    // nur, wenn den Fokus nicht schon etwas anderes hat (z. B. ein gleich danach geöffneter Dialog)
    if (b)
      setTimeout(() => {
        const a = document.activeElement;
        if (b.isConnected && (!a || a === document.body)) b.focus();
      }, 0);
  }

  /** der oberste sichtbare Dialog: nur er nimmt Esc und Tab (ein Dialog in einem verborgenen Tab zählt nicht) */
  private top(): boolean {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].el.nativeElement.getClientRects().length > 0) return stack[i] === this;
    return false;
  }

  protected onKey(ev: KeyboardEvent): void {
    if (ev.defaultPrevented || ev.isComposing || (ev.key !== 'Escape' && ev.key !== 'Tab') || !this.top()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.dismiss.emit();
      return;
    }
    const host = this.el.nativeElement;
    const items = this.tabbable();
    const a = document.activeElement;
    const inside = a instanceof HTMLElement && a !== host && host.contains(a);
    if (!items.length) {
      ev.preventDefault();
      host.focus();
    } else if (!inside || a === (ev.shiftKey ? items[0] : items[items.length - 1])) {
      // am Rand oder ohne Fokus im Dialog: ans andere Ende bzw. an den Anfang
      ev.preventDefault();
      (ev.shiftKey ? items[items.length - 1] : items[0]).focus();
    }
  }

  /** Fokus wandert trotzdem hinaus (Tab aus einem unsichtbaren Element, Skripte dahinter): zurück in den Dialog */
  protected onFocusIn(ev: FocusEvent): void {
    const host = this.el.nativeElement;
    if (ev.target instanceof Node && !host.contains(ev.target) && this.top()) (this.tabbable()[0] ?? host).focus();
  }

  private tabbable(): HTMLElement[] {
    const host = this.el.nativeElement;
    return [...host.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
      if (el.tabIndex < 0 || el.getClientRects().length === 0) return false;
      // Radiogruppe: Tab hält nur am gewählten Knopf, ohne Auswahl am ersten
      if (el instanceof HTMLInputElement && el.type === 'radio' && el.name && !el.checked) {
        const group = [...host.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
        return !group.some((r) => r.checked) && group[0] === el;
      }
      return true;
    });
  }
}
