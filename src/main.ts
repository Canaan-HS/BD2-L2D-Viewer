import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { useCharacterStore } from '@/stores/characterStore'
import { applyUrlParams } from '@/utils/urlSync'
import { loadExternalModels } from '@/utils/externalModels'
import App from './App.vue'

const pinia = createPinia()
const store = useCharacterStore(pinia)
applyUrlParams(store, window.location.search)
void loadExternalModels(store.characters)

const app = createApp(App)
app.use(pinia)
app.mount('#app')
