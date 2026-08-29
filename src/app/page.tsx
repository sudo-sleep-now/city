'use client'

import dynamic from 'next/dynamic'

const CityExperience = dynamic(() => import('@/components/city/CityExperience'), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 bg-[#0a120c] flex items-center justify-center">
      <p className="text-emerald-500/70 animate-pulse">Starting Solheim…</p>
    </div>
  ),
})

export default function Home() {
  return <CityExperience />
}
