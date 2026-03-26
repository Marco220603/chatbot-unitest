import { sendTemplateWithFallback } from '../services/meta-messaging.js'
import { NUMERO_TEST_INFORME } from '../flows/informe-response.js'

// Endpoints: /v1/informe/recordatorio, /v1/informe/alerta36h, /v1/informe/alerta48h, /v1/informe/alertas
export function registerInformeRoutes(adapterProvider, handleCtx) {

    // Caso 1: Recordatorio 24h → 3 botones
    adapterProvider.server.post(
        '/v1/informe/recordatorio',
        handleCtx(async (bot, req, res) => {
            try {
                const { modelo_serie, fecha } = req.body || {}
                const ms = modelo_serie || 'CAT 320F / SN12345'
                const f = fecha || '28/02/2026'

                const texto = [
                    `Hola 👷‍♂️,`,
                    `Te recordamos que tienes pendiente el envío del informe del equipo *${ms}*, intervenido el *${f}*.`,
                    ``,
                    `⏳ *Plazo máximo:* 48 horas.`,
                    ``,
                    `Por favor confirmar tu situación:`,
                ].join('\n')

                const buttons = [
                    { body: 'Ya lo envié' },
                    { body: 'En proceso' },
                    { body: 'Inconveniente' }
                ]

                const result = await adapterProvider.sendButtons(NUMERO_TEST_INFORME, buttons, texto)
                if (result instanceof Error) throw result
                if (result?.error) throw new Error(result.error.message || JSON.stringify(result.error))

                console.log(`[INFORME] Recordatorio 24h enviado a ${NUMERO_TEST_INFORME}`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'enviado', tipo: 'recordatorio_24h', numero: NUMERO_TEST_INFORME }))
            } catch (error) {
                console.error('[INFORME] Error recordatorio:', error.message)
                const detail = error?.response?.data || error
                console.error('[INFORME] Detalle:', JSON.stringify(detail, null, 2))
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // Caso 2: Alerta 36h → 2 botones
    adapterProvider.server.post(
        '/v1/informe/alerta36h',
        handleCtx(async (bot, req, res) => {
            try {
                const { modelo_serie } = req.body || {}
                const ms = modelo_serie || 'CAT 320F / SN12345'

                const texto = [
                    `⚠️ *MENSAJE AUTOMÁTICO – 36 HORAS*`,
                    ``,
                    `Hola 👷‍♂️,`,
                    `El informe del equipo *${ms}* aún no figura como enviado.`,
                    ``,
                    `⚠️ Recuerda que el *plazo máximo es 48 horas*.`,
                    ``,
                    `Por favor regularizar hoy y confirmar envío.`,
                ].join('\n')

                const buttons = [
                    { body: 'Ya lo envié' },
                    { body: 'En proceso' }
                ]

                const result = await adapterProvider.sendButtons(NUMERO_TEST_INFORME, buttons, texto)
                if (result instanceof Error) throw result
                if (result?.error) throw new Error(result.error.message || JSON.stringify(result.error))

                console.log(`[INFORME] Alerta 36h enviada a ${NUMERO_TEST_INFORME}`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'enviado', tipo: 'alerta_36h', numero: NUMERO_TEST_INFORME }))
            } catch (error) {
                console.error('[INFORME] Error alerta 36h:', error.message)
                const detail = error?.response?.data || error
                console.error('[INFORME] Detalle:', JSON.stringify(detail, null, 2))
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // Caso 3: Alerta 48h (CRÍTICA) → 2 botones
    adapterProvider.server.post(
        '/v1/informe/alerta48h',
        handleCtx(async (bot, req, res) => {
            try {
                const { modelo_serie } = req.body || {}
                const ms = modelo_serie || 'CAT 320F / SN12345'

                const texto = [
                    `🚨 *MENSAJE AUTOMÁTICO – 48 HORAS (ALERTA)*`,
                    ``,
                    `Hola 👷‍♂️,`,
                    `El informe del equipo *${ms}* ha superado el plazo establecido de *48 horas*.`,
                    ``,
                    `Se requiere *envío inmediato* y justificación del retraso.`,
                    ``,
                    `Por favor regularizar a la brevedad.`,
                ].join('\n')

                const buttons = [
                    { body: 'Ya regularicé' },
                    { body: 'Justificación' }
                ]

                const result = await adapterProvider.sendButtons(NUMERO_TEST_INFORME, buttons, texto)
                if (result instanceof Error) throw result
                if (result?.error) throw new Error(result.error.message || JSON.stringify(result.error))

                console.log(`[INFORME] Alerta 48h enviada a ${NUMERO_TEST_INFORME}`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'enviado', tipo: 'alerta_48h', numero: NUMERO_TEST_INFORME }))
            } catch (error) {
                console.error('[INFORME] Error alerta 48h:', error.message)
                const detail = error?.response?.data || error
                console.error('[INFORME] Detalle:', JSON.stringify(detail, null, 2))
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // Endpoint de alertas de informe (desde GAS)
    adapterProvider.server.post(
        '/v1/informe/alertas',
        handleCtx(async (bot, req, res) => {
            try {
                const { telefono, datos } = req.body || {}

                if (!telefono || !Array.isArray(datos) || datos.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ status: 'error', message: 'Se requiere telefono y datos[]' }))
                }

                const numberClean = telefono.replace('+', '').replace(/\s/g, '')

                // Agrupar datos por tipo de Alerta
                const grupos = {}
                for (const item of datos) {
                    const alerta = (item.Alerta || '').trim().toLowerCase()
                    if (!grupos[alerta]) {
                        grupos[alerta] = { tecnico: item.Tecnico, items: [] }
                    }
                    grupos[alerta].items.push({ modelo: item.Modelo, serie: item.Serie })
                }

                // Mapeo alerta -> templates candidatos en Meta
                const templateMap = {
                    '24h': ['alerta', 'alerta_24h', 'recordatorio_24h'],
                    '36h': ['alerta_36h'],
                    '48h': ['alerta_48h'],
                }
                const languageCandidates = ['es_PE', 'es', 'es_ES']

                const resultados = []

                for (const [alerta, grupo] of Object.entries(grupos)) {
                    const templateCandidates = templateMap[alerta]
                    if (!templateCandidates?.length) {
                        // Ignorar alertas sin template (ej: '0h' de nuevos ingresos)
                        console.log(`[INFORME-ALERTA] Alerta '${alerta}' ignorada (sin template asignado)`)
                        resultados.push({ alerta, status: 'ignorado', message: `Alerta '${alerta}' sin template` })
                        continue
                    }

                    const tecnico = grupo.tecnico || 'Técnico'

                    // alerta_36h tiene 3 params: {{1}}=tecnico, {{2}}=modelo, {{3}}=serie
                    if (alerta === '36h') {
                        const items = grupo.items
                        const allButLast = items.slice(0, -1)
                        const last = items[items.length - 1]
                        const prefix = allButLast.map(e => `${e.modelo}-${e.serie}`).join(', ')
                        const param2 = prefix ? `${prefix}, ${last.modelo}` : last.modelo
                        const param3 = last.serie

                        const components = [
                            {
                                type: 'body',
                                parameters: [
                                    { type: 'text', text: String(tecnico) },
                                    { type: 'text', text: String(param2) },
                                    { type: 'text', text: String(param3) },
                                ]
                            }
                        ]

                        const equiposLog = items.map(e => `${e.modelo}-${e.serie}`).join(', ')
                        try {
                            const sent = await sendTemplateWithFallback({
                                adapterProvider,
                                numberClean,
                                templateCandidates,
                                languageCandidates,
                                components,
                            })

                            console.log(`[INFORME-ALERTA] Template '${sent.templateName}' (${sent.language}) enviado a ${numberClean} (equipos: ${equiposLog})`)
                            resultados.push({ alerta, templateName: sent.templateName, language: sent.language, status: 'enviado', equipos: equiposLog })
                        } catch (err) {
                            console.error(`[INFORME-ALERTA] Error enviando candidatos '${templateCandidates.join(', ')}' a ${numberClean}:`, err.message)
                            resultados.push({ alerta, templateCandidates, status: 'error', equipos: equiposLog, message: err.message, tried: err?.tried ?? [] })
                        }
                        continue
                    }

                    // alerta (24h) y alerta_48h tienen 2 params: {{1}}=tecnico, {{2}}=equipos concatenados
                    const equiposStr = grupo.items.map(e => `${e.modelo}-${e.serie}`).join(', ')

                    const components = [
                        {
                            type: 'body',
                            parameters: [
                                { type: 'text', text: String(tecnico) },
                                { type: 'text', text: String(equiposStr) },
                            ]
                        }
                    ]

                    try {
                        const sent = await sendTemplateWithFallback({
                            adapterProvider,
                            numberClean,
                            templateCandidates,
                            languageCandidates,
                            components,
                        })

                        console.log(`[INFORME-ALERTA] Template '${sent.templateName}' (${sent.language}) enviado a ${numberClean} (equipos: ${equiposStr})`)
                        resultados.push({ alerta, templateName: sent.templateName, language: sent.language, status: 'enviado', equipos: equiposStr })
                    } catch (err) {
                        console.error(`[INFORME-ALERTA] Error enviando candidatos '${templateCandidates.join(', ')}' a ${numberClean}:`, err.message)
                        resultados.push({ alerta, templateCandidates, status: 'error', message: err.message, tried: err?.tried ?? [] })
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'ok', numero: numberClean, resultados }))
            } catch (error) {
                console.error('[INFORME-ALERTA] Error general:', error.message)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )
}
