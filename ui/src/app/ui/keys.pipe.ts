import { Pipe, PipeTransform } from '@angular/core';
import { keys } from '../core/platform';

/** Tastenkürzel im Text in der Schreibweise des Systems (auf dem Mac ⌘ statt Strg, siehe keys) */
@Pipe({ name: 'keys' })
export class KeysPipe implements PipeTransform {
  transform(text: string | null | undefined): string {
    return text == null ? '' : keys(text);
  }
}
