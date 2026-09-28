import { Injectable, signal } from '@angular/core';

export type ThemeMode = 'dark' | 'light';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>(this.readSavedTheme());

  constructor() {
    this.apply(this.mode());
  }

  toggle(): void {
    const nextTheme = this.mode() === 'dark' ? 'light' : 'dark';
    this.mode.set(nextTheme);
    this.apply(nextTheme);
    try {
      localStorage.setItem('jhunay-theme', nextTheme);
    } catch {
      return;
    }
  }

  private readSavedTheme(): ThemeMode {
    try {
      return localStorage.getItem('jhunay-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  private apply(theme: ThemeMode): void {
    if (typeof document !== 'undefined') document.documentElement.dataset['theme'] = theme;
  }
}