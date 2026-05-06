interface Props {
  size?: number;
  pulse?: boolean;
}

export function MidasAvatar({ size = 36, pulse = false }: Props) {
  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: 'radial-gradient(circle at 30% 30%, #FFE89A 0%, #E5B441 55%, #8C6618 100%)',
          boxShadow: '0 0 0 1px rgba(140,102,24,0.35), 0 4px 12px rgba(229,180,65,0.35)',
        }}
      />
      <div
        className="absolute inset-[3px] rounded-full"
        style={{
          background: 'radial-gradient(circle at 35% 30%, #FFF6D3 0%, #F1C75D 60%, #B7861E 100%)',
        }}
      />
      <span
        className="relative font-bold text-[var(--gray-950)]"
        style={{ fontSize: size * 0.42, letterSpacing: '-0.04em' }}
      >
        M
      </span>
      {pulse && (
        <span
          className="absolute inset-0 rounded-full"
          style={{
            border: '2px solid #E5B441',
            animation: 'midasPulse 1.6s ease-out infinite',
          }}
        />
      )}
      <style>{`
        @keyframes midasPulse {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
