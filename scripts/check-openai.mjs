#!/usr/bin/env node
/**
 * Smoke-test de la integración MIDAS AI ↔ OpenAI.
 *
 * Verifica, paso a paso y con diagnóstico accionable:
 *   1. Credencial (OPENAI_API_KEY) y upstream (OPENAI_UPSTREAM) → GET /models.
 *   2. El modelo configurado (VITE_OPENAI_MODEL) → POST /chat/completions con
 *      el mismo shape (tools incluidos) que usa el cliente del browser.
 *   3. Opcional: la cadena completa browser→proxy con --proxy:
 *      node scripts/check-openai.mjs --proxy http://localhost:5173
 *
 * Lee OPENAI_API_KEY / OPENAI_UPSTREAM / VITE_OPENAI_MODEL del entorno o de
 * .env.local / .env (sin dependencias).
 *
 * Uso:  npm run ai:check  [-- --proxy http://localhost:5173]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const fileEnv = { ...loadDotEnv(resolve('.env')), ...loadDotEnv(resolve('.env.local')) };
const env = (k) => process.env[k] ?? fileEnv[k];

const upstream = (env('OPENAI_UPSTREAM') || 'https://api.openai.com/v1').replace(/\/+$/, '');
const apiKey = env('OPENAI_API_KEY');
const model = env('VITE_OPENAI_MODEL') || 'gpt-4o-mini';
const proxyArgIdx = process.argv.indexOf('--proxy');
const proxyBase = proxyArgIdx >= 0 ? (process.argv[proxyArgIdx + 1] || 'http://localhost:5173').replace(/\/+$/, '') : null;

const isPlaceholder = apiKey && /^<.*>$/.test(apiKey);
let failures = 0;

function ok(msg) { console.log(`  ✔ ${msg}`); }
function fail(msg) { failures += 1; console.error(`  ✘ ${msg}`); }

function diagnose(status, bodyText) {
  let parsed = {};
  try { parsed = JSON.parse(bodyText); } catch { /* HTML / texto plano */ }
  const errMsg = parsed?.error?.message ?? '';
  const errCode = parsed?.error?.code ?? '';
  if (status === 404 && !errMsg) {
    return 'la ruta no existe en ese host (proxy /api/openai sin configurar, o path equivocado). El body no es JSON de OpenAI.';
  }
  if (status === 404 && (errCode === 'model_not_found' || /model/i.test(errMsg))) {
    return `el modelo "${model}" no existe o la key no tiene acceso: ${errMsg}`;
  }
  if (status === 404 && /invalid url/i.test(errMsg)) {
    return `OPENAI_UPSTREAM mal configurado (falta /v1): ${errMsg}`;
  }
  if (status === 401) return `API key rechazada: ${errMsg || 'revisa OPENAI_API_KEY'}`;
  if (status === 429) return `cuota/límite: ${errMsg}`;
  return errMsg || bodyText.slice(0, 200);
}

console.log('— MIDAS AI · smoke test de conexión OpenAI —');
console.log(`  upstream: ${upstream}`);
console.log(`  modelo:   ${model}`);
console.log(`  key:      ${apiKey ? (isPlaceholder ? 'PLACEHOLDER (<...>) — inválida' : `${apiKey.slice(0, 7)}…`) : 'NO CONFIGURADA'}`);
console.log('');

if (!apiKey || isPlaceholder) {
  fail('OPENAI_API_KEY no está configurada (o sigue siendo el placeholder de .env.example). Sin ella el proxy responde 401/500.');
}

// Paso 1: credencial + upstream
if (apiKey && !isPlaceholder) {
  try {
    const res = await fetch(`${upstream}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
    const body = await res.text();
    if (res.ok) ok(`GET ${upstream}/models → ${res.status} (credencial y upstream correctos)`);
    else fail(`GET ${upstream}/models → ${res.status}: ${diagnose(res.status, body)}`);
  } catch (e) {
    fail(`GET ${upstream}/models inalcanzable: ${e.message}`);
  }

  // Paso 2: modelo + chat/completions (mismo shape que openaiClient.ts)
  try {
    const res = await fetch(`${upstream}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Responde en español de México, una sola palabra.' },
          { role: 'user', content: 'Di "conectado".' },
        ],
        max_tokens: 10,
      }),
    });
    const body = await res.text();
    if (res.ok) {
      const text = JSON.parse(body)?.choices?.[0]?.message?.content ?? '';
      ok(`POST ${upstream}/chat/completions (model=${model}) → ${res.status} · respuesta: "${text.trim()}"`);
    } else {
      fail(`POST ${upstream}/chat/completions → ${res.status}: ${diagnose(res.status, body)}`);
    }
  } catch (e) {
    fail(`POST ${upstream}/chat/completions inalcanzable: ${e.message}`);
  }
}

// Paso 3 (opcional): cadena completa vía proxy local (sin Authorization,
// igual que el browser).
if (proxyBase) {
  try {
    const res = await fetch(`${proxyBase}/api/openai/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Di "proxy ok".' }],
        max_tokens: 10,
      }),
    });
    const body = await res.text();
    if (res.ok) ok(`POST ${proxyBase}/api/openai/chat/completions → ${res.status} (proxy inyecta la key correctamente)`);
    else fail(`POST ${proxyBase}/api/openai/chat/completions → ${res.status}: ${diagnose(res.status, body)}`);
  } catch (e) {
    fail(`proxy ${proxyBase} inalcanzable: ${e.message} (¿está corriendo npm run dev?)`);
  }
}

console.log('');
if (failures === 0) {
  console.log('✔ Conexión OpenAI verificada de extremo a extremo.');
} else {
  console.error(`✘ ${failures} verificación(es) fallaron — ver diagnóstico arriba.`);
  process.exit(1);
}
