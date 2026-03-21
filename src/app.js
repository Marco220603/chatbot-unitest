import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import dotenv from "dotenv"
dotenv.config()

const PORT = process.env.PORT ?? 3008
const IDLE_TIMEOUT = 35000 // 35 segundos de inactividad
const GEMINI_APIKEY = process.env.GEMINI_APIKEY
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const DEBUG_AI = String(process.env.DEBUG_AI ?? 'false').toLowerCase() === 'true'
const RUC_EMPRESA = process.env.RUC_EMPRESA ?? process.env.EMPRESA_RUC ?? null
const MAX_META_LIST_ROWS = 10

const APPS_SCRIPT_CATALOG_BASE_URL = 'https://script.google.com/macros/s/AKfycbwNFEY1YuVf31jVZGviZcKB9ruogmXknVfRatJjZBttlEldcdoTTLtQU4Ddp55jPWCVmg/exec'
const PROYECTOS_URL = `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getProyectos`
const USUARIOS_ACTIVOS_URL = `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getUsuariosActivos`
const SUCURSALES_URL = `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getSucursal`
const CONCEPTO_SUBCONCEPTO_URL = `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getConceptoSubconcepto`
const SUBCONCEPTOS_URL_CANDIDATAS = [
    process.env.SUBCONCEPTOS_URL,
    CONCEPTO_SUBCONCEPTO_URL,
    `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getConceptosSubconceptos`,
    `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getConceptosYSubconceptos`,
    `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getSubconceptos`,
].filter(Boolean)

// URL del webhook de Google Apps Script para registrar envíos
const GOOGLE_SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwksLwMI7M-RgphlPYYz9EXunhDJluNN1RBQ-nS5j71Nqf2HituNqlNvQo2XOjqe-Xf/exec'

// URL pública del flyer para campañas con imagen (PL)
const FLYER_URL = 'https://drive.google.com/uc?export=download&id=1IQBdGczI-DIBrlrIRl4RRUZq5QmJdFCK'

// Referencia global al provider para enviar mensajes desde timers
let providerRef = null

const debugAiLog = (label, payload) => {
    if (!DEBUG_AI) return
    console.log(`[AI-DEBUG] ${label}:`, payload)
}

// Función helper para registrar en Google Sheets
async function registrarEnSheets(data) {
    try {
        await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        })
    } catch (err) {
        console.error('Error registrando en Google Sheets:', err)
    }
}

// Almacén temporal para datos de campaña por número
const campainDataByNumber = {}

// Almacén de timers de inactividad por número
const idleTimers = {}

/**
 * Inicia o reinicia el timer de inactividad para un número.
 * Cuando el timer expire (IDLE_TIMEOUT ms sin mensajes), ejecuta onExpire.
 */
function resetIdleTimer(numberClean, onExpire) {
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

const normalizeGeminiMimeType = (mimeType = '') => {
    const normalized = String(mimeType).toLowerCase().trim()
    if (normalized === 'image/jpg') return 'image/jpeg'
    return normalized
}

const dedupe = (items = []) => [...new Set(items.filter(Boolean))]

const normalizeText = (value = '') =>
    String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()

const cleanNumber = (value = '') => String(value).replace('+', '').replace(/\s/g, '')

const cutText = (value = '', max = 24) => {
    const text = String(value)
    if (text.length <= max) return text
    return `${text.slice(0, Math.max(1, max - 3))}...`
}

const getArrayData = (payload) => {
    if (Array.isArray(payload)) return payload
    if (Array.isArray(payload?.data)) return payload.data
    return []
}

const fetchJsonSafe = async (url) => {
    try {
        const response = await fetch(url)
        if (!response.ok) return null
        return await response.json()
    } catch {
        return null
    }
}

const chunk = (arr = [], size = 10) => {
    const result = []
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size))
    }
    return result
}

const buildStringSelectionCatalog = (items = [], prefix = 'OPT') => {
    const cleaned = dedupe(items.map((item) => toNullableText(item)).filter(Boolean))
    const byId = {}
    const byNormalized = {}
    const rows = cleaned.map((label, index) => {
        const id = `${prefix}_${String(index + 1).padStart(3, '0')}`
        byId[id] = label
        byNormalized[normalizeText(label)] = label

        return {
            id,
            title: cutText(label, 24),
            description: cutText(label, 72),
        }
    })

    return { rows, byId, byNormalized, count: cleaned.length }
}

const parseConceptosSubconceptos = (payload) => {
    const data = getArrayData(payload)
    const items = []

    for (const concepto of data) {
        const conceptoNombre =
            toNullableText(concepto?.nomenclatura) ?? toNullableText(concepto?.nombre) ?? toNullableText(concepto?.codigo)
        const subconceptos = Array.isArray(concepto?.subconceptos) ? concepto.subconceptos : []

        for (const sub of subconceptos) {
            const subconceptoNombre = toNullableText(sub?.nomenclatura) ?? toNullableText(sub?.nombre)
            const subconceptoCodigo = toNullableText(sub?.codigo) ?? `SC${items.length + 1}`

            if (!subconceptoNombre || !conceptoNombre) continue

            items.push({
                id: subconceptoCodigo,
                subconcepto: subconceptoNombre,
                concepto: conceptoNombre,
            })
        }
    }

    return items
}

const buildSubconceptoSelectionCatalog = (items = []) => {
    const byId = {}
    const byNormalized = {}
    const rows = []

    for (const item of items) {
        const id = toNullableText(item?.id)
        const subconcepto = toNullableText(item?.subconcepto)
        const concepto = toNullableText(item?.concepto)
        if (!id || !subconcepto || !concepto) continue

        const row = {
            id,
            title: cutText(subconcepto, 24),
            description: cutText(concepto, 72),
        }

        rows.push(row)
        byId[id] = { subconcepto, concepto }
        byNormalized[normalizeText(subconcepto)] = { subconcepto, concepto }
    }

    return { rows, byId, byNormalized, count: rows.length }
}

const resolveSelection = (input, catalog) => {
    const text = toNullableText(input)
    if (!text || !catalog) return null

    const byId = catalog.byId ?? {}
    const byNormalized = catalog.byNormalized ?? {}

    return byId[text] ?? byNormalized[normalizeText(text)] ?? null
}

