const APPS_SCRIPT_CATALOG_BASE_URL = 'https://script.google.com/macros/s/AKfycbwNFEY1YuVf31jVZGviZcKB9ruogmXknVfRatJjZBttlEldcdoTTLtQU4Ddp55jPWCVmg/exec'

export const PROYECTOS_URL = `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getProyectos`
export const USUARIOS_ACTIVOS_URL = `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getUsuariosActivos`
export const SUCURSALES_URL = `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getSucursal`
export const CONCEPTO_SUBCONCEPTO_URL = `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getConceptoSubconcepto`
export const REGISTRAR_GASTO_URL = `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=registrarGasto`

export const SUBCONCEPTOS_URL_CANDIDATAS = [
    process.env.SUBCONCEPTOS_URL,
    CONCEPTO_SUBCONCEPTO_URL,
    `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getConceptosSubconceptos`,
    `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getConceptosYSubconceptos`,
    `${APPS_SCRIPT_CATALOG_BASE_URL}?endpoint=getSubconceptos`,
].filter(Boolean)

// URL del webhook de Google Apps Script para registrar envíos
export const GOOGLE_SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwksLwMI7M-RgphlPYYz9EXunhDJluNN1RBQ-nS5j71Nqf2HituNqlNvQo2XOjqe-Xf/exec'

// URL pública del flyer para campañas con imagen (PL)
export const FLYER_URL = 'https://drive.google.com/uc?export=download&id=1IQBdGczI-DIBrlrIRl4RRUZq5QmJdFCK'
