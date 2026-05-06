import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Provider } from '../../../domain/types';
import type { FinancialAdjustment, ForecastRun } from '../../shared-finance/types';
import { MidasAvatar } from './MidasAvatar';
import { MidasChatPanel } from './MidasChatPanel';
import { buildMidasContext } from '../services/midasContextBuilder';
import type { MidasProposalSuggestion } from '../types';

interface Props {
  cia: string;
  asOfDate: string;
  activeRun: ForecastRun;
  providers: Provider[];
  adjustments: FinancialAdjustment[];
  activeScenarioId: string;
  activeScenarioKind: string;
  onAcceptProposal: (suggestion: MidasProposalSuggestion) => void;
}

export function MidasBubble(props: Props) {
  const [open, setOpen] = useState(false);

  const buildContext = useMemo(
    () => () =>
      buildMidasContext({
        cia: props.cia,
        asOfDate: props.asOfDate,
        activeRun: props.activeRun,
        providers: props.providers,
        adjustments: props.adjustments,
        activeScenarioId: props.activeScenarioId,
        activeScenarioKind: props.activeScenarioKind,
      }),
    [
      props.cia,
      props.asOfDate,
      props.activeRun,
      props.providers,
      props.adjustments,
      props.activeScenarioId,
      props.activeScenarioKind,
    ],
  );

  return createPortal(
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="midas-bubble-btn group fixed bottom-6 right-6 z-[2147483646] inline-flex h-14 w-14 items-center justify-center rounded-full transition-transform hover:scale-105 active:scale-95"
        style={{
          background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 50%, #2563EB 100%)',
          boxShadow:
            '0 10px 30px -8px rgba(124,58,237,0.55), 0 4px 12px -2px rgba(37,99,235,0.45), 0 0 0 1px rgba(255,255,255,0.08) inset',
        }}
        aria-label={open ? 'Cerrar MIDAS' : 'Abrir MIDAS'}
        aria-expanded={open}
      >
        <span
          className="pointer-events-none absolute inset-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
          style={{
            background:
              'radial-gradient(60% 60% at 30% 25%, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 70%)',
          }}
        />
        <MidasAvatar size={42} />
        <style>{`
          .midas-bubble-btn::after {
            content: '';
            position: absolute;
            inset: -4px;
            border-radius: 9999px;
            background: linear-gradient(135deg, rgba(124,58,237,0.45), rgba(37,99,235,0.35));
            filter: blur(14px);
            z-index: -1;
            opacity: 0.7;
          }
        `}</style>
      </button>
      <MidasChatPanel
        open={open}
        onClose={() => setOpen(false)}
        cia={props.cia}
        scenarioId={props.activeScenarioId}
        buildContext={buildContext}
        onAcceptProposal={props.onAcceptProposal}
      />
    </>,
    document.body,
  );
}