const sendMetaListChunks = async ({ to, header, bodyText, buttonText, sectionPrefix, rows, flowDynamic }) => {
    if (!providerRef?.sendList || !rows.length) return false

    const chunks = chunk(rows, MAX_META_LIST_ROWS)

    try {
        for (let i = 0; i < chunks.length; i++) {
            const listPayload = {
                header: { type: 'text', text: cutText(`${header} ${i + 1}/${chunks.length}`, 60) },
                body: { text: bodyText },
                footer: { text: 'Selecciona una opcion del menu.' },
                action: {
                    button: buttonText,
                    sections: [
                        {
                            title: `${sectionPrefix} ${i + 1}`,
                            rows: chunks[i].map((row) => ({
                                id: row.id,
                                title: row.title,
                                description: row.description || '-',
                            })),
                        },
                    ],
                },
            }

            await providerRef.sendList(to, listPayload)
        }

        if (chunks.length > 1) {
            await flowDynamic(`Te enviamos ${chunks.length} listas para que puedas elegir.`)
        }

        return true
    } catch (error) {
        debugAiLog('send_list_error', error?.message ?? error)
        return false
    }
}

const sendMetaButtonsSafe = async ({ to, text, buttons }) => {
    if (!providerRef?.sendButtons) return false

    try {
        await providerRef.sendButtons(
            to,
            buttons.map((body) => ({ body })),
            text
        )
        return true
    } catch (error) {
        debugAiLog('send_buttons_error', error?.message ?? error)
        return false
    }
}

const fetchSubconceptosCatalog = async () => {
    for (const url of SUBCONCEPTOS_URL_CANDIDATAS) {
        const payload = await fetchJsonSafe(url)
        const data = parseConceptosSubconceptos(payload)
        if (data.length) return data
    }

    return []
}

const fetchPaymentCatalogs = async () => {
    const warnings = []

    const [proyectosPayload, usuariosPayload, provinciasPayload, subconceptos] = await Promise.all([
        fetchJsonSafe(PROYECTOS_URL),
        fetchJsonSafe(USUARIOS_ACTIVOS_URL),
        fetchJsonSafe(SUCURSALES_URL),
        fetchSubconceptosCatalog(),
    ])

    const proyectos = dedupe(getArrayData(proyectosPayload).map((item) => toNullableText(item)).filter(Boolean))
    const usuarios = dedupe(getArrayData(usuariosPayload).map((item) => toNullableText(item)).filter(Boolean))
    const provincias = dedupe(getArrayData(provinciasPayload).map((item) => toNullableText(item)).filter(Boolean))

    if (!proyectos.length) warnings.push('No se pudo cargar la lista de proyectos.')
    if (!usuarios.length) warnings.push('No se pudo cargar la lista de usuarios activos.')
    if (!provincias.length) warnings.push('No se pudo cargar la lista de provincias/sucursales.')
    if (!subconceptos.length) warnings.push('No se pudo cargar la lista de subconceptos.')

    return { proyectos, usuarios, provincias, subconceptos, warnings }
}

const buildNomenclatura = ({ analysis }) => {
    const tipoGasto = analysis?.tipoGasto
    const codigo = toNullableText(analysis?.codigoMovimiento)
    const rucDocumento = toNullableText(analysis?.ruc)

    let rucBase = RUC_EMPRESA
    if (tipoGasto === 'Factura' || tipoGasto === 'Recibo por Honorarios') {
        rucBase = rucDocumento ?? RUC_EMPRESA
    }

    if (!rucBase || !codigo) return null

    return `${rucBase} - ${codigo}`
}

