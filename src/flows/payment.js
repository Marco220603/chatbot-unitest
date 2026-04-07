import { addKeyword } from '@builderbot/bot'
import { JWT_TOKEN } from '../config/env.js'
import { normalizeText, cleanNumber, toNullableText } from '../utils/text.js'
import { debugAiLog } from '../utils/debug.js'
import { downloadAttachmentAsBase64 } from '../services/attachment.js'
import { analyzeReceiptWithGemini } from '../services/gemini.js'
import { registrarGastoEnAppsScript } from '../services/apps-script.js'
import { sendMetaButtonsSafe } from '../services/meta-messaging.js'
import { fetchPaymentCatalogs } from '../catalogs/payment.js'
import { sendNumberedListChunked, resolveNumberedSelection } from '../catalogs/selection.js'
import { buildConceptoGroupedCatalog } from '../catalogs/subconcepto.js'
import { buildNomenclatura, buildAppScriptPayload } from '../normalizers/payload.js'

const FLOW_EXIT_MESSAGE = 'Flujo cancelado. Para iniciar nuevamente escribe: registrar pago.'
const FLOW_EXIT_COMMANDS = new Set(['cancelar', 'salir', 'terminar', 'stop', 'cancelar flujo', 'terminar flujo'])

const shouldExitFlow = (text) => {
    const normalized = normalizeText(text)
    if (!normalized) return false
    if (FLOW_EXIT_COMMANDS.has(normalized)) return true
    return normalized.startsWith('cancelar ') || normalized.startsWith('terminar ')
}

const normalizeAllowedAttachmentMime = (mimeType = '') => {
    const value = String(mimeType).toLowerCase().trim()
    if (value === 'image/jpg') return 'image/jpeg'
    return value
}

