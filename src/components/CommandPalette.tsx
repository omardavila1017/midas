'use client';

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useDeferredValue,
} from 'react';
import {
  LayoutDashboard,
  Sliders,
  FlaskConical,
  LineChart,
  CalendarDays,
  Users,
  HandCoins,
  UserSquare,
  Receipt,
  Landmark,
  Wallet,
  Search,
  BarChart3,
  ClipboardList,
  GitBranch,
  Zap,
} from 'lucide-react';

type TabId =
  | 'dashboard'
  | 'financialProjection'
  | 'financialPlanning'
  | 'kpis'
  | 'scenarios'
  | 'forecast'
  | 'operating'
  | 'providers'
  | 'collections'
  | 'clients'
  | 'cxp'
  | 'bancos'
  | 'netflow';

export interface CommandPaletteAction {
  id: string;
  label: string;
  icon?: React.ReactNode;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (tabId: string) => void;
  clients?: { id: string; name: string }[];
  providers?: { id: string; name: string }[];
  simulations?: { id: string; name: string }[];
  scenarios?: { id: string; name: string }[];
  actions?: CommandPaletteAction[];
}

interface NavigationItem {
  tabId: TabId;
  label: string;
  icon: React.ReactNode;
}

type ResultCategory = 'Acciones' | 'Navegación' | 'Escenarios' | 'Clientes' | 'Proveedores' | 'Propuestas';

interface ResultItem {
  id: string;
  label: string;
  category: ResultCategory;
  icon: React.ReactNode;
  tabId?: string;
  run?: () => void;
  scenarioId?: string;
}

const NAVIGATION_ITEMS: NavigationItem[] = [
  { tabId: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={18} /> },
  { tabId: 'financialProjection', label: 'Proyección Financiera', icon: <BarChart3 size={18} /> },
  { tabId: 'financialPlanning', label: 'Planeación Financiera', icon: <ClipboardList size={18} /> },
  { tabId: 'kpis', label: 'KPIs', icon: <Sliders size={18} /> },
  { tabId: 'scenarios', label: 'Escenarios', icon: <FlaskConical size={18} /> },
  { tabId: 'forecast', label: 'Pronóstico', icon: <LineChart size={18} /> },
  { tabId: 'operating', label: 'Proyección operativa', icon: <CalendarDays size={18} /> },
  { tabId: 'providers', label: 'Proveedores', icon: <Users size={18} /> },
  { tabId: 'collections', label: 'Cobros', icon: <HandCoins size={18} /> },
  { tabId: 'clients', label: 'Clientes', icon: <UserSquare size={18} /> },
  { tabId: 'cxp', label: 'CxP', icon: <Receipt size={18} /> },
  { tabId: 'bancos', label: 'Bancos', icon: <Landmark size={18} /> },
  { tabId: 'netflow', label: 'Flujo Neto', icon: <Wallet size={18} /> },
];