const RECEIPT_EXTRACTION_PROMPT = `Eres un extractor experto de comprobantes (Peru) para automatizacion contable. Vas a recibir 1 archivo adjunto (PDF/PNG/JPEG) que puede contener texto digital u OCR. Tu mision es:

1) Clasificar el comprobante en:
     - "FACTURA" si detectas con alta confianza encabezados/titulos como:
         "FACTURA ELECTRONICA", "FACTURA", o frases tipo
         "Representacion impresa de la factura electronica", y/o un numero con formato de serie-correlativo (ej: F001-00007895, E001-9543).
     - "RECIBO_HONORARIOS" si detectas "RECIBO POR HONORARIOS" o equivalente.
     - Si no hay certeza, asigna "BOLETA" (esto incluye Yape/Plin/Transferencias/imagen simple).

2) Si el tipo es "FACTURA", extraer estos campos principales:
     - fecha_pago
     - codigo_movimiento
     - monto_final
     - descripcion
     - proveedor_razon_social
     - proveedor_ruc
     - igv
     - moneda (PEN o USD)

3) Reglas IMPORTANTES (anti-error / anti-alucinacion):
     - NO inventes datos. Si un campo no aparece explicito o no puedes inferirlo con reglas seguras, devuelve null.
     - Si hay mas de un RUC, identifica el RUC DEL EMISOR (proveedor) y NO el del cliente.
     - Devuelve SIEMPRE evidencia corta por campo (texto exacto detectado y pagina).
     - Normaliza formatos (fechas y montos) como se indica abajo.
     - Tu salida DEBE ser unicamente JSON valido (sin markdown, sin explicacion fuera del JSON).

A) EXTRACCION Y NORMALIZACION (FACTURA)

A1) Moneda (campo: moneda)
     Determina "USD" si aparece cualquiera:
         - "USD", "US$", "$" (cuando el contexto sea monetario), "DOLARES", "DOLARES AMERICANOS"
     Determina "PEN" si aparece cualquiera:
         - "S/", "S/.", "SOLES", "PEN", "(S/)"
     Si hay conflicto:
         - Prioriza la moneda declarada como etiqueta ("Moneda:", "Tipo de Moneda:")
         - Si sigue ambiguo: null + warning.

A2) Monto final (campo: monto_final)
     Busca en este orden de prioridad:
         1) Etiquetas: "Importe Total", "TOTAL", "TOTAL (S/)", "Total pagado", "Importe Total:"
         2) Si no existe, busca "Monto:" o "Total a pagar:".
     Reglas de parseo:
         - Convierte a numero decimal estandar.
         - Si hay separador de miles, eliminalo segun contexto.
         - Si el monto viene con prefijo/sufijo de moneda, ignoralo para el parseo numerico.

A3) IGV (campo: igv)
    Busca etiquetas: "IGV", "I.G.V.", "I.G.V.:", "IGV :", "IGV:", "Tasas", "Impuestos", "Total Impuestos", "Tasas o Impuestos"
     - Extrae el monto numerico asociado.
     - Si indica "0.00" tambien es valido.
     - Si NO se encuentra IGV pero el documento es FACTURA:
             - devuelve null + warning.
    - Si el comprobante NO es FACTURA y aparece "Tasas"/"Impuestos", usa ese monto en igv y agrega warning "igv_desde_tasas_impuestos".

A4) Proveedor / Razon social (campo: proveedor_razon_social) - SOLO FACTURA
     Objetivo: el NOMBRE DEL EMISOR.

A5) Proveedor RUC (campo: proveedor_ruc) - SOLO FACTURA
     Objetivo: RUC del EMISOR (11 digitos).
     Si no pasa validacion, igual puedes devolverlo, pero agrega warning "ruc_emisor_no_valida".

A6) Fecha del pago (campo: fecha_pago)
     Regla principal:
     - Si existe "Fecha de Pago" explicito -> usa ese.
     Si no existe:
     - Usa "Fecha de Emision" / "FECHA EMISION" como fecha_pago.
     Evita confusiones:
     - Si aparece "Fecha de Vcto." (vencimiento), NO la uses como fecha_pago.
     - Si es transporte y aparece "F.VIAJE", NO la uses como fecha_pago.
     Normalizacion de fecha:
     - Devuelve SIEMPRE ISO: "YYYY-MM-DD"
     - Si viene "DD/MM/YYYY" o "DD/MM/YY", conviertelo.

A7) Codigo de movimiento / transaccion (campo: codigo_movimiento)
     Prioridad:
     - Primero codigo transaccional explicito.
     - Si no hay, usar serie-correlativo del comprobante.
     - Si no aparece ninguno: null + warning.

A8) Descripcion (campo: descripcion)
    Objetivo: resumen util para registro contable.
    - Si no hay suficiente informacion, devuelve null y agrega warning "descripcion_insuficiente".

B) CAMPOS EXTRA
Ademas de los campos principales, llena "metadatos" si estan disponibles:
- numero_comprobante
- serie
- correlativo
- fecha_emision
- fecha_vencimiento
- forma_pago
- receptor_razon_social
- receptor_ruc
- observaciones relevantes

C) SALIDA: JSON ESTRICTO
Devuelve exactamente este esquema y solo JSON:
{
    "tipo_gasto": "FACTURA|RECIBO_HONORARIOS|BOLETA",
    "fecha_pago": "YYYY-MM-DD|null",
    "codigo_movimiento": "string|null",
    "monto_final": "number|null",
    "descripcion": "string|null",
    "moneda": "PEN|USD|null",
    "proveedor_razon_social": "string|null",
    "proveedor_ruc": "string|null",
    "igv": "number|null",
    "metadatos": {
        "numero_comprobante": "string|null",
        "serie": "string|null",
        "correlativo": "string|null",
        "fecha_emision": "YYYY-MM-DD|null",
        "fecha_vencimiento": "YYYY-MM-DD|null",
        "forma_pago": "string|null",
        "receptor_razon_social": "string|null",
        "receptor_ruc": "string|null",
        "notas": ["string"]
    },
    "confidence": {
        "tipo_gasto": 0.0,
        "fecha_pago": 0.0,
        "codigo_movimiento": 0.0,
        "monto_final": 0.0,
        "descripcion": 0.0,
        "moneda": 0.0,
        "proveedor_razon_social": 0.0,
        "proveedor_ruc": 0.0,
        "igv": 0.0
    },
    "evidencias": {
        "tipo_gasto": {"texto": "string|null", "pagina": "number|null"},
        "fecha_pago": {"texto": "string|null", "pagina": "number|null"},
        "codigo_movimiento": {"texto": "string|null", "pagina": "number|null"},
        "monto_final": {"texto": "string|null", "pagina": "number|null"},
        "descripcion": {"texto": "string|null", "pagina": "number|null"},
        "moneda": {"texto": "string|null", "pagina": "number|null"},
        "proveedor_razon_social": {"texto": "string|null", "pagina": "number|null"},
        "proveedor_ruc": {"texto": "string|null", "pagina": "number|null"},
        "igv": {"texto": "string|null", "pagina": "number|null"}
    },
    "warnings": ["string"]
}

D) CHEQUEOS DE COHERENCIA
1) Si tipo_gasto="FACTURA" y proveedor_ruc tiene 11 digitos, valida digito verificador.
2) Si igv y monto_final existen y igv > monto_final, warning "igv_mayor_que_total".
3) Si moneda es USD pero evidencias muestran "(S/)" o "SOLES", warning "conflicto_moneda".
4) Si codigo_movimiento queda igual a numero_comprobante por falta de transaccion explicita, agrega nota en metadatos.notas.

Recuerda: SALIDA SOLO JSON.`

