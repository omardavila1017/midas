import type { MidasMessage } from '../types';

const KEY = 'midas.midasAi.conversations.v1';
const MAX_MESSAGES = 50;

type Store = Record<string, MidasMessage[]>; // key = `${cia}:${scenarioId}`

function readStore(): Store {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(KEY) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // localStorage full o inaccesible — silencioso, no es crítico
  }
}

function conversationKey(cia: string, scenarioId: string): string {
  return `${cia}:${scenarioId}`;
}

export function loadConversation(cia: string, scenarioId: string): MidasMessage[] {
  const store = readStore();
  return store[conversationKey(cia, scenarioId)] ?? [];
}

export function saveConversation(cia: string, scenarioId: string, messages: MidasMessage[]) {
  const store = readStore();
  store[conversationKey(cia, scenarioId)] = messages.slice(-MAX_MESSAGES);
  writeStore(store);
}

export function clearConversation(cia: string, scenarioId: string) {
  const store = readStore();
  delete store[conversationKey(cia, scenarioId)];
  writeStore(store);
}