const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  onNavigate,
  clients = [],
  providers = [],
  simulations = [],
  scenarios = [],
  actions = [],
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = useMemo(() => deferredQuery.trim().toLowerCase(), [deferredQuery]);

  const searchableActions = useMemo(
    () => actions.map((item) => ({ item, search: item.label.toLowerCase() })),
    [actions],
  );
  const searchableScenarios = useMemo(
    () => scenarios.map((item) => ({ item, search: item.name.toLowerCase() })),
    [scenarios],
  );
  const searchableClients = useMemo(
    () => clients.map((item) => ({ item, search: item.name.toLowerCase() })),
    [clients],
  );
  const searchableProviders = useMemo(
    () => providers.map((item) => ({ item, search: item.name.toLowerCase() })),
    [providers],
  );
  const searchableSimulations = useMemo(
    () => simulations.map((item) => ({ item, search: item.name.toLowerCase() })),
    [simulations],
  );

  // Build results grouped by category
  const results = useMemo<ResultItem[]>(() => {
    const actionResults: ResultItem[] = searchableActions
      .filter(({ search }) => search.includes(normalizedQuery))
      .slice(0, 6)
      .map(({ item }) => ({
        id: item.id,
        label: item.label,
        category: 'Acciones',
        icon: item.icon ?? <Zap size={18} />,
        run: item.run,
      }));

    const navResults: ResultItem[] = NAVIGATION_ITEMS.filter((item) =>
      item.label.toLowerCase().includes(normalizedQuery)
    ).map((item) => ({
      id: item.tabId,
      label: item.label,
      category: 'Navegación',
      icon: item.icon,
      tabId: item.tabId,
    }));

    const scenarioResults: ResultItem[] = searchableScenarios
      .filter(({ search }) => search.includes(normalizedQuery))
      .slice(0, 8)
      .map(({ item }) => ({
        id: item.id,
        label: item.name,
        category: 'Escenarios',
        icon: <GitBranch size={18} />,
        tabId: 'financialPlanning',
        scenarioId: item.id,
      }));

    const clientResults: ResultItem[] = searchableClients
      .filter(({ search }) => search.includes(normalizedQuery))
      .slice(0, 8)
      .map(({ item }) => ({
        id: item.id,
        label: item.name,
        category: 'Clientes',
        icon: <UserSquare size={18} />,
        tabId: 'clients',
      }));

    const providerResults: ResultItem[] = searchableProviders
      .filter(({ search }) => search.includes(normalizedQuery))
      .slice(0, 8)
      .map(({ item }) => ({
        id: item.id,
        label: item.name,
        category: 'Proveedores',
        icon: <Users size={18} />,
        tabId: 'providers',
      }));

    const simulationResults: ResultItem[] = searchableSimulations
      .filter(({ search }) => search.includes(normalizedQuery))
      .slice(0, 8)
      .map(({ item }) => ({
        id: item.id,
        label: item.name,
        category: 'Propuestas',
        icon: <Receipt size={18} />,
        tabId: 'financialPlanning',
      }));

    return [
      ...actionResults,
      ...navResults.slice(0, 8),
      ...scenarioResults,
      ...clientResults,
      ...providerResults,
      ...simulationResults,
    ];
  }, [normalizedQuery, searchableActions, searchableScenarios, searchableClients, searchableProviders, searchableSimulations]);

  // Group results by category
  const groupedResults = useMemo(() => {
    const groups: Record<string, ResultItem[]> = {
      Acciones: [],
      Navegación: [],
      Escenarios: [],
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
            if (item.run) {
              item.run();
            } else if (item.tabId) {
              onNavigate(item.tabId);
              if (item.scenarioId) {
                window.dispatchEvent(new CustomEvent('midas:planning:setActiveScenario', { detail: { scenarioId: item.scenarioId } }));
              }
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
        className="fixed inset-0 z-[399] animate-fadeIn"
        style={{ background: 'var(--modal-overlay)' }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="fixed inset-0 z-[400] flex items-start justify-center pointer-events-none pt-20 px-4">
        <div className="pointer-events-auto w-full max-w-2xl animate-scale-in">
          {/* Command Palette Container */}
          <div
            className="rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] overflow-hidden border"
            style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
          >
            {/* Search Input */}
            <div className="relative px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3">
                <Search size={20} style={{ color: 'var(--gray-400)' }} />
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
                  className="flex-1 bg-transparent outline-none text-base"
                  style={{ color: 'var(--card-foreground)' }}
                  aria-label="Buscar comandos"
                />
                <kbd
                  className="hidden sm:inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded border"
                  style={{
                    background: 'var(--gray-100)',
                    color: 'var(--gray-500)',
                    borderColor: 'var(--border)',
                  }}
                >
                  <span>⌘</span>
                  <span>K</span>
                </kbd>
              </div>
            </div>

            {/* Results */}
            <div ref={resultsRef} className="max-h-96 overflow-y-auto">
              {flatResults.length === 0 ? (
                <div className="px-4 py-8 text-center" style={{ color: 'var(--muted-foreground)' }}>
                  <p>Sin resultados para '{query}'</p>
                </div>
              ) : (
                groupedResults.map((group) => (
                  <div key={group.category} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <div className="px-4 pt-3 pb-2">
                      <h3 className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
                        {group.category}
                      </h3>
                    </div>

                    {group.items.map((item) => {
                      const globalIndex = flatResults.findIndex((r) => r.id === item.id);
                      const isSelected = selectedIndex === globalIndex;
                      return (
                        <button
                          key={item.id}
                          data-index={globalIndex}
                          onClick={() => {
                            if (item.run) item.run();
                            else if (item.tabId) {
                              onNavigate(item.tabId);
                              if (item.scenarioId) {
                                window.dispatchEvent(new CustomEvent('midas:planning:setActiveScenario', { detail: { scenarioId: item.scenarioId } }));
                              }
                            }
                            onClose();
                          }}
                          onMouseEnter={() => setSelectedIndex(globalIndex)}
                          className="w-full px-4 py-2.5 flex items-center gap-3 transition-colors text-left"
                          style={{
                            background: isSelected ? 'color-mix(in oklch, var(--accent-blue) 14%, transparent)' : 'transparent',
                          }}
                          aria-selected={isSelected}
                        >
                          <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
                            {item.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate" style={{ color: 'var(--card-foreground)' }}>
                              {item.label}
                            </p>
                          </div>
                          {isSelected && (
                            <div className="flex-shrink-0 text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>↵</div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {flatResults.length > 0 && (
              <div
                className="border-t px-4 py-2 text-xs"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--muted)',
                  color: 'var(--muted-foreground)',
                }}
              >
                <div className="flex items-center justify-between">
                  <span>Resultado {selectedIndex + 1} de {flatResults.length}</span>
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