const extractJsonFromText = (value = '') => {
    const clean = value
        .replace(/```json/gi, '```')
        .replace(/```/g, '')
        .trim()

    const firstBrace = clean.indexOf('{')
    const lastBrace = clean.lastIndexOf('}')

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null

    const jsonText = clean.slice(firstBrace, lastBrace + 1)

    try {
        return JSON.parse(jsonText)
    } catch {
        return null
    }
}

const normalizeExpenseType = (value = '') => {
    const normalized = String(value).toLowerCase()
    if (normalized.includes('factura')) return 'Factura'
    if (normalized.includes('honorarios')) return 'Recibo por Honorarios'
    return 'Boleta'
}

const toNullableText = (value) => {
    if (value === undefined || value === null) return null
    const text = String(value).trim()
    return text.length ? text : null
}

const normalizeCurrency = (value = '') => {
    const normalized = String(value).toUpperCase()
    if (normalized.includes('USD') || normalized.includes('$')) return 'USD'
    if (normalized.includes('S/') || normalized.includes('PEN') || normalized.includes('SOLES')) return 'S/'
    return null
}

const buildFallbackDescription = ({ tipoGasto, raw }) => {
    const notesText = Array.isArray(raw?.metadatos?.notas) ? raw.metadatos.notas.join(' - ') : null

    if (tipoGasto === 'Factura') {
        return (
            toNullableText(raw?.metadatos?.observaciones) ??
            toNullableText(notesText) ??
            'Factura procesada. No se identificaron lineas de detalle explicitas; revisar detalle comercial del documento.'
        )
    }

    if (tipoGasto === 'Recibo por Honorarios') {
        return (
            toNullableText(raw?.metadatos?.receptor_razon_social) ??
            toNullableText(raw?.metadatos?.beneficiario) ??
            'Recibo por honorarios procesado. Revisar persona beneficiaria del cobro en el comprobante.'
        )
    }

    return (
        toNullableText(raw?.metadatos?.receptor_razon_social) ??
        toNullableText(notesText) ??
        'Boleta procesada. Revisar destinatario o concepto principal indicado en el comprobante.'
    )
}

const normalizeReceiptFields = (raw = {}) => {
    const tipoGasto = normalizeExpenseType(raw.tipoGasto)
    const isFactura = tipoGasto === 'Factura'

    return {
        fechaPago: toNullableText(raw.fechaPago),
        codigoMovimiento: toNullableText(raw.codigoMovimiento),
        montoFinal: toNullableText(raw.montoFinal),
        tipoMoneda: normalizeCurrency(raw.tipoMoneda),
        tipoGasto,
        descripcion: toNullableText(raw.descripcion),
        proveedorRazonSocial: isFactura ? toNullableText(raw.proveedorRazonSocial) : null,
        ruc: isFactura ? toNullableText(raw.ruc) : null,
        igv: toNullableText(raw.igv),
    }
}

const normalizeStrictReceiptPayload = (raw = {}) => {
    const tipoGastoRaw = String(raw?.tipo_gasto ?? '').toUpperCase()
    let tipoGasto = 'Boleta'

    if (tipoGastoRaw === 'FACTURA') tipoGasto = 'Factura'
    if (tipoGastoRaw === 'RECIBO_HONORARIOS') tipoGasto = 'Recibo por Honorarios'

    const isFactura = tipoGasto === 'Factura'

    return {
        fechaPago: toNullableText(raw?.fecha_pago),
        codigoMovimiento: toNullableText(raw?.codigo_movimiento),
        montoFinal: raw?.monto_final === null || raw?.monto_final === undefined ? null : String(raw.monto_final),
        tipoMoneda: raw?.moneda === 'PEN' ? 'S/' : raw?.moneda === 'USD' ? 'USD' : null,
        tipoGasto,
        descripcion: toNullableText(raw?.descripcion) ?? buildFallbackDescription({ tipoGasto, raw }),
        proveedorRazonSocial: isFactura ? toNullableText(raw?.proveedor_razon_social) : null,
        ruc: isFactura ? toNullableText(raw?.proveedor_ruc) : null,
        igv: raw?.igv === null || raw?.igv === undefined ? null : String(raw.igv),
        metadatos: raw?.metadatos ?? null,
        confidence: raw?.confidence ?? null,
        evidencias: raw?.evidencias ?? null,
        warnings: Array.isArray(raw?.warnings) ? raw.warnings : [],
    }
}

const analyzeReceiptWithGemini = async ({ fileUrl, mimeType, jwtToken }) => {
    if (!GEMINI_APIKEY) {
        throw new Error('No se encontro GEMINI_APIKEY en variables de entorno.')
    }

    const mediaResponse = await fetch(fileUrl, {
        headers: {
            Authorization: `Bearer ${jwtToken}`,
        },
    })

    if (!mediaResponse.ok) {
        throw new Error('No se pudo descargar el comprobante para su analisis.')
    }

    const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer())
    const fileBase64 = mediaBuffer.toString('base64')

    const safeMimeType = normalizeGeminiMimeType(mimeType)
    const candidateModels = dedupe([GEMINI_MODEL, 'gemini-2.0-flash', 'gemini-1.5-flash'])

    debugAiLog('input', {
        mimeType: safeMimeType,
        sizeBytes: mediaBuffer.length,
        candidateModels,
    })

    let geminiJson = null
    let lastError = null

    for (const model of candidateModels) {
        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_APIKEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    generationConfig: {
                        temperature: 0,
                        responseMimeType: 'application/json',
                    },
                    contents: [
                        {
                            parts: [
                                { text: RECEIPT_EXTRACTION_PROMPT },
                                {
                                    inline_data: {
                                        mime_type: safeMimeType,
                                        data: fileBase64,
                                    },
                                },
                            ],
                        },
                    ],
                }),
            }
        )

        if (geminiResponse.ok) {
            geminiJson = await geminiResponse.json()
            debugAiLog('model_ok', { model })
            break
        }

        let errorBody = ''

        try {
            errorBody = await geminiResponse.text()
        } catch {
            errorBody = ''
        }

        let errorMessage = `HTTP ${geminiResponse.status}`

        try {
            const parsedError = errorBody ? JSON.parse(errorBody) : null
            errorMessage = parsedError?.error?.message ?? errorMessage
        } catch {
            if (errorBody) errorMessage = errorBody
        }

        lastError = `${model}: ${errorMessage}`
        debugAiLog('model_error', { model, errorMessage })
    }

    if (!geminiJson) {
        throw new Error(`Gemini no respondio correctamente durante el analisis. ${lastError ?? ''}`.trim())
    }

    const textResult = geminiJson?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text)
        .filter(Boolean)
        .join('\n')

    debugAiLog('raw_text_preview', textResult ? textResult.slice(0, 1200) : null)

    const directJsonText = typeof textResult === 'string' ? textResult.trim() : ''
    let parsed = null

    if (directJsonText.startsWith('{') && directJsonText.endsWith('}')) {
        try {
            parsed = JSON.parse(directJsonText)
        } catch {
            parsed = null
        }
    }

    if (!parsed) {
        parsed = extractJsonFromText(textResult)
    }

    debugAiLog('parsed_json', parsed)

    if (!parsed) {
        throw new Error('No se pudo interpretar la respuesta del analisis.')
    }

    if (Object.prototype.hasOwnProperty.call(parsed, 'tipo_gasto')) {
        const normalized = normalizeStrictReceiptPayload(parsed)
        debugAiLog('normalized_output', normalized)
        return normalized
    }

    const normalizedLegacy = normalizeReceiptFields(parsed)
    debugAiLog('normalized_output_legacy', normalizedLegacy)
    return normalizedLegacy
}

// function clearIdleTimer(numberClean) {
//     if (idleTimers[numberClean]) {
//         clearTimeout(idleTimers[numberClean])
//         delete idleTimers[numberClean]
//     }
// }

// Función para enviar campaña via template de Meta y registro en Sheets
// headerImageUrl es opcional — solo para templates que tienen header de imagen
async function enviarCampain(bot, adapterProvider, datosCampain, detalleCampain, templateName, headerImageUrl) {
    const { Cliente, ID_Cliente, Modelo, Serie, RRVV, Numero } = datosCampain

    if (!Numero) {
        console.error(`[CAMPAIN] Campo 'Numero' faltante o undefined. Body recibido:`, JSON.stringify(datosCampain))
        return { status: 'error', message: `Campo 'Numero' es requerido. Verificar el payload enviado desde GAS.` }
    }

    const numberClean = String(Numero).replace('+', '').replace(/\s/g, '')

    try {
        // 1. Armar componentes del template
        const components = [
            {
                type: 'body',
                parameters: [
                    { type: 'text', text: String(Cliente) },
                    { type: 'text', text: String(Serie) },
                    { type: 'text', text: String(RRVV) }
                ]
            }
        ]

        // Si el template tiene header de imagen, agregarlo
        if (headerImageUrl) {
            components.unshift({
                type: 'header',
                parameters: [
                    { type: 'image', image: { link: headerImageUrl } }
                ]
            })
        }

        // 2. Enviar template de Meta
        const templateResult = await adapterProvider.sendTemplate(numberClean, templateName, 'es_PE', components)

        // Meta API puede retornar un Error sin lanzarlo — verificar
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

        console.log(`[CAMPAIN] Template '${templateName}' enviado a ${numberClean}`, JSON.stringify(templateResult))

        // 2. Guardar datos de campaña para los flujos de respuesta
        campainDataByNumber[numberClean] = {
            cliente: Cliente,
            idCliente: ID_Cliente,
            modelo: Modelo,
            serie: Serie,
            rrvv: RRVV,
            numero: numberClean,
            detalle: detalleCampain,
            fecha: new Date().toISOString()
        }

        // 3. Registrar envío exitoso en Google Sheets
        await registrarEnSheets({
            type: 'ENVIO',
            cliente: Cliente,
            idCliente: ID_Cliente,
            modelo: Modelo,
            serie: Serie,
            rrvv: RRVV,
            numero: numberClean,
            estadoEnvio: 'ENVIADO',
            detalle: detalleCampain
        })

        return { status: 'enviado', message: `Template enviado a ${numberClean}` }

    } catch (error) {
        // Logear detalle completo del error de Meta API
        const metaError = error?.response?.data || error?.error || error
        console.error(`[CAMPAIN] Error enviando a ${numberClean}:`, error.message)
        console.error(`[CAMPAIN] Detalle Meta:`, JSON.stringify(metaError, null, 2))

        // Detectar si el error es por número sin WhatsApp
        const errorMsg = String(error.message || '').toLowerCase()
        const sinWhatsApp = errorMsg.includes('not a valid whatsapp') ||
            errorMsg.includes('recipient') ||
            errorMsg.includes('incapable')

        const estadoEnvio = sinWhatsApp ? 'SIN_WHATSAPP' : 'ERROR'

        await registrarEnSheets({
            type: 'ENVIO',
            cliente: Cliente,
            idCliente: ID_Cliente,
            modelo: Modelo,
            serie: Serie,
            rrvv: RRVV,
            numero: numberClean,
            estadoEnvio,
            detalle: `${detalleCampain} - ${estadoEnvio}: ${error.message}`
        })

        return { status: sinWhatsApp ? 'sin_whatsapp' : 'error', message: error.message }
    }
}

// ========== FLOWS DE CAMPAÑA (por dispatch + gotoFlow) ==========

const startConversationFlow = addKeyword(['pago', 'registrar pago'])
    .addAnswer('Iniciando con el registro de pago...')
    .addAnswer(
        'Por favor, suba o adjunte el comprobante de pago (png, jpg, jpeg o pdf)',
        { capture: true },
        async (ctx, { flowDynamic, fallBack, state }) => {
            const mimeType = ctx?.fileData?.mime_type?.toLowerCase() ?? ''
            const mediaUrl = ctx?.url
            const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'])

            if (!mediaUrl || !allowedMimeTypes.has(mimeType)) {
                return fallBack('Archivo no valido. Envie unicamente un comprobante en formato PNG, JPG/JPEG o PDF.')
            }

            await flowDynamic('Comprobante recibido. Estamos procediendo con el analisis automatico, por favor espere unos segundos...')

            let analysis

            try {
                analysis = await analyzeReceiptWithGemini({
                    fileUrl: mediaUrl,
                    mimeType,
                    jwtToken: process.env.JWT_TOKEN,
                })
            } catch (error) {
                debugAiLog('flow_error', error?.message ?? error)
                return fallBack(
                    `No se pudo completar el analisis del comprobante. ${error?.message ?? 'Intentalo nuevamente con un archivo mas claro.'}`
                )
            }

            await state.update({
                comprobanteUrl: mediaUrl,
                comprobanteMimeType: mimeType,
                comprobanteNombre: ctx?.fileData?.filename ?? null,
                analisisComprobante: analysis,
                pagoManual: {
                    rubro: 'Maquinarias',
                    distribucionMaquinaria: '100%',
                },
            })

            const catalogs = await fetchPaymentCatalogs()
            const proyectoCatalog = buildStringSelectionCatalog(catalogs.proyectos, 'PROY')
            const usuariosCatalog = buildStringSelectionCatalog(catalogs.usuarios, 'USR')
            const provinciaCatalog = buildStringSelectionCatalog(catalogs.provincias, 'PROV')
            const subconceptoCatalog = buildSubconceptoSelectionCatalog(catalogs.subconceptos)

            await state.update({
                catalogsPago: {
                    proyectoCatalog,
                    usuariosCatalog,
                    provinciaCatalog,
                    subconceptoCatalog,
                },
            })

            const resumen = [
                'Analisis completado. Estos son los datos detectados:',
                `- Fecha del pago: ${analysis.fechaPago ?? 'No detectado'}`,
                `- Codigo de movimiento/transaccion: ${analysis.codigoMovimiento ?? 'No detectado'}`,
                `- Monto final: ${analysis.montoFinal ?? 'No detectado'}`,
                `- Descripcion: ${analysis.descripcion ?? 'No detectado'}`,
                `- Tipo de moneda: ${analysis.tipoMoneda ?? 'No detectado'}`,
                `- Tipo de gasto: ${analysis.tipoGasto}`,
                `- Proveedor / Razon Social: ${analysis.proveedorRazonSocial ?? 'No aplica / No detectado'}`,
                `- RUC: ${analysis.ruc ?? 'No aplica / No detectado'}`,
                `- IGV: ${analysis.igv ?? 'No aplica / No detectado'}`,
            ].join('\n')

            await flowDynamic(resumen)

            if (Array.isArray(analysis?.warnings) && analysis.warnings.length) {
                await flowDynamic(`Observaciones del analisis: ${analysis.warnings.join(', ')}`)
            }

            if (catalogs.warnings.length) {
                await flowDynamic(`Aviso: ${catalogs.warnings.join(' ')}`)
            }

            await flowDynamic('Ahora continuaremos con las preguntas manuales para completar el registro.')
        }
    )
    .addAction(async (ctx, { flowDynamic }) => {
        const number = cleanNumber(ctx.from)

        await flowDynamic('1) Selecciona la *condicion* del gasto:')

        const sent = await sendMetaButtonsSafe({
            to: number,
            text: 'Elige una condicion',
            buttons: ['Caja', 'Escudo Fiscal', 'Devolucion'],
        })

        if (!sent) {
            await flowDynamic('Opciones: Caja / Escudo Fiscal / Devolucion')
        }
    })
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack }) => {
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
    })
    .addAction(async (ctx, { flowDynamic, state }) => {
        const number = cleanNumber(ctx.from)
        const catalogsPago = state.get('catalogsPago') ?? {}
        const proyectoCatalog = catalogsPago.proyectoCatalog

        await flowDynamic('2) *rubro* = Maquinarias (valor por defecto)')
        await flowDynamic('4) *Distribucion_Maquinaria* = 100% (valor por defecto)')
        await flowDynamic('3) Selecciona el *Proyecto*:')

        if (proyectoCatalog?.rows?.length) {
            const sent = await sendMetaListChunks({
                to: number,
                header: 'Proyectos',
                bodyText: 'Selecciona el proyecto correspondiente.',
                buttonText: 'Ver proyectos',
                sectionPrefix: 'Proyecto',
                rows: proyectoCatalog.rows,
                flowDynamic,
            })

            if (!sent) {
                await flowDynamic('No se pudo enviar la lista interactiva. Escribe el codigo o el nombre del proyecto.')
            }
        } else {
            await flowDynamic('No hay lista de proyectos disponible. Escribe el proyecto manualmente.')
        }
    })
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack }) => {
        const catalogsPago = state.get('catalogsPago') ?? {}
        const proyectoCatalog = catalogsPago.proyectoCatalog
        let proyecto = resolveSelection(ctx.body, proyectoCatalog)

        if (!proyecto) {
            if (proyectoCatalog?.count) {
                return fallBack('Proyecto no valido. Selecciona una opcion de la lista de proyectos.')
            }
            proyecto = toNullableText(ctx.body)
        }

        if (!proyecto) {
            return fallBack('Debes indicar un proyecto para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, proyecto } })
    })
    .addAction(async (ctx, { flowDynamic, state }) => {
        const number = cleanNumber(ctx.from)
        const catalogsPago = state.get('catalogsPago') ?? {}
        const usuariosCatalog = catalogsPago.usuariosCatalog

        await flowDynamic('5) Selecciona el valor para *Usuarios*:')

        if (usuariosCatalog?.rows?.length) {
            const sent = await sendMetaListChunks({
                to: number,
                header: 'Usuarios Activos',
                bodyText: 'Selecciona un usuario administrativo activo.',
                buttonText: 'Ver usuarios',
                sectionPrefix: 'Usuario',
                rows: usuariosCatalog.rows,
                flowDynamic,
            })

            if (!sent) {
                await flowDynamic('No se pudo enviar la lista interactiva. Escribe el codigo o el nombre del usuario.')
            }
        } else {
            await flowDynamic('No hay lista de usuarios disponible. Escribe el usuario manualmente.')
        }
    })
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack }) => {
        const catalogsPago = state.get('catalogsPago') ?? {}
        const usuariosCatalog = catalogsPago.usuariosCatalog
        let usuarios = resolveSelection(ctx.body, usuariosCatalog)

        if (!usuarios) {
            if (usuariosCatalog?.count) {
                return fallBack('Usuario no valido. Selecciona una opcion de la lista.')
            }
            usuarios = toNullableText(ctx.body)
        }

        if (!usuarios) {
            return fallBack('Debes indicar el valor de Usuarios para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, usuarios } })
    })
    .addAction(async (ctx, { flowDynamic, state }) => {
        const number = cleanNumber(ctx.from)
        const catalogsPago = state.get('catalogsPago') ?? {}
        const provinciaCatalog = catalogsPago.provinciaCatalog

        await flowDynamic('6) Selecciona la *Provincia* (sucursal):')

        if (provinciaCatalog?.rows?.length) {
            const sent = await sendMetaListChunks({
                to: number,
                header: 'Provincias',
                bodyText: 'Selecciona la provincia/sucursal correspondiente.',
                buttonText: 'Ver provincias',
                sectionPrefix: 'Provincia',
                rows: provinciaCatalog.rows,
                flowDynamic,
            })

            if (!sent) {
                await flowDynamic('No se pudo enviar la lista interactiva. Escribe el codigo o nombre de la provincia.')
            }
        } else {
            await flowDynamic('No hay lista de provincias disponible. Escribe la provincia manualmente.')
        }
    })
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack }) => {
        const catalogsPago = state.get('catalogsPago') ?? {}
        const provinciaCatalog = catalogsPago.provinciaCatalog
        let provincia = resolveSelection(ctx.body, provinciaCatalog)

        if (!provincia) {
            if (provinciaCatalog?.count) {
                return fallBack('Provincia no valida. Selecciona una opcion de la lista.')
            }
            provincia = toNullableText(ctx.body)
        }

        if (!provincia) {
            return fallBack('Debes indicar la provincia para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, provincia } })
    })
    .addAction(async (ctx, { flowDynamic, state }) => {
        const number = cleanNumber(ctx.from)
        const catalogsPago = state.get('catalogsPago') ?? {}
        const subconceptoCatalog = catalogsPago.subconceptoCatalog

        await flowDynamic('7) Selecciona el *Subconcepto* (al elegirlo se guarda automaticamente su concepto):')

        if (subconceptoCatalog?.rows?.length) {
            const sent = await sendMetaListChunks({
                to: number,
                header: 'Subconceptos',
                bodyText: 'Selecciona el subconcepto correspondiente.',
                buttonText: 'Ver subconceptos',
                sectionPrefix: 'Subconcepto',
                rows: subconceptoCatalog.rows,
                flowDynamic,
            })

            if (!sent) {
                await flowDynamic('No se pudo enviar la lista interactiva. Escribe el codigo o el nombre del subconcepto.')
            }
        } else {
            await flowDynamic('No hay lista de subconceptos disponible. Escribe el subconcepto manualmente.')
        }
    })
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack }) => {
        const catalogsPago = state.get('catalogsPago') ?? {}
        const subconceptoCatalog = catalogsPago.subconceptoCatalog
        let selection = resolveSelection(ctx.body, subconceptoCatalog)

        if (!selection) {
            if (subconceptoCatalog?.count) {
                return fallBack('Subconcepto no valido. Selecciona una opcion de la lista.')
            }

            const manualSubconcepto = toNullableText(ctx.body)
            if (!manualSubconcepto) {
                return fallBack('Debes indicar un subconcepto para continuar.')
            }

            selection = { subconcepto: manualSubconcepto, concepto: null }
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({
            pagoManual: {
                ...pagoManual,
                subconcepto: selection.subconcepto,
                concepto: selection.concepto,
            },
        })
    })
    .addAction(async (ctx, { flowDynamic, state }) => {
        const number = cleanNumber(ctx.from)
        const catalogsPago = state.get('catalogsPago') ?? {}
        const usuariosCatalog = catalogsPago.usuariosCatalog

        await flowDynamic('8) Selecciona *Responsable* (misma lista de usuarios activos):')

        if (usuariosCatalog?.rows?.length) {
            const sent = await sendMetaListChunks({
                to: number,
                header: 'Responsable',
                bodyText: 'Selecciona al responsable.',
                buttonText: 'Ver usuarios',
                sectionPrefix: 'Responsable',
                rows: usuariosCatalog.rows,
                flowDynamic,
            })

            if (!sent) {
                await flowDynamic('No se pudo enviar la lista interactiva. Escribe el codigo o nombre del responsable.')
            }
        } else {
            await flowDynamic('No hay lista de usuarios disponible. Escribe el responsable manualmente.')
        }
    })
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack }) => {
        const catalogsPago = state.get('catalogsPago') ?? {}
        const usuariosCatalog = catalogsPago.usuariosCatalog
        let responsable = resolveSelection(ctx.body, usuariosCatalog)

        if (!responsable) {
            if (usuariosCatalog?.count) {
                return fallBack('Responsable no valido. Selecciona una opcion de la lista.')
            }
            responsable = toNullableText(ctx.body)
        }

        if (!responsable) {
            return fallBack('Debes indicar un responsable para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        await state.update({ pagoManual: { ...pagoManual, responsable } })
    })
    .addAction(async (ctx, { flowDynamic, state }) => {
        const number = cleanNumber(ctx.from)
        const catalogsPago = state.get('catalogsPago') ?? {}
        const usuariosCatalog = catalogsPago.usuariosCatalog

        await flowDynamic('9) Selecciona *Responsable Pago* (misma lista de usuarios activos):')

        if (usuariosCatalog?.rows?.length) {
            const sent = await sendMetaListChunks({
                to: number,
                header: 'Responsable Pago',
                bodyText: 'Selecciona al responsable del pago.',
                buttonText: 'Ver usuarios',
                sectionPrefix: 'Responsable Pago',
                rows: usuariosCatalog.rows,
                flowDynamic,
            })

            if (!sent) {
                await flowDynamic('No se pudo enviar la lista interactiva. Escribe el codigo o nombre del responsable de pago.')
            }
        } else {
            await flowDynamic('No hay lista de usuarios disponible. Escribe el responsable de pago manualmente.')
        }
    })
    .addAnswer(null, { capture: true }, async (ctx, { state, fallBack, flowDynamic }) => {
        const catalogsPago = state.get('catalogsPago') ?? {}
        const usuariosCatalog = catalogsPago.usuariosCatalog
        let responsablePago = resolveSelection(ctx.body, usuariosCatalog)

        if (!responsablePago) {
            if (usuariosCatalog?.count) {
                return fallBack('Responsable Pago no valido. Selecciona una opcion de la lista.')
            }
            responsablePago = toNullableText(ctx.body)
        }

        if (!responsablePago) {
            return fallBack('Debes indicar un responsable de pago para continuar.')
        }

        const pagoManual = state.get('pagoManual') ?? {}
        const analisisComprobante = state.get('analisisComprobante') ?? {}

        const pagoFinal = {
            ...pagoManual,
            responsablePago,
        }

        const nomenclatura = buildNomenclatura({ analysis: analisisComprobante })

        await state.update({
            pagoManual: {
                ...pagoFinal,
                nomenclatura,
            },
        })

        const resumenFinal = [
            'Registro de pago completado. Resumen final:',
            '',
            `fecha_pago: ${analisisComprobante.fechaPago ?? 'No detectado'}`,
            `codigo_movimiento: ${analisisComprobante.codigoMovimiento ?? 'No detectado'}`,
            `monto_final: ${analisisComprobante.montoFinal ?? 'No detectado'}`,
            `descripcion: ${analisisComprobante.descripcion ?? 'No detectado'}`,
            `moneda: ${analisisComprobante.tipoMoneda ?? 'No detectado'}`,
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
            `subconcepto: ${pagoFinal.subconcepto ?? 'No detectado'}`,
            `concepto: ${pagoFinal.concepto ?? 'No detectado'}`,
            `responsable: ${pagoFinal.responsable ?? 'No detectado'}`,
            `responsable_pago: ${pagoFinal.responsablePago ?? 'No detectado'}`,
            `nomenclatura: ${nomenclatura ?? 'No se pudo construir (falta RUC o codigo_movimiento)'}`,
        ].join('\n')

        await flowDynamic(resumenFinal)
    })

// Flow hijo: respuesta SÍ → pide ubicación/fecha y acumula mensajes con timer propio
const campainSiFlow = addKeyword(EVENTS.ACTION)
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

// Flow hijo: respuesta NO → pregunta si desea asesor y acumula mensajes con timer propio
const campainNoFlow = addKeyword(EVENTS.ACTION)
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

// Flow principal unificado: captura botones de campaña y recordatorio_servicio
// Campaña: "Sí, programar" / "No, luego"
// Recordatorio: "Sí, programar visita" / "Tengo una consulta"
const campainResponseFlow = addKeyword(['Sí, programar', 'No, luego', 'Sí, programar visita', 'Tengo una consulta'])
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

// ========== FLOWS DE RECORDATORIO SERVICIO ==========

// Almacén temporal para datos de recordatorio por número
const recordatorioDataByNumber = {}

// Flow hijo: "Tengo una consulta" → captura mensajes con idle timer
const recordatorioConsultaFlow = addKeyword(EVENTS.ACTION)
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
                await providerRef.sendMessage(data.numero, '¡Gracias por tu consulta! Un asesor se comunicará contigo pronto. 📞', {})
                console.log(`[RECORDATORIO-CONSULTA] Despedida enviada a ${data.numero}`)
            } catch (err) {
                console.error(`[RECORDATORIO-CONSULTA] Error enviando despedida:`, err)
            }

            delete recordatorioDataByNumber[numberClean]
        })

        return fallBack()
    })

// ========== FLOWS DE INFORME – TEST ==========

// Número fijo para testing de informes
const NUMERO_TEST_INFORME = '51993011824'

// Flow que captura las respuestas de los botones de informe
const informeResponseFlow = addKeyword(['Ya lo envié', 'En proceso', 'Inconveniente', 'Ya regularicé', 'Justificación'])
    .addAction(async (ctx, { flowDynamic }) => {
        const respuesta = ctx.body.trim()
        console.log(`[INFORME] ${ctx.from} respondió: "${respuesta}"`)

        if (respuesta.includes('Ya lo envié') || respuesta.includes('Ya regularicé')) {
            await flowDynamic('✅ Gracias por confirmar. Tu respuesta ha sido registrada exitosamente.')
        } else if (respuesta.includes('En proceso')) {
            await flowDynamic('⏳ Entendido. Por favor indica la hora estimada de envío.')
        } else if (respuesta.includes('Inconveniente')) {
            await flowDynamic('⚠️ Entendido. Por favor especifica el inconveniente que presentas.')
        } else if (respuesta.includes('Justificación')) {
            await flowDynamic('📋 Entendido. Por favor envía tu justificación del retraso.')
        }
    })

// --- MAIN ---

const main = async () => {
    const adapterFlow = createFlow([
        startConversationFlow,
        campainResponseFlow,
        campainSiFlow,
        campainNoFlow,
        informeResponseFlow,
        recordatorioConsultaFlow,
    ])

    const adapterProvider = createProvider(Provider, {
        jwtToken: process.env.JWT_TOKEN,
        numberId: process.env.NUMBER_ID,
        verifyToken: process.env.VERIFY_TOKEN,
        version: 'v22.0',
    })
    // Guardar referencia global al provider para enviar mensajes desde timers
    providerRef = adapterProvider
    const adapterDB = new Database()

    // DEBUG: Interceptar TODAS las solicitudes entrantes
    adapterProvider.server.use((req, res, next) => {
        if (req.method === 'POST' && req.url.includes('webhook')) {
            console.log(`[DEBUG-WEBHOOK] ${req.method} ${req.url}`)
            console.log(`[DEBUG-WEBHOOK] Body:`, JSON.stringify(req.body, null, 2))
        }
        next()
    })

    // DEBUG: Log todos los mensajes entrantes del provider
    adapterProvider.on('message', (payload) => {
        console.log(`[DEBUG-MSG] Mensaje entrante:`, JSON.stringify(payload, null, 2))
    })

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        })
    )

    adapterProvider.server.post(
        '/v1/register',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('REGISTER_FLOW', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/samples',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('SAMPLES', { from: number, name })
            return res.end('trigger')
        })
    )

    // ========== ENDPOINTS DE CAMPAÑA ==========

    // Retail → template 'minor'
    adapterProvider.server.post(
        '/v1/campain/retail',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot, adapterProvider, req.body,
                    'Campaña Retail', 'minor'
                )
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify(result))
            } catch (error) {
                console.error(error)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // PL → template 'carrileria' (nombres cruzados en Meta) — tiene header IMAGE
    adapterProvider.server.post(
        '/v1/campain/pl',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot, adapterProvider, req.body,
                    'Campaña PL', 'carrileria',
                    FLYER_URL
                )
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify(result))
            } catch (error) {
                console.error(error)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // Carrilería → template 'pl' (nombres cruzados en Meta)
    adapterProvider.server.post(
        '/v1/campain/carrileria',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot, adapterProvider, req.body,
                    'Campaña Carrilería', 'pl'
                )
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify(result))
            } catch (error) {
                console.error(error)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // Test → template 'carrileria' (tiene header IMAGE)
    adapterProvider.server.post(
        '/v1/campain/test',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot, adapterProvider, req.body,
                    'Test', 'carrileria',
                    FLYER_URL
                )
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify(result))
            } catch (error) {
                console.error(error)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // ========== ENDPOINTS DE INFORME – TEST (número fijo) ==========

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

    // ========== ENDPOINT DE RECORDATORIO SERVICIO ==========

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

    // ========== ENDPOINT DE ALERTAS DE INFORME (desde GAS) ==========

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

                // Mapeo alerta → nombre de template en Meta
                const templateMap = {
                    '24h': 'alerta',
                    '36h': 'alerta_36h',
                    '48h': 'alerta_48h',
                }

                const resultados = []

                for (const [alerta, grupo] of Object.entries(grupos)) {
                    const templateName = templateMap[alerta]
                    if (!templateName) {
                        // Ignorar alertas sin template (ej: '0h' de nuevos ingresos)
                        console.log(`[INFORME-ALERTA] Alerta '${alerta}' ignorada (sin template asignado)`)
                        resultados.push({ alerta, status: 'ignorado', message: `Alerta '${alerta}' sin template` })
                        continue
                    }

                    const tecnico = grupo.tecnico || 'Técnico'

                    // alerta_36h tiene 3 params: {{1}}=tecnico, {{2}}=modelo, {{3}}=serie
                    // Template muestra "equipo {{2}}-{{3}}", así que repartimos los equipos
                    // concatenados entre {{2}} y {{3}} para que el guion de la plantilla una al último
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
                            const templateResult = await adapterProvider.sendTemplate(numberClean, templateName, 'es_PE', components)
                            if (templateResult instanceof Error) {
                                const detail = templateResult?.response?.data?.error
                                if (detail) { const err = new Error(detail.message || JSON.stringify(detail)); err.response = templateResult.response; throw err }
                                throw templateResult
                            }
                            if (templateResult?.error) throw new Error(templateResult.error.message || JSON.stringify(templateResult.error))

                            console.log(`[INFORME-ALERTA] Template '${templateName}' enviado a ${numberClean} (equipos: ${equiposLog})`)
                            resultados.push({ alerta, templateName, status: 'enviado', equipos: equiposLog })
                        } catch (err) {
                            console.error(`[INFORME-ALERTA] Error enviando '${templateName}' a ${numberClean}:`, err.message)
                            resultados.push({ alerta, templateName, status: 'error', equipos: equiposLog, message: err.message })
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
                        const templateResult = await adapterProvider.sendTemplate(numberClean, templateName, 'es_PE', components)

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

                        console.log(`[INFORME-ALERTA] Template '${templateName}' enviado a ${numberClean} (equipos: ${equiposStr})`)
                        resultados.push({ alerta, templateName, status: 'enviado', equipos: equiposStr })
                    } catch (err) {
                        console.error(`[INFORME-ALERTA] Error enviando '${templateName}' a ${numberClean}:`, err.message)
                        resultados.push({ alerta, templateName, status: 'error', message: err.message })
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

    // ========== ENDPOINTS DE BLACKLIST ==========

    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )

    adapterProvider.server.get(
        '/v1/blacklist/list',
        handleCtx(async (bot, req, res) => {
            const blacklist = bot.blacklist.getList()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', blacklist }))
        })
    )

    httpServer(+PORT)
}

main()
