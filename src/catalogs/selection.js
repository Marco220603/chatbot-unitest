import { normalizeText, toNullableText, cutText } from '../utils/text.js'
import { dedupe } from '../utils/array.js'

export const buildStringSelectionCatalog = (items = [], prefix = 'OPT') => {
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

    return { rows, byId, byNormalized, items: cleaned, count: cleaned.length }
}

export const resolveSelection = (input, catalog) => {
    const text = toNullableText(input)
    if (!text || !catalog) return null

    const byId = catalog.byId ?? {}
    const byNormalized = catalog.byNormalized ?? {}

    return byId[text] ?? byNormalized[normalizeText(text)] ?? null
}

// --- Listas enumeradas por texto plano ---

/**
 * Formatea un array de strings como lista enumerada:
 * "1. Item A\n2. Item B\n3. Item C"
 */
export const formatNumberedList = (items = []) => {
    return items.map((item, i) => `${i + 1}. ${item}`).join('\n')
}

/**
 * Envía una lista enumerada por flowDynamic, dividida en chunks
 * para no exceder el límite de caracteres de WhatsApp (~4000 chars seguros).
 */
export const sendNumberedListChunked = async (items = [], flowDynamic, { maxCharsPerMsg = 3500, header = '' } = {}) => {
    if (!items.length) return

    const lines = items.map((item, i) => `${i + 1}. ${item}`)
    const fullList = lines.join('\n')

    // Si header + lista caben en un solo mensaje, enviar todo junto (1 sola llamada HTTP)
    if (header) {
        const combined = `${header}\n${fullList}`
        if (combined.length <= maxCharsPerMsg) {
            await flowDynamic([{ body: combined, delay: 0 }])
            return
        }
        // Si no cabe junto, enviar header primero
        await flowDynamic([{ body: header, delay: 0 }])
    }

    // Fragmentar la lista en chunks si es necesario
    const chunks = []
    let current = ''

    for (const line of lines) {
        if (current.length + line.length + 1 > maxCharsPerMsg && current.length > 0) {
            chunks.push(current)
            current = ''
        }
        current += (current ? '\n' : '') + line
    }
    if (current) chunks.push(current)

    for (const chunkText of chunks) {
        await flowDynamic([{ body: chunkText, delay: 0 }])
    }
}

/**
 * Resuelve la selección del usuario por número (1-indexed).
 * Retorna el valor del item si el número es válido, o null si no.
 */
export const resolveNumberedSelection = (input, items = []) => {
    const text = String(input ?? '').trim()
    const num = parseInt(text, 10)

    if (isNaN(num) || num < 1 || num > items.length) return null

    return items[num - 1]
}
