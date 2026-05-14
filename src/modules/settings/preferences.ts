import { create } from "zustand";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  onPreferencesChange,
  type Preferences,
} from "./store";

type State = Preferences & {
  hydrated: boolean;
  /** Subscribe & hydrate. Idempotent — safe to call from multiple windows. */
  init: () => Promise<void>;
};

let initialized = false;

export const usePreferencesStore = create<State>((set) => ({
  ...DEFAULT_PREFERENCES,
  hydrated: false,
  init: async () => {
    if (initialized) return;
    initialized = true;
    const prefs = await loadPreferences().catch((error) => {
      console.warn("settings preferences hydration failed", error);
      return DEFAULT_PREFERENCES;
    });
    set({ ...prefs, hydrated: true });
    void onPreferencesChange((key, value) => {
      set({ [key]: value } as Partial<State>);
    }).catch((error) => {
      console.warn("settings preferences subscription failed", error);
    });
  },
}));
