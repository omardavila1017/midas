import { afterEach, describe, expect, it } from 'vitest';
import { clearConversation, loadConversation, saveConversation } from './midasStorage';
import type { MidasMessage } from '../types';

const KEY = 'midas.midasAi.conversations.v1';

afterEach(() => localStorage.clear());

function msg(id: string): MidasMessage {
  return { id, role: 'user', content: `hola ${id}`, timestamp: '2026-03-01T00:00:00Z' };
}

describe('midasStorage', () => {
  it('roundtrips a conversation keyed by cia + scenario', () => {
    saveConversation('all', 'base', [msg('m1'), msg('m2')]);
    expect(loadConversation('all', 'base').map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(loadConversation('all', 'approved')).toEqual([]);
    expect(loadConversation('00150', 'base')).toEqual([]);
  });

  it('keeps only the last 50 messages per conversation', () => {
    const many = Array.from({ length: 60 }, (_, i) => msg(`m${i}`));
    saveConversation('all', 'base', many);
    const loaded = loadConversation('all', 'base');
    expect(loaded.length).toBe(50);
    expect(loaded[0].id).toBe('m10');
    expect(loaded[49].id).toBe('m59');
  });

  it('clearConversation removes only the targeted conversation', () => {
    saveConversation('all', 'base', [msg('keep-me-not')]);
    saveConversation('all', 'approved', [msg('keep-me')]);
    clearConversation('all', 'base');
    expect(loadConversation('all', 'base')).toEqual([]);
    expect(loadConversation('all', 'approved').map((m) => m.id)).toEqual(['keep-me']);
  });

  it('survives corrupt or non-object payloads', () => {
    localStorage.setItem(KEY, '{corrupt');
    expect(loadConversation('all', 'base')).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(null));
    expect(loadConversation('all', 'base')).toEqual([]);
    // Un payload corrupto no debe impedir escribir de nuevo
    saveConversation('all', 'base', [msg('fresh')]);
    expect(loadConversation('all', 'base').map((m) => m.id)).toEqual(['fresh']);
  });
});
