import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UsersDashboard from './UsersDashboard';
import { AuthProvider } from '../../../contexts/AuthContext';
import { ToastProvider } from '../../../components/Toast';
import { __resetAccessRegistryForTests, getManagedUser } from '../services/accessControlStore';

function renderAsAdmin() {
  return render(
    <ToastProvider>
      <AuthProvider email="admin@x.com" role="admin">
        <UsersDashboard />
      </AuthProvider>
    </ToastProvider>,
  );
}

describe('<UsersDashboard />', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAccessRegistryForTests();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('renders the registry header and registration form for an admin', () => {
    renderAsAdmin();
    expect(screen.getByText('Usuarios')).toBeTruthy();
    expect(screen.getByPlaceholderText('usuario@gruposenda.com')).toBeTruthy();
    expect(screen.getByText('Agregar')).toBeTruthy();
  });

  it('lists seeded users from the local auth source', () => {
    renderAsAdmin();
    expect(screen.getByText('agustin.blanco@gruposenda.com')).toBeTruthy();
  });

  it('registers a new user via the form', () => {
    renderAsAdmin();
    fireEvent.change(screen.getByPlaceholderText('usuario@gruposenda.com'), {
      target: { value: 'nuevo@gruposenda.com' },
    });
    fireEvent.click(screen.getByText('Agregar'));
    expect(getManagedUser('nuevo@gruposenda.com')?.role).toBe('user');
    expect(screen.getByText('nuevo@gruposenda.com')).toBeTruthy();
  });

  it('opens the set-password modal for a user from the admin (local mode)', () => {
    // El modo local está activo por el JSON embebido; el admin cambia
    // contraseñas directamente en vez de enviar liga.
    renderAsAdmin();
    fireEvent.click(screen.getByLabelText('Cambiar contraseña de agustin.blanco@gruposenda.com'));
    expect(screen.getByText(/Defines la contraseña de agustin\.blanco@gruposenda\.com/)).toBeTruthy();
  });
});
