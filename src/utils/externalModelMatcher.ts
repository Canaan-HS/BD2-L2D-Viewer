import character_list from '@/utils/character_list'

export interface ExternalModelMatch {
  id: string
  charName: string
  costumeName: string
  spine: string
  audio: string
}

interface CostumeVariant {
  rawJoined: string
  normJoined: string
  tokens: string[]
}

interface IndexEntry {
  id: string
  charName: string
  costumeName: string
  spine: string
  audio: string
  charRawJoined: string
  charNormJoined: string
  charTokens: string[]
  costumes: CostumeVariant[]
}

interface CompiledIndex {
  rawMap: Map<string, IndexEntry[]>
  normMap: Map<string, IndexEntry[]>
  buckets: Map<number, IndexEntry[]>
  maxCharTokens: number
}

const SEPARATOR_RE = /[\s_\-\[\](){}|\\/.,·:;'"!?*&+~]+/
const FUZZY_THRESHOLD = 2

function splitName(value: string) {
  const rawParts = value.split(SEPARATOR_RE).filter(Boolean)
  return { rawParts, normParts: rawParts.map(part => part.toLowerCase()) }
}

function charDistanceCapped(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prevRow: number[] = []
  for (let j = 0; j <= b.length; j++) prevRow.push(Math.min(j, cap + 1))
  for (let i = 1; i <= a.length; i++) {
    const currRow: number[] = [Math.min(i, cap + 1)]
    let rowMin = currRow[0]
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(prevRow[j] + 1, currRow[j - 1] + 1, prevRow[j - 1] + substitutionCost)
      currRow.push(Math.min(value, cap + 1))
      if (value < rowMin) rowMin = value
    }
    if (rowMin > cap) return cap + 1
    prevRow = currRow
  }
  return prevRow[b.length]
}

// Substituting a word only costs 1 when the words themselves are near-identical
// (a typo / spelling variant). Completely different words cannot be substituted,
// otherwise every unrelated name would fuzzily match every character.
function tokenDistance(a: readonly string[], b: readonly string[]): number {
  if (!a.length) return b.length
  if (!b.length) return a.length

  const INF = Number.POSITIVE_INFINITY
  let prevRow: number[] = []
  for (let j = 0; j <= b.length; j++) prevRow.push(j)

  for (let i = 1; i <= a.length; i++) {
    const currRow: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const left = a[i - 1]
      const right = b[j - 1]
      let substitutionCost: number
      if (left === right) {
        substitutionCost = 0
      } else if (left && right && charDistanceCapped(left, right, FUZZY_THRESHOLD) <= FUZZY_THRESHOLD) {
        substitutionCost = 1
      } else {
        substitutionCost = INF
      }
      currRow.push(Math.min(prevRow[j] + 1, currRow[j - 1] + 1, prevRow[j - 1] + substitutionCost))
    }
    prevRow = currRow
  }
  const result = prevRow[b.length]
  return Number.isFinite(result) ? result : FUZZY_THRESHOLD + 1
}

function countCommonTokens(a: readonly string[], b: readonly string[]): number {
  const pool = new Set(b)
  const seen = new Set<string>()
  let count = 0
  for (const token of a) {
    if (pool.has(token) && !seen.has(token)) {
      seen.add(token)
      count++
    }
  }
  return count
}

let compiledIndex: CompiledIndex | null = null

function getIndex(): CompiledIndex {
  if (compiledIndex) return compiledIndex

  const rawMap = new Map<string, IndexEntry[]>()
  const normMap = new Map<string, IndexEntry[]>()
  const buckets = new Map<number, IndexEntry[]>()
  let maxCharTokens = 0

  for (const [id, char] of Object.entries(character_list)) {
    const { rawParts, normParts } = splitName(char.charName)
    if (!rawParts.length) continue

    const costumeSource = splitName(char.costumeName)
    const entry: IndexEntry = {
      id,
      charName: char.charName,
      costumeName: char.costumeName,
      spine: char.spine,
      audio: char.audio,
      charRawJoined: rawParts.join(''),
      charNormJoined: normParts.join(''),
      charTokens: [...normParts],
      costumes:
        costumeSource.rawParts.length > 0
          ? [
              {
                rawJoined: costumeSource.rawParts.join(''),
                normJoined: costumeSource.normParts.join(''),
                tokens: costumeSource.normParts,
              },
            ]
          : [],
    }

    const rawBucket = rawMap.get(entry.charRawJoined) ?? []
    rawBucket.push(entry)
    rawMap.set(entry.charRawJoined, rawBucket)

    const normBucket = normMap.get(entry.charNormJoined) ?? []
    normBucket.push(entry)
    normMap.set(entry.charNormJoined, normBucket)

    const sizeBucket = buckets.get(entry.charTokens.length) ?? []
    sizeBucket.push(entry)
    buckets.set(entry.charTokens.length, sizeBucket)

    maxCharTokens = Math.max(maxCharTokens, entry.charTokens.length)
  }

  compiledIndex = { rawMap, normMap, buckets, maxCharTokens }
  return compiledIndex
}

