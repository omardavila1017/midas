import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PermissionsDashboard from './PermissionsDashboard';
import { AuthProvider } from '../../../contexts/AuthContext';
import { ToastProvider } from '../../../components/Toast';
import { __resetAccessRegistryForTests, getGrantedTabs } from '../services/accessControlStore';

function renderAsAdmin() {
  return render(
    <ToastProvider>
      <AuthProvider email="admin@x.com" role="admin">
        <PermissionsDashboard />
      </AuthProvider>
    </ToastProvider>,
  );
}

describe('<PermissionsDashboard />', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAccessRegistryForTests();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('renders the header and the seeded user list', () => {
    renderAsAdmin();
    expect(screen.getByText('Permisos')).toBeTruthy();
    expect(screen.getByText('blanca.reyes@gruposenda.com')).toBeTruthy();
  });

  it('shows the full-access note when an admin user is selected', () => {
    renderAsAdmin();
    // El primer usuario (orden alfabético) es agustin.blanco, admin.
    expect(screen.getByText(/acceso total/i)).toBeTruthy();
  });

  it('shows permission switches and toggles one for a user-role account', () => {
    renderAsAdmin();
    // Selecciona un usuario con rol "user" (blanca.reyes, sembrado desde legacy).
    fireEvent.click(screen.getByText('blanca.reyes@gruposenda.com'));
    expect(screen.getByText('Ingresos')).toBeTruthy();
    const before = getGrantedTabs('blanca.reyes@gruposenda.com').includes('taxes');
    const toggle = screen.getByLabelText('Acceso a Impuestos');
    fireEvent.click(toggle);
    expect(getGrantedTabs('blanca.reyes@gruposenda.com').includes('taxes')).toBe(!before);
  });
});
