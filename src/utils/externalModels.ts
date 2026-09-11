import type { Character } from '@/stores/characterStore'
import { matchExternalModel } from '@/utils/externalModelMatcher'

interface ExternalModelEntry {
  id: string
  name: string
  atlas: string
  skel: string | null
  json: string | null
  images: string[]
  backgrounds?: string[]
}

function buildExternalCharacter(model: ExternalModelEntry): Character {
  const baseUrl = `/external-models/file/${encodeURIComponent(model.id)}/`
  const fileUrl = (fileName: string) => baseUrl + encodeURIComponent(fileName)
  const backgroundUrl = (relativePath: string) =>
    baseUrl + relativePath.split('/').map(encodeURIComponent).join('/')
  const match = matchExternalModel(model.name)

  return {
    id: crypto.randomUUID(), // 這會影響到判斷是否為同一個物件, 原始項目使用 Date.now(), 這在本地讀取時可能會有問題
    charName: model.name,
    costumeName: match?.costumeName ?? '',
    spine: match?.spine ?? '',
    cutscene: '',
    dating: '',
    audio: match?.audio ?? '',
    icon: match?.id ?? '',
    ...(match ? { matchedCharacterId: match.id } : null),
    ...(model.backgrounds?.length ? { externalBackgrounds: model.backgrounds.map(backgroundUrl) } : null),
    customFiles: {
      ...(model.skel ? { skel: fileUrl(model.skel) } : null),
      ...(model.json ? { json: fileUrl(model.json) } : null),
      atlas: fileUrl(model.atlas),
      images: Object.fromEntries(model.images.map(pageName => [baseUrl + pageName, fileUrl(pageName)])),
    },
  }
}

export async function loadExternalModels(characters: Character[]): Promise<void> {
  try {
    const response = await fetch('/external-models/list')
    if (!response.ok) return

    const models = (await response.json()) as ExternalModelEntry[]
    if (!Array.isArray(models) || models.length === 0) return

    characters.push(...models.map(buildExternalCharacter))
    console.info(`[external-models] Loaded ${models.length} external model${models.length === 1 ? '' : 's'}.`)
  } catch {
    // The endpoint only exists while serving through `pnpm dev`; silently skip elsewhere.
  }
}
