export interface PasswordPolicyCheck {
  id: 'length' | 'uppercase' | 'lowercase' | 'number' | 'symbol';
  label: string;
  passed: boolean;
}

export function getPasswordPolicyChecks(password: string): PasswordPolicyCheck[] {
  return [
    { id: 'length', label: '12 caracteres o más', passed: password.length >= 12 },
    { id: 'uppercase', label: 'Una mayúscula', passed: /[A-ZÁÉÍÓÚÑ]/.test(password) },
    { id: 'lowercase', label: 'Una minúscula', passed: /[a-záéíóúñ]/.test(password) },
    { id: 'number', label: 'Un número', passed: /\d/.test(password) },
    { id: 'symbol', label: 'Un símbolo', passed: /[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9\s]/.test(password) },
  ];
}

export function passwordMeetsPolicy(password: string): boolean {
  return getPasswordPolicyChecks(password).every((check) => check.passed);
}
