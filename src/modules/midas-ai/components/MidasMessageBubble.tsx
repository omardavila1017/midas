import { AlertCircle } from 'lucide-react';
import { MidasAvatar } from './MidasAvatar';
import { ProposalSuggestionCard } from './ProposalSuggestionCard';
import type { MidasMessage, MidasProposalSuggestion } from '../types';

interface Props {
  message: MidasMessage;
  onAcceptProposal: (msgId: string, suggestion: MidasProposalSuggestion) => void;
  onDismissProposal: (msgId: string, suggestionId: string) => void;
}

export function MidasMessageBubble({ message, onAcceptProposal, onDismissProposal }: Props) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[var(--radius-lg)] rounded-br-sm bg-[var(--gray-950)] px-3 py-2 text-[13px] leading-relaxed text-white">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 shrink-0">
        <MidasAvatar size={28} />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="rounded-[var(--radius-lg)] rounded-tl-sm bg-[var(--gray-50)] px-3 py-2 text-[13px] leading-relaxed text-[var(--gray-900)]">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[#8C6618]">MIDAS</div>
          <div className="mt-0.5 whitespace-pre-wrap">{message.content}</div>
          {message.error && (
            <div className="mt-2 flex items-start gap-1.5 rounded bg-[var(--danger-muted,#FEE)] p-1.5 text-[11px] text-[var(--danger)]">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{message.error}</span>
            </div>
          )}
        </div>
        {message.proposals?.map((p) => (
          <ProposalSuggestionCard
            key={p.id}
            suggestion={p}
            onAccept={(s) => onAcceptProposal(message.id, s)}
            onDismiss={(id) => onDismissProposal(message.id, id)}
          />
        ))}
      </div>
    </div>
  );
}
