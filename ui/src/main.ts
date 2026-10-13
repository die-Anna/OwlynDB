import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { applyThemeMode, storedThemeMode } from './app/ui/theme';

// Darstellung vor dem ersten Zeichnen setzen: sonst blitzte bei hell gewähltem Modus und dunklem Windows kurz Dunkel auf
applyThemeMode(storedThemeMode());

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
