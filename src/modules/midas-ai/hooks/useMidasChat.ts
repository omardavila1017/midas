import { useCallback, useEffect, useRef, useState } from 'react';
import { callOpenAI, type OpenAITurn } from '../services/openaiClient';
import { buildContextBlock, MIDAS_SYSTEM_PROMPT } from '../services/midasPromptTemplates';
import { parseProposal } from '../services/proposalParser';
import { loadConversation, saveConversation, clearConversation } from '../services/midasStorage';
import type { MidasContext, MidasMessage, MidasProposalSuggestion } from '../types';

interface UseMidasChatArgs {
  cia: string;
  scenarioId: string;
  buildContext: () => MidasContext;
}

export function useMidasChat({ cia, scenarioId, buildContext }: UseMidasChatArgs) {
  const [messages, setMessages] = useState<MidasMessage[]>(() => loadConversation(cia, scenarioId));
  const [pending, setPending] = useState(false);
  const persistTimer = useRef<number | null>(null);

  // Reload on cia/scenario change
  useEffect(() => {
    setMessages(loadConversation(cia, scenarioId));
  }, [cia, scenarioId]);

  // Idle persistence (~2.5s after last update)
  useEffect(() => {
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      saveConversation(cia, scenarioId, messages);
    }, 2500);
    return () => {
      if (persistTimer.current) window.clearTimeout(persistTimer.current);
    };
  }, [messages, cia, scenarioId]);

  const send = useCallback(
    async (userText: string) => {
      const trimmed = userText.trim();
      if (!trimmed || pending) return;

      const ctx = buildContext();
      const contextBlock = buildContextBlock(ctx);

      const userMsg: MidasMessage = {
        id: `m-${Date.now()}-u`,
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
      };

      const updatedHistory = [...messages, userMsg];
      setMessages(updatedHistory);
      setPending(true);

      try {
        const turns: OpenAITurn[] = [
          { role: 'user', content: contextBlock },
          { role: 'assistant', content: 'Contexto recibido. Listo para asistir.' },
          ...updatedHistory.map<OpenAITurn>((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
          })),
        ];

        const res = await callOpenAI({ systemPrompt: MIDAS_SYSTEM_PROMPT, history: turns });

        const proposals: MidasProposalSuggestion[] = [];
        const parseErrors: string[] = [];
        for (const fc of res.functionCalls) {
          if (fc.name !== 'propose_adjustment') continue;
          const parsed = parseProposal(fc.args);
          if (parsed.ok) proposals.push(parsed.suggestion);
          else parseErrors.push(parsed.reason);
        }

        const replyText = res.text || (proposals.length > 0 ? `Te sugiero ${proposals.length} ajuste(s).` : '...');
        const midasMsg: MidasMessage = {
          id: `m-${Date.now()}-a`,
          role: 'midas',
          content: replyText,
          proposals: proposals.length > 0 ? proposals : undefined,
          timestamp: new Date().toISOString(),
          error: parseErrors.length > 0 ? `Descarté ${parseErrors.length} propuesta(s) inválida(s).` : undefined,
        };
        setMessages((prev) => [...prev, midasMsg]);
      } catch (err) {
        const errorMsg: MidasMessage = {
          id: `m-${Date.now()}-e`,
          role: 'midas',
          content: 'No pude completar la consulta.',
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      } finally {
        setPending(false);
      }
    },
    [messages, pending, buildContext],
  );

  const reset = useCallback(() => {
    setMessages([]);
    clearConversation(cia, scenarioId);
  }, [cia, scenarioId]);

  const removeProposalFromMessage = useCallback((messageId: string, proposalId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId && m.proposals
          ? { ...m, proposals: m.proposals.filter((p) => p.id !== proposalId) }
          : m,
      ),
    );
  }, []);

  return { messages, pending, send, reset, removeProposalFromMessage };
}
