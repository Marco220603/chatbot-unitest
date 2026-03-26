import { normalizeText, toNullableText, cutText } from '../utils/text.js'
import { getArrayData } from '../utils/array.js'

export const parseConceptosSubconceptos = (payload) => {
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

export const buildSubconceptoSelectionCatalog = (items = []) => {
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

/**
 * Agrupa los items de subconceptos por concepto.
 * Retorna:
 *   conceptos: string[] — lista única de conceptos (para listar enumerados)
 *   byConcepto: { [concepto]: string[] } — subconceptos agrupados por concepto
 */
export const buildConceptoGroupedCatalog = (items = []) => {
    const conceptosOrdenados = []
    const byConcepto = {}

    for (const item of items) {
        const concepto = toNullableText(item?.concepto)
        const subconcepto = toNullableText(item?.subconcepto)
        if (!concepto || !subconcepto) continue

        if (!byConcepto[concepto]) {
            byConcepto[concepto] = []
            conceptosOrdenados.push(concepto)
        }

        if (!byConcepto[concepto].includes(subconcepto)) {
            byConcepto[concepto].push(subconcepto)
        }
    }

    return { conceptos: conceptosOrdenados, byConcepto }
}

