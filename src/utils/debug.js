import { DEBUG_AI } from '../config/env.js'

export const debugAiLog = (label, payload) => {
    if (!DEBUG_AI) return
    console.log(`[AI-DEBUG] ${label}:`, payload)
}
