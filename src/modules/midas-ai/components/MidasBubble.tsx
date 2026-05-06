import { useMemo, useState } from 'react';
import type { Provider } from '../../../domain/types';
import { createFinancialAdjustment } from '../../financial-planning/services/financialPlanningService';
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
  isBaseScenario: boolean;
  onCreateAdjustment: (adjustment: FinancialAdjustment) => void;
  onSuggestSwitchScenario?: () => void;
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

  const handleAccept = (suggestion: MidasProposalSuggestion) => {
    if (props.isBaseScenario) {
      alert(
        'No puedo aplicar propuestas en el escenario Base (es de solo lectura). Cambia a un borrador o crea uno nuevo y vuelve a aceptar la propuesta.',
      );
      props.onSuggestSwitchScenario?.();
      return;
    }
    try {
      const adjustment = createFinancialAdjustment({
        name: suggestion.draft.name,
        scenarioIds: [props.activeScenarioId],
        type: suggestion.draft.type,
        targetType: suggestion.draft.targetType,
        targetExpression: suggestion.draft.targetExpression,
        reasonCode: suggestion.draft.reasonCode,
        justification: suggestion.draft.justification,
        deltaAmount: suggestion.draft.deltaAmount,
        deltaDays: suggestion.draft.deltaDays,
        percentageChange: suggestion.draft.percentageChange,
        adjustedValue: suggestion.draft.adjustedValue,
        createdBy: 'midas@senda.local',
      });
      const withImpact: FinancialAdjustment = {
        ...adjustment,
        impactSummary: {
          cashImpact: suggestion.estimatedCashImpact,
          deficitDaysReduced: 0,
          riskChange: 0,
        },
      };
      props.onCreateAdjustment(withImpact);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'No se pudo crear la propuesta.');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-5 right-5 z-[999] inline-flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-105 active:scale-95"
        style={{
          background: 'radial-gradient(circle at 30% 30%, #FFE89A 0%, #E5B441 60%, #8C6618 100%)',
          boxShadow: '0 8px 24px rgba(229,180,65,0.45), 0 0 0 1px rgba(140,102,24,0.4)',
        }}
        aria-label={open ? 'Cerrar MIDAS' : 'Abrir MIDAS'}
        aria-expanded={open}
      >
        <MidasAvatar size={42} />
      </button>
      <MidasChatPanel
        open={open}
        onClose={() => setOpen(false)}
        cia={props.cia}
        scenarioId={props.activeScenarioId}
        buildContext={buildContext}
        onAcceptProposal={handleAccept}
      />
    </>
  );
}
