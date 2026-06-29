import { ConvexProvider, ConvexReactClient } from 'convex/react'

const CONVEX_URL = (import.meta as any).env.VITE_CONVEX_URL as string
if (!CONVEX_URL) {
  console.error('[Convex] missing env VITE_CONVEX_URL')
}

const convexClient = new ConvexReactClient(CONVEX_URL)

export default function AppConvexProvider({ children }: { children: React.ReactNode }) {
  return <ConvexProvider client={convexClient}>{children}</ConvexProvider>
}
