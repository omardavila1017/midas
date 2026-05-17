import { Client, Provider } from '../domain/types';
import { loadClientsCatalog } from '../domain/loadClientsCatalog';
import { loadProvidersCatalog } from '../domain/loadProvidersCatalog';

// Clientes y proveedores no tienen API propia: son catálogos derivados de
// otras fuentes (bundled JSON + plantillas). No se hace fetch a un endpoint
// dedicado — hacerlo solo generaba requests 404 ruidosas en la red.

export async function fetchClientCatalog(): Promise<Client[]> {
  return loadClientsCatalog();
}

export async function fetchProviderCatalog(): Promise<Provider[]> {
  return loadProvidersCatalog();
}
