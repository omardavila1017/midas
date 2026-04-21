import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import {
  Bell,
  Plus,
  Pencil,
  Trash2,
  Download,
  Upload,
  CheckCircle2,
  X,
} from 'lucide-react';

/* ─────────────────────────────────────────────────
   Types
   ───────────────────────────────────────────────── */

export type ActivityAction = 'create' | 'update' | 'delete' | 'import' | 'export' | 'confirm';
export type ActivityEntity =
  | 'client'
  | 'provider'
  | 'proposal'
  | 'scenario'
  | 'simulation'
  | 'kpi'
  | 'cxp'
  | 'plan'
  | 'payment';

export interface ActivityEntry {
  id: string;
  action: ActivityAction;
  entity: ActivityEntity;
  entityName: string;
  detail?: string;
  timestamp: string; // ISO 8601
  tabId?: string;    // which tab to navigate to
}

interface ActivityContextType {
  log: (entry: Omit<ActivityEntry, 'id' | 'timestamp'>) => void;
  entries: ActivityEntry[];
  clear: () => void;
}

/* ─────────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────────── */

const STORAGE_KEY = 'flowsense.activityFeed';
const MAX_ENTRIES = 200;

const ACTION_ICONS: Record<ActivityAction, React.ComponentType<any>> = {
  create: Plus,
  update: Pencil,
  delete: Trash2,
  import: Download,
  export: Upload,
  confirm: CheckCircle2,
};

const ENTITY_COLOR_MAP: Record<ActivityEntity, string> = {
  client: 'var(--primary)',
  provider: 'var(--chart-4)',          // purple
  proposal: 'var(--success)',
  scenario: 'var(--warning)',
  simulation: 'var(--info)',         // cyan
  kpi: 'var(--chart-5)',               // orange
  cxp: 'var(--danger)',               // red
  plan: 'var(--primary)',              // blue
  payment: 'var(--success)',
};

const ENTITY_LABEL_MAP: Record<ActivityEntity, string> = {
  client: 'Cliente',
  provider: 'Proveedor',
  proposal: 'Propuesta',
  scenario: 'Escenario',
  simulation: 'Simulación',
  kpi: 'KPI',
  cxp: 'CXP',
  plan: 'Plan',
  payment: 'Pago',
};

const ACTION_LABEL_MAP: Record<ActivityAction, string> = {
  create: 'Creado',
  update: 'Actualizado',
  delete: 'Eliminado',
  import: 'Importado',
  export: 'Exportado',
  confirm: 'Confirmado',
};

/* ─────────────────────────────────────────────────
   Context
   ───────────────────────────────────────────────── */

const ActivityContext = createContext<ActivityContextType | undefined>(undefined);

/* ─────────────────────────────────────────────────
   Helper Functions
   ───────────────────────────────────────────────── */

function loadFromStorage(): ActivityEntry[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as ActivityEntry[];
  } catch {
    return [];
  }
}

function saveToStorage(entries: ActivityEntry[]): void {
  try {
    const capped = entries.slice(-MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // Ignore storage quota failures; activity history is non-critical.
  }
}

function formatRelativeTime(isoTimestamp: string): string {
  const now = new Date();
  const time = new Date(isoTimestamp);
  const diffMs = now.getTime() - time.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'ahora';
  if (diffMins < 60) return `hace ${diffMins}m`;
  if (diffHours < 24) return `hace ${diffHours}h`;
  if (diffDays === 1) return 'ayer';
  if (diffDays < 7) return `hace ${diffDays}d`;
  return time.toLocaleDateString('es-ES');
}

function getDateGroup(isoTimestamp: string): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const time = new Date(isoTimestamp);
  const timeDate = new Date(time.getFullYear(), time.getMonth(), time.getDate());

  if (timeDate.getTime() === today.getTime()) return 'Hoy';
  if (timeDate.getTime() === yesterday.getTime()) return 'Ayer';

  const daysDiff = Math.floor((today.getTime() - timeDate.getTime()) / 86400000);
  if (daysDiff < 7) return 'Esta semana';

  return 'Antes';
}

/* ─────────────────────────────────────────────────
   Provider Component
   ───────────────────────────────────────────────── */

interface ActivityFeedProviderProps {
  children: ReactNode;
}

export function ActivityFeedProvider({ children }: ActivityFeedProviderProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>(() => loadFromStorage());

  const log = useCallback(
    (entry: Omit<ActivityEntry, 'id' | 'timestamp'>) => {
      const newEntry: ActivityEntry = {
        ...entry,
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      };

      setEntries((prev) => {
        const updated = [newEntry, ...prev];
        saveToStorage(updated);
        return updated;
      });
    },
    [],
  );

  const clear = useCallback(() => {
    setEntries([]);
    saveToStorage([]);
  }, []);

  const value: ActivityContextType = {
    log,
    entries,
    clear,
  };

  return (
    <ActivityContext.Provider value={value}>
      {children}
    </ActivityContext.Provider>
  );
}

/* ─────────────────────────────────────────────────
   Hook
   ───────────────────────────────────────────────── */

export function useActivityFeed(): ActivityContextType {
  const context = useContext(ActivityContext);
  if (context === undefined) {
    throw new Error(
      'useActivityFeed must be used within an ActivityFeedProvider',
    );
  }
  return context;
}

/* ─────────────────────────────────────────────────
   Activity Feed Panel Component
   ───────────────────────────────────────────────── */

interface ActivityFeedPanelProps {
  open: boolean;
  onClose: () => void;
  onNavigate?: (tabId: string) => void;
}

