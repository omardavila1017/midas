'use client';

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import {
  LayoutDashboard,
  Sliders,
  FlaskConical,
  LineChart,
  Users,
  HandCoins,
  UserSquare,
  Receipt,
  Landmark,
  Wallet,
  Search,
  Loader2,
} from 'lucide-react';

type TabId =
  | 'dashboard'
  | 'kpis'
  | 'scenarios'
  | 'forecast'
  | 'providers'
  | 'collections'
  | 'clients'
  | 'cxp'
  | 'bancos'
  | 'netflow';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (tabId: string) => void;
  clients?: { id: string; name: string }[];
  providers?: { id: string; name: string }[];
  simulations?: { id: string; name: string }[];
}

interface NavigationItem {
  tabId: TabId;
  label: string;
  icon: React.ReactNode;
}

interface ResultItem {
  id: string;
  label: string;
  category: 'Navegación' | 'Clientes' | 'Proveedores' | 'Propuestas';
  icon: React.ReactNode;
  tabId?: string;
}

const NAVIGATION_ITEMS: NavigationItem[] = [
  { tabId: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={18} /> },
  { tabId: 'kpis', label: 'KPIs', icon: <Sliders size={18} /> },
  { tabId: 'scenarios', label: 'Escenarios', icon: <FlaskConical size={18} /> },
  { tabId: 'forecast', label: 'Pronóstico', icon: <LineChart size={18} /> },
  { tabId: 'providers', label: 'Proveedores', icon: <Users size={18} /> },
  { tabId: 'collections', label: 'Cobros', icon: <HandCoins size={18} /> },
  { tabId: 'clients', label: 'Clientes', icon: <UserSquare size={18} /> },
  { tabId: 'cxp', label: 'CxP', icon: <Receipt size={18} /> },
  { tabId: 'bancos', label: 'Bancos', icon: <Landmark size={18} /> },
  { tabId: 'netflow', label: 'Flujo Neto', icon: <Wallet size={18} /> },
];

const fuzzyMatch = (query: string, text: string): boolean => {
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();
  return lowerText.includes(lowerQuery);
};