interface CharCandidates {
  entries: IndexEntry[]
  consumed: number
}

function matchExact(
  map: Map<string, IndexEntry[]>,
  parts: string[],
  maxWindow: number,
): CharCandidates | null {
  for (let len = maxWindow; len >= 1; len--) {
    const key = parts.slice(0, len).join('')
    const hits = map.get(key)
    if (hits?.length) return { entries: hits, consumed: len }
  }
  return null
}

function hasSimilarWord(a: readonly string[], b: readonly string[]): boolean {
  for (const left of a) {
    for (const right of b) {
      if (left === right) return true
      if (charDistanceCapped(left, right, FUZZY_THRESHOLD) <= FUZZY_THRESHOLD) return true
    }
  }
  return false
}

function matchFuzzy(index: CompiledIndex, tokens: string[], maxWindow: number): CharCandidates | null {
  let bestEntries: IndexEntry[] | null = null
  let bestConsumed = 0
  let bestDist = FUZZY_THRESHOLD + 1
  let bestCommon = -1
  let bestSize = Number.MAX_SAFE_INTEGER

  for (let len = maxWindow; len >= 1; len--) {
    const query = tokens.slice(0, len)
    const lowerBound = Math.max(1, len - FUZZY_THRESHOLD)
    const upperBound = len + FUZZY_THRESHOLD

    for (let size = lowerBound; size <= upperBound; size++) {
      for (const entry of index.buckets.get(size) ?? []) {
        if (!hasSimilarWord(query, entry.charTokens)) continue
        const dist = tokenDistance(query, entry.charTokens)
        if (dist > FUZZY_THRESHOLD || dist > bestDist) continue
        const common = countCommonTokens(query, entry.charTokens)
        const strictlyBetter =
          dist < bestDist ||
          (dist === bestDist && common > bestCommon) ||
          (dist === bestDist && common === bestCommon && size < bestSize)
        if (!strictlyBetter) continue
        bestDist = dist
        bestCommon = common
        bestSize = size
        bestEntries = [entry]
        bestConsumed = len
      }
    }
  }

  return bestEntries ? { entries: bestEntries, consumed: bestConsumed } : null
}

function resolveCostume(entries: IndexEntry[], restRaw: string[], restNorm: string[]): IndexEntry {
  const fallback = entries[0]
  if (!restNorm.length) return fallback

  for (let len = restNorm.length; len >= 1; len--) {
    for (let start = 0; start + len <= restNorm.length; start++) {
      const rawKey = restRaw.slice(start, start + len).join('')
      for (const entry of entries) {
        if (entry.costumes.some(costume => costume.rawJoined === rawKey)) return entry
      }
    }
  }

  for (let len = restNorm.length; len >= 1; len--) {
    for (let start = 0; start + len <= restNorm.length; start++) {
      const normKey = restNorm.slice(start, start + len).join('')
      for (const entry of entries) {
        if (entry.costumes.some(costume => costume.normJoined === normKey)) return entry
      }
    }
  }

  let bestEntry: IndexEntry | null = null
  let bestDist = FUZZY_THRESHOLD + 1
  let bestSize = Number.MAX_SAFE_INTEGER
  for (let len = restNorm.length; len >= 1; len--) {
    for (let start = 0; start + len <= restNorm.length; start++) {
      const query = restNorm.slice(start, start + len)
      for (const entry of entries) {
        for (const costume of entry.costumes) {
          if (!hasSimilarWord(query, costume.tokens)) continue
          const dist = tokenDistance(query, costume.tokens)
          if (dist > FUZZY_THRESHOLD) continue
          if (dist < bestDist || (dist === bestDist && costume.tokens.length < bestSize)) {
            bestDist = dist
            bestSize = costume.tokens.length
            bestEntry = entry
          }
        }
      }
    }
  }

  return bestEntry ?? fallback
}

export function matchExternalModel(modelName: string): ExternalModelMatch | null {
  const index = getIndex()
  const { rawParts, normParts } = splitName(modelName)
  if (!normParts.length) return null

  const maxWindow = Math.min(normParts.length, index.maxCharTokens + FUZZY_THRESHOLD)

  const candidates =
    matchExact(index.rawMap, rawParts, maxWindow) ??
    matchExact(index.normMap, normParts, maxWindow) ??
    matchFuzzy(index, normParts, maxWindow)
  if (!candidates) return null

  const chosen = resolveCostume(candidates.entries, rawParts.slice(candidates.consumed), normParts.slice(candidates.consumed))
  return {
    id: chosen.id,
    charName: chosen.charName,
    costumeName: chosen.costumeName,
    spine: chosen.spine,
    audio: chosen.audio,
  }
}
