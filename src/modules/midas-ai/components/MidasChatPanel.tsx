import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Send, X } from 'lucide-react';
import { MidasAvatar } from './MidasAvatar';
import { MidasMessageBubble } from './MidasMessageBubble';
import { useMidasChat } from '../hooks/useMidasChat';
import { isOpenAIConfigured } from '../services/openaiClient';
import type { MidasContext, MidasProposalSuggestion } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  cia: string;
  scenarioId: string;
  buildContext: () => MidasContext;
  onAcceptProposal: (suggestion: MidasProposalSuggestion) => void;
}

const SUGGESTED_PROMPTS = [
  '¿Cómo mejoro la caja final del próximo mes?',
  'Identifica proveedores flexibles donde pueda postergar pagos sin riesgo.',
  'Propón 3 ajustes para reducir días en déficit.',
  '¿Qué movimientos del próximo mes son los de mayor impacto?',
];

export function MidasChatPanel({ open, onClose, cia, scenarioId, buildContext, onAcceptProposal }: Props) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { messages, pending, send, reset, removeProposalFromMessage } = useMidasChat({
    cia,
    scenarioId,
    buildContext,
  });
  const configured = isOpenAIConfigured();

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, [messages, open]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || pending) return;
    const value = input;
    setInput('');
    void send(value);
  };

  const handleAccept = (msgId: string, suggestion: MidasProposalSuggestion) => {
    onAcceptProposal(suggestion);
    removeProposalFromMessage(msgId, suggestion.id);
  };

  return (
    <div
      className="fixed bottom-[88px] right-5 z-[1000] flex h-[640px] w-[400px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white shadow-2xl"
      style={{ animation: 'midasPanelIn 180ms ease-out' }}
      role="dialog"
      aria-label="Asistente MIDAS"
    >
      <header className="flex items-center justify-between border-b border-[var(--gray-100)] bg-gradient-to-r from-[#FFFCF1] to-white px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <MidasAvatar size={32} />
          <div>
            <div className="text-[13px] font-bold text-[var(--gray-950)]">MIDAS</div>
            <div className="text-[10px] text-[var(--gray-500)]">Asistente financiero · Senda</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              if (confirm('¿Limpiar la conversación con MIDAS?')) reset();
            }}
            className="rounded p-1.5 text-[var(--gray-500)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-700)]"
            title="Reiniciar conversación"
            aria-label="Reiniciar conversación"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-[var(--gray-500)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-700)]"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!configured && (
          <div className="rounded-[var(--radius)] border border-[var(--warning,#E5B441)]/40 bg-[#FFFCF1] p-3 text-[12px] text-[var(--gray-800)]">
            <div className="font-bold text-[#8C6618]">MIDAS no configurado</div>
            <p className="mt-1">
              Falta <code className="rounded bg-white px-1">VITE_OPENAI_API_KEY</code> en el archivo{' '}
              <code className="rounded bg-white px-1">.env</code>. Reinicia el servidor después de configurarla.
            </p>
          </div>
        )}

        {configured && messages.length === 0 && (
          <div className="space-y-2.5">
            <div className="rounded-[var(--radius)] bg-[var(--gray-50)] p-3 text-[12px] leading-relaxed text-[var(--gray-700)]">
              <div className="font-bold text-[var(--gray-950)]">Hola, soy MIDAS.</div>
              <p className="mt-1">
                Conozco tu forecast actual, los proveedores críticos y los flexibles. Puedo proponer ajustes para
                mejorar tu caja final, justificados con números. Tú apruebas qué se queda como DRAFT.
              </p>
            </div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--gray-500)]">Sugerencias</div>
            <div className="space-y-1.5">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => void send(prompt)}
                  disabled={pending}
                  className="w-full rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 py-2 text-left text-[12px] leading-relaxed text-[var(--gray-700)] transition-colors hover:border-[#E5B441] hover:bg-[#FFFCF1] disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MidasMessageBubble
            key={m.id}
            message={m}
            onAcceptProposal={handleAccept}
            onDismissProposal={removeProposalFromMessage}
          />
        ))}

        {pending && (
          <div className="flex gap-2.5">
            <MidasAvatar size={28} pulse />
            <div className="flex items-center gap-1 rounded-[var(--radius-lg)] bg-[var(--gray-50)] px-3 py-2.5 text-[12px] text-[var(--gray-500)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#E5B441]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#E5B441]" style={{ animationDelay: '120ms' }} />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#E5B441]" style={{ animationDelay: '240ms' }} />
            </div>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-[var(--gray-100)] bg-white p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder={configured ? 'Pregunta a MIDAS...' : 'Configura VITE_OPENAI_API_KEY'}
            disabled={!configured || pending}
            rows={1}
            className="min-h-[36px] max-h-[120px] flex-1 resize-none rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 py-2 text-[13px] outline-none focus:border-[#E5B441] focus:ring-2 focus:ring-[#E5B441]/20 disabled:bg-[var(--gray-50)] disabled:text-[var(--gray-400)]"
          />
          <button
            type="submit"
            disabled={!configured || pending || !input.trim()}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-[var(--gray-950)] text-white transition-colors hover:bg-[var(--gray-800)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Enviar"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>

      <style>{`
        @keyframes midasPanelIn {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
