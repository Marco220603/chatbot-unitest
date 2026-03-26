import { PROYECTOS_URL, USUARIOS_ACTIVOS_URL, SUCURSALES_URL, SUBCONCEPTOS_URL_CANDIDATAS } from '../config/urls.js'
import { toNullableText } from '../utils/text.js'
import { dedupe, getArrayData } from '../utils/array.js'
import { fetchJsonSafe } from '../utils/json.js'
import { parseConceptosSubconceptos } from './subconcepto.js'

export const fetchSubconceptosCatalog = async () => {
    for (const url of SUBCONCEPTOS_URL_CANDIDATAS) {
        const payload = await fetchJsonSafe(url)
        const data = parseConceptosSubconceptos(payload)
        if (data.length) return data
    }

    return []
}

export const fetchPaymentCatalogs = async () => {
    const warnings = []

    const [proyectosPayload, usuariosPayload, provinciasPayload, subconceptos] = await Promise.all([
        fetchJsonSafe(PROYECTOS_URL),
        fetchJsonSafe(USUARIOS_ACTIVOS_URL),
        fetchJsonSafe(SUCURSALES_URL),
        fetchSubconceptosCatalog(),
    ])

    const proyectos = dedupe(getArrayData(proyectosPayload).map((item) => toNullableText(item)).filter(Boolean))
    
    // La API getUsuariosActivos retorna: { message, data: { resultado[], responsablesCompra[], responsablesPago[] } }
    // Soportar ambos formatos: datos en raíz (legacy) o dentro de .data (actual)
    const usuariosData = usuariosPayload?.data ?? usuariosPayload
    const rawUsuarios = Array.isArray(usuariosData?.resultado) ? usuariosData.resultado : getArrayData(usuariosPayload)
    const rawResponsables = Array.isArray(usuariosData?.responsablesCompra) ? usuariosData.responsablesCompra : rawUsuarios
    const rawResponsablesPago = Array.isArray(usuariosData?.responsablesPago) ? usuariosData.responsablesPago : rawUsuarios

    const usuarios = dedupe(rawUsuarios.map((item) => toNullableText(item)).filter(Boolean))
    const responsables = dedupe(rawResponsables.map((item) => toNullableText(item)).filter(Boolean))
    const responsablesPago = dedupe(rawResponsablesPago.map((item) => toNullableText(item)).filter(Boolean))

    const provincias = dedupe(getArrayData(provinciasPayload).map((item) => toNullableText(item)).filter(Boolean))

    if (!proyectos.length) warnings.push('No se pudo cargar la lista de proyectos.')
    if (!usuarios.length) warnings.push('No se pudo cargar la lista de usuarios activos.')
    if (!provincias.length) warnings.push('No se pudo cargar la lista de provincias/sucursales.')
    if (!subconceptos.length) warnings.push('No se pudo cargar la lista de subconceptos.')

    return { proyectos, usuarios, responsables, responsablesPago, provincias, subconceptos, warnings }
}
