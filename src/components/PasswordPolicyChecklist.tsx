import { CheckCircle2, Circle } from 'lucide-react';
import { getPasswordPolicyChecks } from '../services/passwordPolicy';

interface PasswordPolicyChecklistProps {
  password: string;
}

export default function PasswordPolicyChecklist({ password }: PasswordPolicyChecklistProps) {
  const checks = getPasswordPolicyChecks(password);
  return (
    <ul className="grid gap-1.5 text-[12px]" aria-label="Política de contraseña">
      {checks.map((check) => {
        const Icon = check.passed ? CheckCircle2 : Circle;
        return (
          <li
            key={check.id}
            className="flex items-center gap-2"
            style={{ color: check.passed ? 'var(--success)' : 'var(--gray-500)' }}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
            <span>{check.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
