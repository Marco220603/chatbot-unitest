import { addKeyword } from '@builderbot/bot'
import { campainDataByNumber, recordatorioDataByNumber } from '../state/session.js'
import { registrarEnSheets } from '../services/google-sheets.js'
import { campainSiFlow } from './campaign-si.js'
import { campainNoFlow } from './campaign-no.js'
import { recordatorioConsultaFlow } from './recordatorio-consulta.js'

// Flow principal unificado: captura botones de campaña y recordatorio_servicio
// Campaña: "Sí, programar" / "No, luego"
// Recordatorio: "Sí, programar visita" / "Tengo una consulta"
export const campainResponseFlow = addKeyword(['Sí, programar', 'No, luego', 'Sí, programar visita', 'Tengo una consulta'])
    .addAction(async (ctx, { gotoFlow, flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const respuesta = ctx.body.trim().toLowerCase()

        // --- Recordatorio servicio ---
        const recData = recordatorioDataByNumber[numberClean]
        if (recData) {
            if (respuesta.includes('programar visita')) {
                console.log(`[RECORDATORIO] ${numberClean} eligió: Sí, programar visita`)

                await registrarEnSheets({
                    type: 'RESPUESTA_SI',
                    numero: recData.numero,
                    cliente: recData.cliente || '',
                    idCliente: recData.idCliente || '',
                    modelo: '',
                    serie: '',
                    rrvv: recData.rrvv || '',
                    respuestaPregunta: 'Sí, programar visita',
                    detalle: `Recordatorio Servicio - Programar visita`
                })

                await flowDynamic('✅ Gracias por tu confirmación. Un asesor se comunicará contigo pronto. 📞')
                delete recordatorioDataByNumber[numberClean]
                return
            }

            if (respuesta.includes('consulta')) {
                return gotoFlow(recordatorioConsultaFlow)
            }
        }

        // --- Campaña ---
        const campainData = campainDataByNumber[numberClean]
        if (!campainData) return

        if (respuesta.includes('sí') || respuesta.includes('si') || respuesta.includes('programar')) {
            return gotoFlow(campainSiFlow)
        }

        if (respuesta.includes('no') || respuesta.includes('luego')) {
            return gotoFlow(campainNoFlow)
        }
    })
