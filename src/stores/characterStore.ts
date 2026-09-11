import { defineStore } from 'pinia'
import character_list from '@/utils/character_list'

type AnimationCategory = 'character' | 'ultimate' | 'dating'
export type CharacterDisplayMode = 'new' | 'updated'
export interface Character {
  id: string
  charName: string
  costumeName: string
  spine: string
  cutscene: string
  dating: string
  audio: string
  icon: string,
  matchedCharacterId?: string,
  displayMode?: CharacterDisplayMode,
  datingUsesTracks?: boolean,
  customFiles?: {
    skel?: string,
    json?: string,
    atlas: string,
    images: Record<string, string>
  },
  externalBackgrounds?: string[]
}

const characterArray: Character[] = Object.entries(character_list).map(([id, char]) => ({
  id,
  datingUsesTracks: false,
  icon: id,
  ...char,
}))

export const useCharacterStore = defineStore('characterStore', {
  state: () => ({
    characters: characterArray as Character[],
    selectedCharacterId: characterArray.length ? characterArray[0].id : '',
    selectedAnimation: '',
    selectedSkin: '',
    animationCategory: 'character' as AnimationCategory,
    playing: true,
    animationSpeed: 1,
    abLoopStart: null as number | null,
    abLoopEnd: null as number | null,
    playhead: 0,
    backgroundColor: '#4b4b4b',
    useCurrentCamera: false,
    customBackgroundImage: null as string | null,
    backgroundIsAuto: false,
    layerNames: [] as string[],
    layerVisibility: {} as Record<string, boolean>,
    layerSelectionEnabled: false as boolean,
    selectedLayerName: null as string | null,
    hiddenLayerStack: [] as string[],
  }),
})
