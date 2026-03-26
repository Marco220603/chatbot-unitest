import dotenv from 'dotenv'
dotenv.config()

export const PORT = process.env.PORT ?? 3008
export const IDLE_TIMEOUT = 35000 // 35 segundos de inactividad
export const GEMINI_APIKEY = process.env.GEMINI_APIKEY
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
export const DEBUG_AI = String(process.env.DEBUG_AI ?? 'false').toLowerCase() === 'true'
export const RUC_EMPRESA = process.env.RUC_EMPRESA ?? process.env.EMPRESA_RUC ?? null
export const MAX_META_LIST_ROWS = 10
export const TIPO_CAMBIO_USD_PEN = Number(process.env.TIPO_CAMBIO_USD_PEN ?? process.env.TIPO_CAMBIO ?? 3.8)
export const JWT_TOKEN = process.env.JWT_TOKEN
export const NUMBER_ID = process.env.NUMBER_ID
export const VERIFY_TOKEN = process.env.VERIFY_TOKEN
