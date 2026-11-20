export type Lauf = { zustand: 'liest' | 'fertig' | 'fehler'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'sonnet-kompakt': { lauf: Lauf | null; kontext: number | null; antwort: number | null }
  }
}
