import { addKeyword, EVENTS } from '@builderbot/bot'
import { campainDataByNumber, resetIdleTimer, getProviderRef } from '../state/session.js'
import { registrarEnSheets } from '../services/google-sheets.js'

// Flow hijo: respuesta SÍ → pide ubicación/fecha y acumula mensajes con timer propio
export const campainSiFlow = addKeyword(EVENTS.ACTION)
    .addAction(async (ctx, { flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]
        if (!campainData) return

        // Inicializar acumulador de respuestas y fase
        campainData.responses = []
        campainData.phase = 'WAITING_UBICACION'

        await flowDynamic('Gracias por su respuesta ✅\n\n📍 ¿Podrías indicarnos la *ubicación y fecha del equipo*?')
    })
    .addAnswer(null, { capture: true }, async (ctx, { fallBack }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]

        // Si ya se procesó (timer expiró y limpió datos), salir del capture
        if (!campainData || campainData.phase !== 'WAITING_UBICACION') return

        // Acumular el mensaje del cliente
        campainData.responses.push(ctx.body)
        console.log(`[CAMPAIN-SI] Mensaje acumulado de ${numberClean}: "${ctx.body}" (total: ${campainData.responses.length})`)

        // Reiniciar timer de inactividad
        resetIdleTimer(numberClean, async () => {
            const data = campainDataByNumber[numberClean]
            if (!data || data.phase !== 'WAITING_UBICACION') return

            const todasLasRespuestas = data.responses.join('\n')
            console.log(`[CAMPAIN-SI] Idle expirado para ${numberClean}. Respuestas: "${todasLasRespuestas}"`)

            // Registrar en Google Sheets
            await registrarEnSheets({
                type: 'RESPUESTA_SI',
                numero: data.numero,
                cliente: data.cliente,
                idCliente: data.idCliente,
                modelo: data.modelo,
                serie: data.serie,
                rrvv: data.rrvv,
                respuestaPregunta: todasLasRespuestas
            })

            // Enviar despedida directamente por el provider
            try {
                const providerRef = getProviderRef()
                await providerRef.sendMessage(data.numero, '¡Gracias! Su información ha sido registrada correctamente. Un asesor se comunicará contigo pronto. 👋', {})
                console.log(`[CAMPAIN-SI] Despedida enviada a ${data.numero}`)
            } catch (err) {
                console.error(`[CAMPAIN-SI] Error enviando despedida:`, err)
            }

            // Limpiar datos
            delete campainDataByNumber[numberClean]
        })

        // Seguir esperando más mensajes
        return fallBack()
    })
