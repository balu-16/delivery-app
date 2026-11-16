import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIState {
  sidebarCollapsed: boolean
  commandOpen: boolean
  mobileNavOpen: boolean
  setCommandOpen: (v: boolean) => void
  toggleSidebar: () => void
  setMobileNavOpen: (v: boolean) => void
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      commandOpen: false,
      mobileNavOpen: false,
      setCommandOpen: (v) => set({ commandOpen: v }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setMobileNavOpen: (v) => set({ mobileNavOpen: v }),
    }),
    { name: 'dairydirect-ui-v1', partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed }) },
  ),
)
