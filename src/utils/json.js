export const extractJsonFromText = (value = '') => {
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

export const fetchJsonSafe = async (url) => {
    try {
        const response = await fetch(url)
        if (!response.ok) return null
        return await response.json()
    } catch {
        return null
    }
}
