import {readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {OpenDialogOptions} from 'electron';
import type {Language} from '../src/i18n/locale';
import {serviceMessage} from '../src/i18n/catalog';

/** Read before the storage worker starts so the startup screen uses the saved language. */
export class UiLanguage {
  private readonly file: string;
  value: Language;
  constructor(directory: string) {
    this.file = path.join(directory, 'ui-language');
    try { this.value = readFileSync(this.file, 'utf8').trim() === 'en' ? 'en' : 'tr'; }
    catch { this.value = 'tr'; }
  }
  set(value: unknown) {
    if (value !== 'en' && value !== 'tr') throw new Error('Geçersiz dil tercihi.');
    writeFileSync(this.file+'.tmp', value, 'utf8');
    renameSync(this.file+'.tmp', this.file);
    this.value = value;
  }
  text(value: string) { return serviceMessage(value,this.value); }
  dialog(options: OpenDialogOptions): OpenDialogOptions {
    return {...options, title: options.title && this.text(options.title),
      filters: options.filters?.map(filter=>({...filter,name:this.text(filter.name)}))};
  }
}