export const startConversationFlow = addKeyword(['gasto', 'registrar gasto', 'registrar pago'])
    .addAnswer('Iniciando con el registro de gasto...')
    .addAnswer(
        'Por favor, suba o adjunte el comprobante de pago (png, jpg, jpeg o pdf)',
        { capture: true },
        async (ctx, { flowDynamic, fallBack, state, endFlow }) => {
            if (shouldExitFlow(ctx.body)) {
                return endFlow(FLOW_EXIT_MESSAGE)
            }

            const mimeType = normalizeAllowedAttachmentMime(ctx?.fileData?.mime_type)
            const mediaUrl = ctx?.url
            const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'application/pdf'])

            if (!mediaUrl || !allowedMimeTypes.has(mimeType)) {
                return fallBack('Archivo no valido. Envie unicamente un comprobante en formato PNG, JPG/JPEG o PDF.')
            }

            await flowDynamic([{ body: 'Comprobante recibido. Estamos procediendo con el analisis automatico, por favor espere unos segundos...', delay: 0 }])

            let attachmentBase64

            try {
                attachmentBase64 = await downloadAttachmentAsBase64({
                    fileUrl: mediaUrl,
                    jwtToken: JWT_TOKEN,
                })
            } catch (error) {
                return fallBack(
                    `No se pudo convertir el comprobante a base64 al recibirlo. ${error?.message ?? 'Intentalo nuevamente con otro archivo.'}`
                )
            }

            // Lanzar en PARALELO: análisis IA + carga de catálogos (son independientes)
            const [geminiResult, catalogsResult] = await Promise.allSettled([
                analyzeReceiptWithGemini({
                    fileUrl: mediaUrl,
                    mimeType,
                    jwtToken: JWT_TOKEN,
                    prefetchedBase64: attachmentBase64,
                }),
                fetchPaymentCatalogs(),
            ])

            // Procesar resultado de Gemini
            if (geminiResult.status === 'rejected') {
                debugAiLog('flow_error', geminiResult.reason?.message ?? geminiResult.reason)
                return fallBack(
                    `No se pudo completar el analisis del comprobante. ${geminiResult.reason?.message ?? 'Intentalo nuevamente con un archivo mas claro.'}`
                )
            }

            const analysis = geminiResult.value

            if (!analysis?.fechaPago) {
                return fallBack(
                    'No se pudo detectar la fecha de emision/pago del comprobante. Envia un archivo mas claro o con la fecha visible para continuar.'
                )
            }

            const tipoGasto = analysis?.tipoGasto
            const requiereProveedorYRuc = tipoGasto === 'Factura' || tipoGasto === 'Recibo por Honorarios'

            if (requiereProveedorYRuc && (!analysis?.proveedorRazonSocial || !analysis?.ruc)) {
                return fallBack(
                    `No se pudo detectar correctamente proveedor y/o RUC para ${tipoGasto}. Envia un archivo mas claro para continuar.`
                )
            }

            // Procesar resultado de catálogos (si falla, usar valores vacíos)
            const catalogs = catalogsResult.status === 'fulfilled'
                ? catalogsResult.value
                : { proyectos: [], usuarios: [], responsables: [], responsablesPago: [], provincias: [], subconceptos: [], warnings: ['No se pudieron cargar los catalogos.'] }

            await state.update({
                comprobanteUrl: mediaUrl,
                comprobanteMimeType: mimeType,
                comprobanteNombre: ctx?.fileData?.filename ?? null,
                comprobanteBase64: attachmentBase64,
                analisisComprobante: analysis,
                pagoManual: {
                    rubro: 'Maquinarias',
                    distribucionMaquinaria: '100%',
                },
            })

            // Construir catálogo agrupado de conceptos → subconceptos
            const conceptoGrouped = buildConceptoGroupedCatalog(catalogs.subconceptos)

            await state.update({
                catalogsPago: {
                    proyectos: catalogs.proyectos,
                    usuarios: catalogs.usuarios,
                    responsables: catalogs.responsables,
                    responsablesPago: catalogs.responsablesPago,
                    provincias: catalogs.provincias,
                    conceptoGrouped,
                },
            })

            // Consolidar resumen + warnings en UN solo mensaje
            const resumenParts = [
                'Analisis completado. Estos son los datos detectados:',
                `- Fecha del pago: ${analysis.fechaPago ?? 'No detectado'}`,
                `- Codigo de movimiento/transaccion: ${analysis.codigoMovimiento ?? 'No detectado'}`,
                `- Monto final: ${analysis.montoFinal ?? 'No detectado'}`,
                `- Descripcion: ${analysis.descripcion ?? 'No detectado'}`,
                `- Tipo de moneda: ${analysis.tipoMoneda ?? 'No detectado'}`,
                `- Lenguaje: ${analysis.lenguaje ?? 'No detectado'}`,
                `- Tipo de gasto: ${analysis.tipoGasto}`,
                `- Proveedor / Razon Social: ${analysis.proveedorRazonSocial ?? 'No aplica / No detectado'}`,
                `- RUC: ${analysis.ruc ?? 'No aplica / No detectado'}`,
                `- IGV: ${analysis.igv ?? 'No aplica / No detectado'}`,
                `- *Metodo de pago detectado*: ${analysis.metodoPago ?? 'No detectado'}`,
            ]

            if (Array.isArray(analysis?.warnings) && analysis.warnings.length) {
                resumenParts.push(`\nObservaciones: ${analysis.warnings.join(', ')}`)
            }

            if (catalogs.warnings.length) {
                resumenParts.push(`Aviso: ${catalogs.warnings.join(' ')}`)
            }

            resumenParts.push('\nAhora continuaremos con las preguntas manuales para completar el registro.')

            await flowDynamic([{ body: resumenParts.join('\n'), delay: 0 }])

            // --- Pregunta 1: Condición (BOTONES META) ---
            const number = cleanNumber(ctx.from)
            await flowDynamic([{ body: '1) Selecciona la *condicion* del gasto:', delay: 0 }])

            const sent = await sendMetaButtonsSafe({
                to: number,
                text: 'Elige una condicion',
                buttons: ['Caja', 'Escudo Fiscal', 'Devolucion'],
            })

            if (!sent) {
                await flowDynamic([{ body: 'Opciones: Caja / Escudo Fiscal / Devolucion', delay: 0 }])
            }
        }
    )

    // ── Captura 1: Condición → envía Pregunta 3: Proyecto ──
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow }) => {
        if (shouldExitFlow(ctx.body)) {
            return endFlow(FLOW_EXIT_MESSAGE)
        }

        const input = normalizeText(ctx.body)
        let condicion = null

        if (input.includes('caja')) condicion = 'Caja'
        if (input.includes('escudo')) condicion = 'Escudo Fiscal'
        if (input.includes('devolucion')) condicion = 'Devolucion'

        if (!condicion) {
            return fallBack('Condicion no valida. Selecciona: Caja, Escudo Fiscal o Devolucion.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, condicion } })

        // ── Enviar Pregunta: Método de Pago (confirmación o corrección) ──
        const analisis = state.get('analisisComprobante') ?? {}
        const metodoPagoDetectado = analisis.metodoPago ?? null

        const metodoMsg = metodoPagoDetectado
            ? `2) Metodo de pago detectado: *${metodoPagoDetectado}*\n\nSi es correcto escribe *ok*. Si no, escribe el metodo de pago correcto.\n_(Opciones: YAPE, PLIN, BCP, BBVA, INTERBANK, SCOTIABANK, CMR, VISA, MASTERCARD, AMERICAN EXPRESS, DINNERS, EFECTIVO, TRANSFERENCIA)_`
            : '2) No se pudo detectar el metodo de pago.\nEscribe el metodo de pago utilizado:\n_(Opciones: YAPE, PLIN, BCP, BBVA, INTERBANK, SCOTIABANK, CMR, VISA, MASTERCARD, AMERICAN EXPRESS, DINNERS, EFECTIVO, TRANSFERENCIA)_'

        await flowDynamic([{ body: metodoMsg, delay: 0 }])
    })

    // ── Captura: Método de Pago → envía Pregunta 3: Proyecto ──
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow }) => {
        if (shouldExitFlow(ctx.body)) {
            return endFlow(FLOW_EXIT_MESSAGE)
        }

        const METODOS_VALIDOS = new Set([
            'YAPE', 'PLIN', 'BCP', 'BBVA', 'INTERBANK', 'SCOTIABANK',
            'CMR', 'VISA', 'MASTERCARD', 'AMERICAN EXPRESS', 'AMEX',
            'DINNERS', 'DINNERS CLUB', 'EFECTIVO', 'TRANSFERENCIA',
        ])

        const input = ctx.body?.trim()?.toUpperCase() ?? ''
        const analisis = state.get('analisisComprobante') ?? {}
        let metodoPago = null

        if (['OK', 'SI', 'SÍ', 'CONFIRMO', 'CORRECTO'].includes(input)) {
            // Usuario confirmó el valor detectado por la IA
            metodoPago = analisis.metodoPago ?? null
            if (!metodoPago) {
                return fallBack('No se habia detectado un metodo de pago. Escribe el metodo de pago utilizado:\n_(YAPE, PLIN, BCP, BBVA, INTERBANK, SCOTIABANK, CMR, VISA, MASTERCARD, AMERICAN EXPRESS, DINNERS, EFECTIVO, TRANSFERENCIA)_')
            }
        } else if (METODOS_VALIDOS.has(input)) {
            metodoPago = input === 'AMEX' ? 'AMERICAN EXPRESS' : input === 'DINNERS CLUB' ? 'DINNERS' : input
        } else {
            return fallBack('Metodo de pago no valido. Escribe uno de los siguientes:\n*YAPE, PLIN, BCP, BBVA, INTERBANK, SCOTIABANK, CMR, VISA, MASTERCARD, AMERICAN EXPRESS, DINNERS, EFECTIVO, TRANSFERENCIA*')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, metodoPago } })

        // ── Enviar Pregunta 3: Proyecto ──
        const catalogsPago = state.get('catalogsPago') ?? {}
        const proyectos = catalogsPago.proyectos ?? []

        const headerProyecto = [
            '3) *rubro* = Maquinarias (valor por defecto)',
            '5) *Distribucion_Maquinaria* = 100% (valor por defecto)',
            '',
            '4) Selecciona el *Proyecto*. Digita el *numero* correspondiente:',
        ].join('\n')

        if (proyectos.length) {
            await sendNumberedListChunked(proyectos, flowDynamic, { header: headerProyecto })
        } else {
            await flowDynamic([{ body: headerProyecto.replace(/4\) Selecciona.*/, '4) No hay lista de proyectos disponible. Escribe el proyecto manualmente.'), delay: 0 }])
        }
    })

    // ── Captura 4: Proyecto → envía Pregunta 6: Usuarios ──
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow }) => {
        if (shouldExitFlow(ctx.body)) {
            return endFlow(FLOW_EXIT_MESSAGE)
        }

        const catalogsPago = state.get('catalogsPago') ?? {}
        const proyectos = catalogsPago.proyectos ?? []

        let proyecto = resolveNumberedSelection(ctx.body, proyectos)

        if (!proyecto) {
            if (proyectos.length) {
                return fallBack(`Numero no valido. Digita un numero entre 1 y ${proyectos.length}.`)
            }
            proyecto = toNullableText(ctx.body)
        }

        if (!proyecto) {
            return fallBack('Debes indicar un proyecto para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, proyecto } })

        // ── Enviar Pregunta 6: Usuarios ──
        const usuarios = catalogsPago.usuarios ?? []

        if (usuarios.length) {
            await sendNumberedListChunked(usuarios, flowDynamic, { header: '6) Selecciona el valor para *Usuarios*. Digita el *numero* correspondiente:' })
        } else {
            await flowDynamic([{ body: '6) No hay lista de usuarios disponible. Escribe el usuario manualmente.', delay: 0 }])
        }
    })

    // ── Captura 6: Usuarios → envía Pregunta 7: Provincia ──
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow }) => {
        if (shouldExitFlow(ctx.body)) {
            return endFlow(FLOW_EXIT_MESSAGE)
        }

        const catalogsPago = state.get('catalogsPago') ?? {}
        const usuarios = catalogsPago.usuarios ?? []

        let usuario = resolveNumberedSelection(ctx.body, usuarios)

        if (!usuario) {
            if (usuarios.length) {
                return fallBack(`Numero no valido. Digita un numero entre 1 y ${usuarios.length}.`)
            }
            usuario = toNullableText(ctx.body)
        }

        if (!usuario) {
            return fallBack('Debes indicar el valor de Usuarios para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, usuarios: usuario } })

        // ── Enviar Pregunta 7: Provincia ──
        const provincias = catalogsPago.provincias ?? []

        if (provincias.length) {
            await sendNumberedListChunked(provincias, flowDynamic, { header: '7) Selecciona la *Provincia* (sucursal). Digita el *numero* correspondiente:' })
        } else {
            await flowDynamic([{ body: '7) No hay lista de provincias disponible. Escribe la provincia manualmente.', delay: 0 }])
        }
    })

    // ── Captura 7: Provincia → envía Pregunta 8A: Concepto ──
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow }) => {
        if (shouldExitFlow(ctx.body)) {
            return endFlow(FLOW_EXIT_MESSAGE)
        }

        const catalogsPago = state.get('catalogsPago') ?? {}
        const provincias = catalogsPago.provincias ?? []

        let provincia = resolveNumberedSelection(ctx.body, provincias)

        if (!provincia) {
            if (provincias.length) {
                return fallBack(`Numero no valido. Digita un numero entre 1 y ${provincias.length}.`)
            }
            provincia = toNullableText(ctx.body)
        }

        if (!provincia) {
            return fallBack('Debes indicar la provincia para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, provincia } })

        // ── Enviar Pregunta 8A: Concepto ──
        const conceptoGrouped = catalogsPago.conceptoGrouped ?? {}
        const conceptos = conceptoGrouped.conceptos ?? []

        if (conceptos.length) {
            await sendNumberedListChunked(conceptos, flowDynamic, { header: '8) Primero, selecciona el *Concepto*. Digita el *numero* correspondiente:' })
        } else {
            await flowDynamic([{ body: '8) No hay lista de conceptos disponible. Escribe el concepto manualmente.', delay: 0 }])
        }
    })

    // ── Captura 8A: Concepto → envía Pregunta 8B: Subconcepto ──
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow }) => {
        if (shouldExitFlow(ctx.body)) {
            return endFlow(FLOW_EXIT_MESSAGE)
        }

        const catalogsPago = state.get('catalogsPago') ?? {}
        const conceptoGrouped = catalogsPago.conceptoGrouped ?? {}
        const conceptos = conceptoGrouped.conceptos ?? []

        let concepto = resolveNumberedSelection(ctx.body, conceptos)

        if (!concepto) {
            if (conceptos.length) {
                return fallBack(`Numero no valido. Digita un numero entre 1 y ${conceptos.length}.`)
            }
            concepto = toNullableText(ctx.body)
        }

        if (!concepto) {
            return fallBack('Debes indicar un concepto para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, concepto } })

        // ── Enviar Pregunta 8B: Subconcepto ──
        const subconceptos = conceptoGrouped.byConcepto?.[concepto] ?? []
        await state.update({ subconceptosFiltrados: subconceptos })

        if (subconceptos.length) {
            await sendNumberedListChunked(subconceptos, flowDynamic, { header: `Subconceptos de *${concepto}*. Digita el *numero* correspondiente:` })
        } else {
            await flowDynamic([{ body: `No hay subconceptos para "${concepto}". Escribe el subconcepto manualmente.`, delay: 0 }])
        }
    })

    // ── Captura 8B: Subconcepto → envía Pregunta 9: Responsable de Compra ──
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow }) => {
        if (shouldExitFlow(ctx.body)) {
            return endFlow(FLOW_EXIT_MESSAGE)
        }

        const subconceptos = state.get('subconceptosFiltrados') ?? []

        let subconcepto = resolveNumberedSelection(ctx.body, subconceptos)

        if (!subconcepto) {
            if (subconceptos.length) {
                return fallBack(`Numero no valido. Digita un numero entre 1 y ${subconceptos.length}.`)
            }
            subconcepto = toNullableText(ctx.body)
        }

        if (!subconcepto) {
            return fallBack('Debes indicar un subconcepto para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, subconcepto } })

        // ── Enviar Pregunta 9: Responsable de Compra ──
        const catalogsPago = state.get('catalogsPago') ?? {}
        const responsables = catalogsPago.responsables ?? []

        if (responsables.length) {
            await sendNumberedListChunked(responsables, flowDynamic, { header: '9) Selecciona *Responsable de Compra*. Digita el *numero* correspondiente:' })
        } else {
            await flowDynamic([{ body: '9) No hay lista de responsables disponible. Escribe el responsable manualmente.', delay: 0 }])
        }
    })

    // ── Captura 9: Responsable de Compra → envía Pregunta 10: Responsable de Pago ──
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow }) => {
        if (shouldExitFlow(ctx.body)) {
            return endFlow(FLOW_EXIT_MESSAGE)
        }

        const catalogsPago = state.get('catalogsPago') ?? {}
        const responsables = catalogsPago.responsables ?? []

        let responsable = resolveNumberedSelection(ctx.body, responsables)

        if (!responsable) {
            if (responsables.length) {
                return fallBack(`Numero no valido. Digita un numero entre 1 y ${responsables.length}.`)
            }
            responsable = toNullableText(ctx.body)
        }

        if (!responsable) {
            return fallBack('Debes indicar un responsable para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, responsable } })

        // ── Enviar Pregunta 10: Responsable de Pago ──
        const responsablesPago = catalogsPago.responsablesPago ?? []

        if (responsablesPago.length) {
            await sendNumberedListChunked(responsablesPago, flowDynamic, { header: '10) Selecciona *Responsable de Pago*. Digita el *numero* correspondiente:' })
        } else {
            await flowDynamic([{ body: '10) No hay lista de responsables de pago disponible. Escribe el responsable de pago manualmente.', delay: 0 }])
        }
    })

    // ── Captura 10: Responsable de Pago → Construir y enviar payload final ──
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow }) => {
        if (shouldExitFlow(ctx.body)) {
            return endFlow(FLOW_EXIT_MESSAGE)
        }

        const catalogsPago = state.get('catalogsPago') ?? {}
        const responsablesPago = catalogsPago.responsablesPago ?? []

        let responsablePago = resolveNumberedSelection(ctx.body, responsablesPago)

        if (!responsablePago) {
            if (responsablesPago.length) {
                return fallBack(`Numero no valido. Digita un numero entre 1 y ${responsablesPago.length}.`)
            }
            responsablePago = toNullableText(ctx.body)
        }

        if (!responsablePago) {
            return fallBack('Debes indicar un responsable de pago para continuar.')
        }

        // --- Construir y enviar payload final ---
        const pagoManual = state.get('pagoManual') ?? {}
        const analisisComprobante = state.get('analisisComprobante') ?? {}
        const comprobanteUrl = state.get('comprobanteUrl') ?? null
        const comprobanteMimeType = state.get('comprobanteMimeType') ?? null
        const comprobanteNombre = state.get('comprobanteNombre') ?? null
        const comprobanteBase64 = state.get('comprobanteBase64') ?? null

        const pagoFinal = {
            ...pagoManual,
            responsablePago,
        }

        const nomenclatura = buildNomenclatura({ analysis: analisisComprobante })
        const attachmentBase64 = comprobanteBase64

        if (!attachmentBase64) {
            const base64Error = 'No existe base64 del comprobante en memoria de la conversacion.'
            await state.update({ errorRegistroGasto: base64Error })
            await flowDynamic([{ body: `No se pudo convertir el archivo a base64. ${base64Error}`, delay: 0 }])
            return
        }

        const payloadAppScript = buildAppScriptPayload({
            analysis: analisisComprobante,
            manual: {
                ...pagoFinal,
                nomenclatura,
            },
            attachment: {
                url: comprobanteUrl,
                mimeType: comprobanteMimeType,
                nombre: comprobanteNombre,
                base64: attachmentBase64,
            },
        })

        await state.update({
            pagoManual: {
                ...pagoFinal,
                nomenclatura,
            },
            payloadAppScript,
        })

        let resultadoRegistroGasto = null
        let errorRegistroGasto = null

        try {
            console.log('[APPS_SCRIPT][registrarGasto] enviando payload para registro...')
            resultadoRegistroGasto = await registrarGastoEnAppsScript(payloadAppScript)
            console.log('[APPS_SCRIPT][registrarGasto] respuesta_final:', resultadoRegistroGasto)
            await state.update({ resultadoRegistroGasto })
        } catch (error) {
            errorRegistroGasto = error?.message ?? 'No se pudo registrar el gasto en Apps Script.'
            console.error('[APPS_SCRIPT][registrarGasto] error:', error)
            await state.update({ errorRegistroGasto })
        }

        const resumenFinal = [
            'Registro de pago completado. Resumen final:',
            '',
            `fecha_pago: ${analisisComprobante.fechaPago ?? 'No detectado'}`,
            `codigo_movimiento: ${analisisComprobante.codigoMovimiento ?? 'No detectado'}`,
            `monto_final: ${analisisComprobante.montoFinal ?? 'No detectado'}`,
            `descripcion: ${analisisComprobante.descripcion ?? 'No detectado'}`,
            `moneda: ${analisisComprobante.tipoMoneda ?? 'No detectado'}`,
            `lenguaje: ${analisisComprobante.lenguaje ?? 'No detectado'}`,
            `tipo_gasto: ${analisisComprobante.tipoGasto ?? 'No detectado'}`,
            `proveedor_razon_social: ${analisisComprobante.proveedorRazonSocial ?? 'No detectado'}`,
            `proveedor_ruc: ${analisisComprobante.ruc ?? 'No detectado'}`,
            `igv: ${analisisComprobante.igv ?? 'No detectado'}`,
            `condicion: ${pagoFinal.condicion ?? 'No detectado'}`,
            `rubro: ${pagoFinal.rubro ?? 'No detectado'}`,
            `proyecto: ${pagoFinal.proyecto ?? 'No detectado'}`,
            `distribucion_maquinaria: ${pagoFinal.distribucionMaquinaria ?? 'No detectado'}`,
            `usuarios: ${pagoFinal.usuarios ?? 'No detectado'}`,
            `provincia: ${pagoFinal.provincia ?? 'No detectado'}`,
            `concepto: ${pagoFinal.concepto ?? 'No detectado'}`,
            `subconcepto: ${pagoFinal.subconcepto ?? 'No detectado'}`,
            `responsable: ${pagoFinal.responsable ?? 'No detectado'}`,
            `responsable_pago: ${pagoFinal.responsablePago ?? 'No detectado'}`,
            `metodo_pago: ${pagoFinal.metodoPago ?? 'No detectado'}`,
            `nomenclatura: ${nomenclatura ?? 'No se pudo construir (falta RUC o codigo_movimiento)'}`,
        ].join('\n')

        await flowDynamic([{ body: resumenFinal, delay: 0 }])

        if (errorRegistroGasto) {
            await flowDynamic([{ body: `Se completo el flujo, pero hubo un error al enviar a Apps Script: ${errorRegistroGasto}`, delay: 0 }])
            return
        }

        await flowDynamic([{ body: 'El gasto fue enviado correctamente al endpoint registrarGasto de Apps Script.', delay: 0 }])
    })