const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  onNavigate,
  clients = [],
  providers = [],
  simulations = [],
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Build results grouped by category
  const results = useMemo<ResultItem[]>(() => {
    const navResults: ResultItem[] = NAVIGATION_ITEMS.filter((item) =>
      fuzzyMatch(query, item.label)
    ).map((item) => ({
      id: item.tabId,
      label: item.label,
      category: 'Navegación',
      icon: item.icon,
      tabId: item.tabId,
    }));

    const clientResults: ResultItem[] = clients
      .filter((c) => fuzzyMatch(query, c.name))
      .slice(0, 8)
      .map((c) => ({
        id: c.id,
        label: c.name,
        category: 'Clientes',
        icon: <UserSquare size={18} />,
        tabId: 'clients',
      }));

    const providerResults: ResultItem[] = providers
      .filter((p) => fuzzyMatch(query, p.name))
      .slice(0, 8)
      .map((p) => ({
        id: p.id,
        label: p.name,
        category: 'Proveedores',
        icon: <Users size={18} />,
        tabId: 'providers',
      }));

    const simulationResults: ResultItem[] = simulations
      .filter((pr) => fuzzyMatch(query, pr.name))
      .slice(0, 8)
      .map((pr) => ({
        id: pr.id,
        label: pr.name,
        category: 'Propuestas',
        icon: <Receipt size={18} />,
        tabId: 'cxp',
      }));

    // Limit navigation results to 8
    navResults.slice(0, 8);

    return [
      ...navResults.slice(0, 8),
      ...clientResults,
      ...providerResults,
      ...simulationResults,
    ];
  }, [query, clients, providers, simulations]);

  // Group results by category
  const groupedResults = useMemo(() => {
    const groups: Record<string, ResultItem[]> = {
      Navegación: [],
      Clientes: [],
      Proveedores: [],
      Propuestas: [],
    };

    results.forEach((item) => {
      groups[item.category].push(item);
    });

    return Object.entries(groups)
      .filter(([_, items]) => items.length > 0)
      .map(([category, items]) => ({ category, items }));
  }, [results]);

  // Flatten for navigation purposes
  const flatResults = useMemo(
    () => results,
    [results]
  );

  // Focus input when modal opens
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Reset query and selection on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < flatResults.length - 1 ? prev + 1 : 0
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : flatResults.length - 1
          );
          break;
        case 'Enter':
          e.preventDefault();
          if (flatResults[selectedIndex]) {
            const item = flatResults[selectedIndex];
            if (item.tabId) {
              onNavigate(item.tabId);
            }
            onClose();
          }
          break;
        default:
          break;
      }
    },
    [flatResults, selectedIndex, onNavigate, onClose]
  );

  // Scroll selected item into view
  useEffect(() => {
    if (resultsRef.current && flatResults.length > 0) {
      const selectedElement = resultsRef.current.querySelector(
        `[data-index="${selectedIndex}"]`
      ) as HTMLElement | null;
      if (selectedElement) {
        selectedElement.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth',
        });
      }
    }
  }, [selectedIndex, flatResults.length]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[399] bg-black/50 animate-fadeIn"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="fixed inset-0 z-[400] flex items-start justify-center pointer-events-none pt-20 px-4">
        <div className="pointer-events-auto w-full max-w-2xl animate-scale-in">
          {/* Command Palette Container */}
          <div className="bg-white rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] overflow-hidden">
            {/* Search Input */}
            <div className="relative border-b border-gray-200 px-4 py-3">
              <div className="flex items-center gap-3">
                <Search size={20} className="text-gray-400" />
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Buscar navegación, clientes, proveedores..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSelectedIndex(0);
                  }}
                  onKeyDown={handleKeyDown}
                  className="flex-1 bg-transparent outline-none text-gray-900 placeholder-gray-400 text-base"
                  aria-label="Buscar comandos"
                />
                <kbd className="hidden sm:inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-gray-400 bg-gray-100 rounded border border-gray-200">
                  <span>⌘</span>
                  <span>K</span>
                </kbd>
              </div>
            </div>

            {/* Results */}
            <div
              ref={resultsRef}
              className="max-h-96 overflow-y-auto divide-y divide-gray-100"
            >
              {flatResults.length === 0 ? (
                <div className="px-4 py-8 text-center text-gray-500">
                  <p>Sin resultados para '{query}'</p>
                </div>
              ) : (
                groupedResults.map((group) => (
                  <div key={group.category}>
                    {/* Category Header */}
                    <div className="px-4 pt-3 pb-2">
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        {group.category}
                      </h3>
                    </div>

                    {/* Items in category */}
                    {group.items.map((item, indexInGroup) => {
                      const globalIndex = flatResults.findIndex(
                        (r) => r.id === item.id
                      );
                      const isSelected = selectedIndex === globalIndex;

                      return (
                        <button
                          key={item.id}
                          data-index={globalIndex}
                          onClick={() => {
                            if (item.tabId) {
                              onNavigate(item.tabId);
                            }
                            onClose();
                          }}
                          onMouseEnter={() => setSelectedIndex(globalIndex)}
                          className={`w-full px-4 py-2.5 flex items-center gap-3 transition-colors text-left ${
                            isSelected
                              ? 'bg-[color:var(--primary)]/10'
                              : 'hover:bg-gray-50'
                          }`}
                          aria-selected={isSelected}
                        >
                          <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-gray-600">
                            {item.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">
                              {item.label}
                            </p>
                          </div>
                          {isSelected && (
                            <div className="flex-shrink-0 text-xs font-medium text-gray-400">
                              ↵
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            {flatResults.length > 0 && (
              <div className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500 bg-gray-50">
                <div className="flex items-center justify-between">
                  <span>
                    Resultado {selectedIndex + 1} de {flatResults.length}
                  </span>
                  <span>Esc para cerrar</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

/**
 * Hook to manage the Command Palette open/closed state
 * Registers a global Cmd+K / Ctrl+K listener
 */
export const useCommandPalette = () => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Cmd+K (Mac) or Ctrl+K (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return { open, setOpen };
};

export default CommandPalette;
