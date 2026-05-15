import { Client, Provider } from '../domain/types';
import { loadClientsCatalog } from '../domain/loadClientsCatalog';
import { loadProvidersCatalog } from '../domain/loadProvidersCatalog';
import { apiConfig } from '../config/api.config';

function isInternalProxy(baseUrl: string): boolean {
  return /^\/(?!\/)/.test(baseUrl) || baseUrl === '';
}

async function fetchJson<T>(path: string): Promise<T | null> {
  if (!apiConfig.cognos.baseUrl) return null;
  const delegateAuthToProxy = isInternalProxy(apiConfig.cognos.baseUrl);

  try {
    const response = await fetch(`${apiConfig.cognos.baseUrl}${path}`, {
      headers: {
        ...(!delegateAuthToProxy && apiConfig.cognos.authValue
          ? { Authorization: ['Bearer', apiConfig.cognos.authValue].join(' ') }
          : {}),
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
  const live = await fetchJson<Client[]>('/reports/midas/clientes');
  return live ?? loadClientsCatalog();
}

export async function fetchProviderCatalog(): Promise<Provider[]> {
  const live = await fetchJson<Provider[]>('/reports/midas/proveedores');
  return live ?? loadProvidersCatalog();
}
