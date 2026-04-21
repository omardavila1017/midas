import { Client, Provider } from '../domain/types';
import { loadClientsCatalog } from '../domain/loadClientsCatalog';
import { loadProvidersCatalog } from '../domain/loadProvidersCatalog';
import { apiConfig } from '../config/api.config';

async function fetchJson<T>(path: string): Promise<T | null> {
  if (!apiConfig.cognos.baseUrl) return null;

  try {
    const response = await fetch(`${apiConfig.cognos.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${apiConfig.cognos.authValue}`,
        Accept: 'application/json',
        'X-Cognos-Namespace': apiConfig.cognos.namespace,
      },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchClientCatalog(): Promise<Client[]> {
  const live = await fetchJson<Client[]>('/reports/flowsense/clientes');
  return live ?? loadClientsCatalog();
}

export async function fetchProviderCatalog(): Promise<Provider[]> {
  const live = await fetchJson<Provider[]>('/reports/flowsense/proveedores');
  return live ?? loadProvidersCatalog();
}
