import { useState, useEffect } from 'react';

/**
 * Hook for managing dark mode state.
 * Persists preference to localStorage and syncs with system preferences on first load.
 * Applies/removes .dark class on document root.
 *
 * @returns {Object} Dark mode state and control functions
 * @returns {boolean} dark - Current dark mode state
 * @returns {Function} toggle - Toggle dark mode
 * @returns {Function} setDark - Set dark mode to specific value
 */
export function useDarkMode() {
  const [dark, setDark] = useState(() => {
    // SSR safety: only access window/localStorage on client
    if (typeof window === 'undefined') return false;

    // Check localStorage first, then fall back to system preference
    const stored = localStorage.getItem('flowsense.darkMode');
    if (stored !== null) {
      return stored === 'true';
    }

    // Default to system preference if not explicitly set
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    const root = document.documentElement;

    // Apply or remove dark class from root element
    if (dark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }

    // Persist preference to localStorage
    localStorage.setItem('flowsense.darkMode', String(dark));
  }, [dark]);

  const toggle = () => setDark((prevDark) => !prevDark);

  return { dark, toggle, setDark };
}
