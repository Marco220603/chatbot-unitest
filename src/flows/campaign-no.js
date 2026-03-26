import { addKeyword, EVENTS } from '@builderbot/bot'
import { campainDataByNumber, resetIdleTimer, getProviderRef } from '../state/session.js'
import { registrarEnSheets } from '../services/google-sheets.js'

// Flow hijo: respuesta NO → pregunta si desea asesor y acumula mensajes con timer propio
export const campainNoFlow = addKeyword(EVENTS.ACTION)
    .addAction(async (ctx, { flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]
        if (!campainData) return

        // Inicializar acumulador de respuestas y fase
        campainData.responses = []
        campainData.phase = 'WAITING_ASESOR'

        await flowDynamic([
            'Gracias por su respuesta ❌',
            '',
            '¿Desea ser contactado por un asesor?',
            '1️⃣ Sí, deseo ser contactado',
            '2️⃣ No, gracias'
        ].join('\n'))
    })
    .addAnswer(null, { capture: true }, async (ctx, { fallBack }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]

        // Si ya se procesó (timer expiró y limpió datos), salir del capture
        if (!campainData || campainData.phase !== 'WAITING_ASESOR') return

        // Acumular el mensaje del cliente
        campainData.responses.push(ctx.body)
        console.log(`[CAMPAIN-NO] Mensaje acumulado de ${numberClean}: "${ctx.body}" (total: ${campainData.responses.length})`)

        // Reiniciar timer de inactividad
        resetIdleTimer(numberClean, async () => {
            const data = campainDataByNumber[numberClean]
            if (!data || data.phase !== 'WAITING_ASESOR') return

            const todasLasRespuestas = data.responses.join('\n').toLowerCase()
            let opcionTexto = todasLasRespuestas
            let mensajeDespedida = ''

            if (todasLasRespuestas.includes('1') || todasLasRespuestas.includes('sí') || todasLasRespuestas.includes('si')) {
                opcionTexto = 'Sí, desea ser contactado'
                mensajeDespedida = 'Entendido. Un asesor se comunicará contigo pronto. 📞'
            } else {
                opcionTexto = 'No desea ser contactado'
                mensajeDespedida = 'Entendido. ¡Gracias por su tiempo! 👋'
            }

            console.log(`[CAMPAIN-NO] Idle expirado para ${numberClean}. Opción: ${opcionTexto}`)

            // Registrar en Google Sheets
            await registrarEnSheets({
                type: 'RESPUESTA_NO',
                numero: data.numero,
                cliente: data.cliente,
                idCliente: data.idCliente,
                modelo: data.modelo,
                serie: data.serie,
                rrvv: data.rrvv,
                opcionContacto: opcionTexto,
                respuestaCompleta: data.responses.join('\n')
            })

            // Enviar despedida directamente por el provider
            try {
                const providerRef = getProviderRef()
                await providerRef.sendMessage(data.numero, mensajeDespedida, {})
                console.log(`[CAMPAIN-NO] Despedida enviada a ${data.numero}`)
            } catch (err) {
                console.error(`[CAMPAIN-NO] Error enviando despedida:`, err)
            }

            // Limpiar datos
            delete campainDataByNumber[numberClean]
        })

        // Seguir esperando más mensajes
        return fallBack()
    })
