import { useEffect, useId, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

const STORAGE_KEY = 'midas.theme';

type Theme = 'light' | 'dark';

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* noop */
  }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

export function DarkModeToggle() {
  const inputId = useId();
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* noop */
    }
  }, [theme]);

  const isDark = theme === 'dark';

  return (
    <>
      <input
        id={inputId}
        type="checkbox"
        className="dm-toggle__input"
        checked={isDark}
        onChange={(event) => setTheme(event.target.checked ? 'dark' : 'light')}
        aria-label={isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
      />
      <label htmlFor={inputId} className="dm-toggle__switch" title={isDark ? 'Modo oscuro' : 'Modo claro'}>
        <Sun className="dm-toggle__icon dm-toggle__icon--sun" strokeWidth={2} />
        <Moon className="dm-toggle__icon dm-toggle__icon--moon" strokeWidth={2} />
      </label>
    </>
  );
}

export default DarkModeToggle;
