import { IDLE_TIMEOUT } from '../config/env.js'

// Almacén temporal para datos de campaña por número
export const campainDataByNumber = {}

// Almacén temporal para datos de recordatorio por número
export const recordatorioDataByNumber = {}

// Almacén de timers de inactividad por número
export const idleTimers = {}

// Referencia global al provider para enviar mensajes desde timers
let _providerRef = null

export const getProviderRef = () => _providerRef

export const setProviderRef = (provider) => {
    _providerRef = provider
}

/**
 * Inicia o reinicia el timer de inactividad para un número.
 * Cuando el timer expire (IDLE_TIMEOUT ms sin mensajes), ejecuta onExpire.
 */
export function resetIdleTimer(numberClean, onExpire) {
    if (idleTimers[numberClean]) {
        clearTimeout(idleTimers[numberClean])
    }
    idleTimers[numberClean] = setTimeout(async () => {
        delete idleTimers[numberClean]
        try {
            await onExpire()
        } catch (err) {
            console.error(`[IDLE] Error en onExpire para ${numberClean}:`, err)
        }
    }, IDLE_TIMEOUT)
}
