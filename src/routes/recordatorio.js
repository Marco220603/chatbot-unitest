import { recordatorioDataByNumber } from '../state/session.js'

// Endpoint: /v1/recordatorio/servicio
export function registerRecordatorioRoutes(adapterProvider, handleCtx) {
    adapterProvider.server.post(
        '/v1/recordatorio/servicio',
        handleCtx(async (bot, req, res) => {
            try {
                const { telefono, cliente, idCliente, rrvv } = req.body || {}

                if (!telefono) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ status: 'error', message: 'Se requiere telefono' }))
                }

                const numberClean = telefono.replace('+', '').replace(/\s/g, '')

                // Enviar template sin parámetros
                const components = []
                const templateResult = await adapterProvider.sendTemplate(numberClean, 'recordatorio_servicio', 'es_ES', components)

                if (templateResult instanceof Error) {
                    const detail = templateResult?.response?.data?.error
                    if (detail) {
                        const err = new Error(detail.message || JSON.stringify(detail))
                        err.response = templateResult.response
                        throw err
                    }
                    throw templateResult
                }
                if (templateResult?.error) {
                    throw new Error(templateResult.error.message || JSON.stringify(templateResult.error))
                }

                console.log(`[RECORDATORIO] Template 'recordatorio_servicio' enviado a ${numberClean}`, JSON.stringify(templateResult))

                // Guardar datos para los flows de respuesta
                recordatorioDataByNumber[numberClean] = {
                    numero: numberClean,
                    cliente: cliente || '',
                    idCliente: idCliente || '',
                    rrvv: rrvv || '',
                    fecha: new Date().toISOString()
                }

                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'enviado', numero: numberClean }))
            } catch (error) {
                console.error('[RECORDATORIO] Error:', error.message)
                const detail = error?.response?.data || error
                console.error('[RECORDATORIO] Detalle:', JSON.stringify(detail, null, 2))
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )
}
