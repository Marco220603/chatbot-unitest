import { addKeyword, EVENTS } from '@builderbot/bot'
import { recordatorioDataByNumber, resetIdleTimer, getProviderRef } from '../state/session.js'
import { registrarEnSheets } from '../services/google-sheets.js'

// Flow hijo: "Tengo una consulta" → captura mensajes con idle timer
export const recordatorioConsultaFlow = addKeyword(EVENTS.ACTION)
    .addAction(async (ctx, { flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const recData = recordatorioDataByNumber[numberClean]
        if (!recData) return

        recData.responses = []
        recData.phase = 'WAITING_CONSULTA'

        await flowDynamic('📝 Por favor, cuéntanos tu consulta:')
    })
    .addAnswer(null, { capture: true }, async (ctx, { fallBack }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const recData = recordatorioDataByNumber[numberClean]

        if (!recData || recData.phase !== 'WAITING_CONSULTA') return

        recData.responses.push(ctx.body)
        console.log(`[RECORDATORIO-CONSULTA] Mensaje acumulado de ${numberClean}: "${ctx.body}" (total: ${recData.responses.length})`)

        resetIdleTimer(numberClean, async () => {
            const data = recordatorioDataByNumber[numberClean]
            if (!data || data.phase !== 'WAITING_CONSULTA') return

            const todasLasRespuestas = data.responses.join('\n')
            console.log(`[RECORDATORIO-CONSULTA] Idle expirado para ${numberClean}. Consulta: "${todasLasRespuestas}"`)

            await registrarEnSheets({
                type: 'RESPUESTA_SI',
                numero: data.numero,
                cliente: data.cliente || '',
                idCliente: data.idCliente || '',
                modelo: '',
                serie: '',
                rrvv: data.rrvv || '',
                respuestaPregunta: todasLasRespuestas,
                detalle: `Recordatorio Servicio - Consulta`
            })

            try {
                const providerRef = getProviderRef()
                await providerRef.sendMessage(data.numero, '¡Gracias por tu consulta! Un asesor se comunicará contigo pronto. 📞', {})
                console.log(`[RECORDATORIO-CONSULTA] Despedida enviada a ${data.numero}`)
            } catch (err) {
                console.error(`[RECORDATORIO-CONSULTA] Error enviando despedida:`, err)
            }

            delete recordatorioDataByNumber[numberClean]
        })

        return fallBack()
    })
