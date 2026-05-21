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
          background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 50%, #2563EB 100%)',
          boxShadow: '0 0 0 1px rgba(79,70,229,0.35), 0 4px 12px rgba(124,58,237,0.35)',
        }}
      />
      <div
        className="absolute inset-[3px] rounded-full"
        style={{
          background: 'linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%)',
        }}
      />
      <span
        className="relative font-bold text-white"
        style={{ fontSize: size * 0.42, letterSpacing: '-0.04em' }}
      >
        M
      </span>
      {pulse && (
        <span
          className="absolute inset-0 rounded-full"
          style={{
            border: '2px solid #8B5CF6',
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
