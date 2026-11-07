import { create } from 'zustand'

export const WORKSPACES = [
  'overview',
  'manuscript',
  'outline',
  'bible',
  'studio',
  'review',
  'memory',
  'analytics',
  'publish',
  'settings',
] as const
export type Workspace = (typeof WORKSPACES)[number]

export interface StudioState {
  workspace: Workspace
  chapter: number
  selectedArtifactId: string | null
  selectedFindingId: string | null
  inspector: string
  paletteOpen: boolean
  root: string
  sseConnected: boolean
  sseSeq: number
  setWorkspace: (workspace: Workspace) => void
  setChapter: (chapter: number) => void
  selectArtifact: (id: string | null) => void
  selectFinding: (id: string | null) => void
  setInspector: (text: string) => void
  setPaletteOpen: (open: boolean) => void
  setRoot: (root: string) => void
  setSse: (connected: boolean, seq?: number) => void
}

export const useStudio = create<StudioState>((set) => ({
  workspace: 'overview',
  chapter: 1,
  selectedArtifactId: null,
  selectedFindingId: null,
  inspector: '',
  paletteOpen: false,
  root: '',
  sseConnected: false,
  sseSeq: 0,
  setWorkspace: (workspace) => set({ workspace }),
  setChapter: (chapter) => set({ chapter }),
  selectArtifact: (selectedArtifactId) => set({ selectedArtifactId }),
  selectFinding: (selectedFindingId) => set({ selectedFindingId }),
  setInspector: (inspector) => set({ inspector }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setRoot: (root) => set({ root }),
  setSse: (sseConnected, sseSeq) => set((state) => ({ sseConnected, sseSeq: sseSeq ?? state.sseSeq })),
}))
