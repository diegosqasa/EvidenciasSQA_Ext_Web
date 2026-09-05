/**
 * Evidencias SQA — background/auth.js
 * Autenticación con la app de escritorio mediante token X-SQA-Token.
 */

const TOKEN_CACHE_KEY = 'sqaHttpToken';
const TOKEN_EXPIRY_KEY = 'sqaHttpTokenExpiry';
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Obtiene el token de autenticación desde la app de escritorio.
 * Usa caché en chrome.storage.local con TTL de 5 minutos.
 */
export async function getSqaHttpToken() {
    try {
        // Verificar caché en memoria primero (más rápido)
        const cached = getCachedToken();
        if (cached) {
            return cached;
        }

        // Verificar chrome.storage.local
        const stored = await chrome.storage.local.get([TOKEN_CACHE_KEY, TOKEN_EXPIRY_KEY]);
        const now = Date.now();
        if (stored[TOKEN_CACHE_KEY] && stored[TOKEN_EXPIRY_KEY] && stored[TOKEN_EXPIRY_KEY] > now) {
            // Token válido en almacenamiento
            return stored[TOKEN_CACHE_KEY];
        }

        // Obtener nuevo token desde la app de escritorio
        const response = await fetch('http://127.0.0.1:3000/api/token', {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
            // No enviar credenciales ni cookies - solo token
        });

        if (!response.ok) {
            throw new Error(`Token request failed: ${response.status}`);
        }

        const data = await response.json();
        const token = data?.token;
        if (!token) {
            throw new Error('Token no encontrado en respuesta');
        }

        // Guardar en caché con expiración
        const expiry = now + TOKEN_TTL_MS;
        await chrome.storage.local.set({
            [TOKEN_CACHE_KEY]: token,
            [TOKEN_EXPIRY_KEY]: expiry
        });

        return token;
    } catch (error) {
        console.warn('[SQA-AUTH] No se pudo obtener token, continuando sin autenticación:', error.message);
        return null;
    }
}

// Caché en memoria simple
let memoryToken = null;
let memoryTokenExpiry = 0;

function getCachedToken() {
    const now = Date.now();
    if (memoryToken && memoryTokenExpiry > now) {
        return memoryToken;
    }
    return null;
}

function setCachedToken(token) {
    memoryToken = token;
    memoryTokenExpiry = Date.now() + TOKEN_TTL_MS;
}

/**
 * Construye los headers de autenticación para las peticiones a la API.
 * Incluye X-SQA-Token si está disponible.
 * Reintenta una vez si el token no está disponible inicialmente.
 */
export async function getAuthHeaders(extraHeaders = {}) {
    let token = await getSqaHttpToken();
    
    // Si no hay token, forzar una nueva obtención (puede que la app se haya iniciado después)
    if (!token) {
        console.debug('[SQA-AUTH] Token no disponible, forzando refresh...');
        await invalidateToken();
        token = await getSqaHttpToken();
    }
    
    const headers = {
        ...extraHeaders,
    };
    if (token) {
        headers['X-SQA-Token'] = token;
    }
    return headers;
}

/**
 * Invalida el token en caché (útil si la app de escritorio se reinicia).
 */
export async function invalidateToken() {
    memoryToken = null;
    memoryTokenExpiry = 0;
    await chrome.storage.local.remove([TOKEN_CACHE_KEY, TOKEN_EXPIRY_KEY]);
}