export function ActivityFeedPanel({
  open,
  onClose,
  onNavigate,
}: ActivityFeedPanelProps) {
  const { entries, clear } = useActivityFeed();
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, 200);
  };

  const handleNavigate = (tabId?: string) => {
    if (tabId && onNavigate) {
      onNavigate(tabId);
      handleClose();
    }
  };

  // Group entries by date
  const groupedEntries = entries.reduce(
    (acc, entry) => {
      const group = getDateGroup(entry.timestamp);
      if (!acc[group]) {
        acc[group] = [];
      }
      acc[group].push(entry);
      return acc;
    },
    {} as Record<string, ActivityEntry[]>,
  );

  const orderedGroups = ['Hoy', 'Ayer', 'Esta semana', 'Antes'];
  const sortedGroups = orderedGroups.filter((g) => groupedEntries[g]);

  if (!open) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className={`fixed inset-0 transition-opacity duration-200 ${
          isClosing ? 'opacity-0' : 'opacity-100'
        }`}
        style={{
          zIndex: 400,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
        }}
        onClick={handleClose}
      />

      {/* Panel */}
      <div
        className={`fixed top-0 right-0 h-screen bg-white flex flex-col transition-transform duration-200 ${
          isClosing ? 'translate-x-full' : 'translate-x-0'
        }`}
        style={{
          zIndex: 410,
          width: '360px',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between p-4 border-b"
          style={{
            borderColor: 'var(--gray-200)',
          }}
        >
          <div className="flex items-center gap-2">
            <Bell
              className="w-5 h-5"
              style={{
                color: 'var(--primary)',
              }}
            />
            <h2 className="text-base font-semibold">Actividad reciente</h2>
            {entries.length > 0 && (
              <span
                className="text-xs font-medium px-2 py-1 rounded-full"
                style={{
                  backgroundColor: 'var(--primary)',
                  color: 'white',
                }}
              >
                {entries.length}
              </span>
            )}
          </div>

          <button
            onClick={handleClose}
            className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center h-full gap-2"
              style={{
                color: 'var(--gray-500)',
              }}
            >
              <Bell className="w-8 h-8 opacity-40" />
              <p className="text-sm">Sin actividad registrada</p>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--gray-100)' }}>
              {sortedGroups.map((group) => (
                <div key={group}>
                  {/* Date Group Header */}
                  <div
                    className="sticky top-0 px-4 py-2 text-xs font-semibold uppercase tracking-wider"
                    style={{
                      backgroundColor: 'var(--gray-50)',
                      color: 'var(--gray-500)',
                      borderBottom: '1px solid var(--gray-100)',
                      zIndex: 10,
                    }}
                  >
                    {group}
                  </div>

                  {/* Entries in Group */}
                  {groupedEntries[group]?.map((entry) => (
                    <ActivityEntryItem
                      key={entry.id}
                      entry={entry}
                      onNavigate={handleNavigate}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {entries.length > 0 && (
          <div
            className="border-t p-4"
            style={{
              borderColor: 'var(--gray-200)',
            }}
          >
            <button
              onClick={clear}
              className="w-full text-center text-xs font-medium py-2 rounded-lg transition-colors hover:bg-gray-100"
              style={{
                color: 'var(--gray-500)',
              }}
            >
              Limpiar historial
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────
   Activity Entry Item Component
   ───────────────────────────────────────────────── */

interface ActivityEntryItemProps {
  entry: ActivityEntry;
  onNavigate: (tabId?: string) => void;
}

function ActivityEntryItem({ entry, onNavigate }: ActivityEntryItemProps) {
  const IconComponent = ACTION_ICONS[entry.action];
  const entityColor = ENTITY_COLOR_MAP[entry.entity];
  const entityLabel = ENTITY_LABEL_MAP[entry.entity];
  const actionLabel = ACTION_LABEL_MAP[entry.action];
  const relativeTime = formatRelativeTime(entry.timestamp);

  const isClickable = !!entry.tabId;

  return (
    <button
      onClick={() => onNavigate(entry.tabId)}
      disabled={!isClickable}
      className={`w-full px-4 py-3 text-left transition-colors ${
        isClickable
          ? 'hover:bg-gray-50 active:bg-gray-100 cursor-pointer'
          : 'cursor-default'
      }`}
      style={{
        backgroundColor: 'transparent',
        border: 'none',
        padding: 0,
      }}
    >
      <div className="flex gap-3 px-4 py-3">
        {/* Icon */}
        <div
          className="mt-1 p-2 rounded-lg flex-shrink-0"
          style={{
            backgroundColor: `${entityColor}15`,
            color: entityColor,
          }}
        >
          <IconComponent className="w-4 h-4" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Top row: action + entity label */}
          <div className="flex items-center gap-2 mb-1">
            <span
              className="text-sm font-medium"
              style={{
                color: 'var(--gray-900)',
              }}
            >
              {actionLabel}
            </span>
            <span
              className="text-xs font-medium px-2 py-0.5 rounded-full"
              style={{
                backgroundColor: `${entityColor}20`,
                color: entityColor,
              }}
            >
              {entityLabel}
            </span>
          </div>

          {/* Entity name */}
          <p
            className="text-sm font-semibold truncate"
            style={{
              color: 'var(--gray-950)',
            }}
          >
            {entry.entityName}
          </p>

          {/* Detail if present */}
          {entry.detail && (
            <p
              className="text-xs line-clamp-2 mt-1"
              style={{
                color: 'var(--gray-500)',
              }}
            >
              {entry.detail}
            </p>
          )}

          {/* Timestamp */}
          <p
            className="text-xs mt-1"
            style={{
              color: 'var(--gray-400)',
            }}
          >
            {relativeTime}
          </p>
        </div>

        {/* Navigate indicator */}
        {isClickable && (
          <div
            className="flex-shrink-0 mt-1"
            style={{
              color: 'var(--gray-300)',
            }}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </div>
        )}
      </div>
    </button>
  );
}
