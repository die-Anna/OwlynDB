import { afterNextRender, ChangeDetectionStrategy, Component, DestroyRef, effect, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { Theme } from '../ui/theme';
import { CompletionSource, MonacoApi, MonacoLoader } from './monaco';

@Component({
  selector: 'app-sql-editor',
  template: `<div #host class="host"></div>
    @if (loadError()) {
      <div class="error-box">{{ loadError() }}</div>
    }`,
  styles: `
    :host {
      display: block;
      position: relative;
      min-height: 0;
    }
    .host {
      position: absolute;
      inset: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SqlEditor {
  readonly value = input('');
  readonly readOnly = input(false);
  /** sql, es-console (Elasticsearch-Tab), json bzw. plaintext (Antwort anzeigen); ein wiederverwendeter Editor folgt */
  readonly language = input('sql');
  readonly completion = input<CompletionSource | null>(null);
  readonly changed = output<string>();
  readonly ready = output<{ editor: Monaco.editor.IStandaloneCodeEditor; monaco: MonacoApi }>();

  private host = viewChild.required<ElementRef<HTMLElement>>('host');
  private loader = inject(MonacoLoader);
  private theme = inject(Theme);
  protected loadError = signal<string | null>(null);
  private editor?: Monaco.editor.IStandaloneCodeEditor;
  private monaco?: MonacoApi;
  private destroyed = false;

  constructor() {
    afterNextRender(() => void this.init());
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.editor?.getModel()?.dispose();
      this.editor?.dispose();
    });
    // gleiche Komponente, neues Ergebnis (z. B. erst _cat als Text, dann ein Mapping als JSON): Hervorhebung und Falten
    // passen sonst nicht zum Inhalt
    effect(() => {
      const lang = this.language();
      const model = this.editor?.getModel();
      if (model && this.monaco && model.getLanguageId() !== lang) this.monaco.editor.setModelLanguage(model, lang);
    });
    effect(() => {
      const dark = this.theme.dark();
      this.monaco?.editor.setTheme(dark ? 'vs-dark' : 'vs');
    });
    // Nur-Lese-Editor (DDL) folgt dem Eingabewert
    effect(() => {
      const v = this.value();
      if (this.editor && this.readOnly() && this.editor.getValue() !== v) this.editor.setValue(v);
    });
  }

  private async init() {
    let m: MonacoApi;
    try {
      m = await this.loader.load();
    } catch (e) {
      this.loadError.set('Editor konnte nicht geladen werden: ' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    // während des Ladens zerstört (Tab geschlossen, Reiter gewechselt): sonst bliebe ein unsichtbarer Editor samt Modell,
    // ResizeObserver und Vervollständigungsquelle bestehen
    if (this.destroyed) return;
    this.monaco = m;
    m.editor.setTheme(this.theme.dark() ? 'vs-dark' : 'vs');
    const model = m.editor.createModel(this.value(), this.language());
    const src = this.completion();
    if (src) this.loader.register(model, src);
    const ed = m.editor.create(this.host().nativeElement, {
      model,
      readOnly: this.readOnly(),
      automaticLayout: true,
      fontFamily: "'Cascadia Mono', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: this.readOnly() ? 'none' : 'line',
      wordWrap: 'off',
      tabSize: 2,
      fixedOverflowWidgets: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: 'off',
      contextmenu: true,
      padding: { top: 6 },
    });
    this.editor = ed;
    ed.onDidChangeModelContent(() => this.changed.emit(ed.getValue()));
    this.ready.emit({ editor: ed, monaco: m });
    if (!this.readOnly()) ed.focus();
  }
}
