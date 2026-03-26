import { REGISTRAR_GASTO_URL } from '../config/urls.js'

export const registrarGastoEnAppsScript = async (payload) => {
    console.log('[APPS_SCRIPT][registrarGasto] intento_envio:', {
        endpoint: REGISTRAR_GASTO_URL,
        payloadKeys: Object.keys(payload ?? {}),
        base64Length: payload?.archivo_pdf_base64?.length ?? 0,
    })
    console.log('[APPS_SCRIPT][registrarGasto] payload:', payload)

    const response = await fetch(REGISTRAR_GASTO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })

    const rawText = await response.text()
    let body = null

    try {
        body = rawText ? JSON.parse(rawText) : null
    } catch {
        body = { raw: rawText }
    }

    console.log('[APPS_SCRIPT][registrarGasto] status:', response.status)
    console.log('[APPS_SCRIPT][registrarGasto] raw:', rawText)
    console.log('[APPS_SCRIPT][registrarGasto] body:', body)

    if (!response.ok) {
        throw new Error(`Apps Script registrarGasto fallo: HTTP ${response.status}`)
    }

    return body
}
