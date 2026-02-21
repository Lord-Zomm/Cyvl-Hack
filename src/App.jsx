import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { GeoJSON, MapContainer, ScaleControl, TileLayer, useMap, useMapEvents } from 'react-leaflet'

const BROOKLINE_CENTER = [42.3318, -71.1212]
const BROOKLINE_ZOOM = 13
const BAD_LABELS = new Set(['Poor', 'Very Poor', 'Serious', 'Failed'])

const TILE_LAYERS = {
  street: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>'
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>'
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr: '&copy; Esri'
  },
  topo: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attr: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
  }
}

const WEIGHTS = { thin: 3, normal: 5, bold: 8 }
const OPACITIES = { light: 0.45, medium: 0.7, full: 1 }

const GRADES = [
  { key: 'good', label: 'Good', range: '> 55', color: '#16a34a', dotClass: 'c1' },
  { key: 'fair', label: 'Fair', range: '41–55', color: '#ca8a04', dotClass: 'c2' },
  { key: 'poor', label: 'Poor', range: '31–40', color: '#ea580c', dotClass: 'c3' },
  { key: 'critical', label: 'Critical', range: '≤ 30', color: '#dc2626', dotClass: 'c4' }
]

const SORT_OPTIONS = [
  { key: 'score', label: 'Score' },
  { key: 'name', label: 'Name' },
  { key: 'length', label: 'Length' },
  { key: 'width', label: 'Width' }
]

const SHORTCUTS = [
  ['D', 'Toggle dark mode'],
  ['F', 'Toggle fullscreen'],
  ['[', 'Collapse sidebar'],
  ['↑ / ↓', 'Navigate roads'],
  ['Enter', 'Select road'],
  ['Esc', 'Close / deselect'],
  ['T', 'Start / stop tour'],
  ['C', 'Compare mode'],
  ['E', 'Export CSV'],
  ['?', 'Show shortcuts']
]

function formatScore(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'N/A'
  return score.toFixed(2)
}

function scoreToRoadColor(score) {
  const s = typeof score === 'number' ? score : 0
  if (s <= 30) return '#dc2626'
  if (s <= 40) return '#ea580c'
  if (s <= 55) return '#ca8a04'
  return '#16a34a'
}

function scoreToBadgeTone(score) {
  const s = typeof score === 'number' ? score : 0
  if (s <= 30) return 'critical'
  if (s <= 40) return 'high'
  if (s <= 55) return 'medium'
  return 'low'
}

function getGradeKey(score) {
  if (typeof score !== 'number') return null
  if (score <= 30) return 'critical'
  if (score <= 40) return 'poor'
  if (score <= 55) return 'fair'
  return 'good'
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const R = 6371000
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function getPanoramaPoints(panoramaGeojson) {
  if (!panoramaGeojson?.features) return []
  return panoramaGeojson.features
    .map((f) => {
      const coords = f?.geometry?.coordinates
      const props = f?.properties || {}
      if (!Array.isArray(coords) || coords.length < 2) return null
      return {
        lng: Number(coords[0]),
        lat: Number(coords[1]),
        imageUrl: props.image_url || '',
        id: props.id || ''
      }
    })
    .filter((x) => x && Number.isFinite(x.lat) && Number.isFinite(x.lng) && x.imageUrl)
}

function findNearestPanorama(clickLat, clickLng, panoramaPoints) {
  let nearest = null
  let minDist = Infinity
  for (const p of panoramaPoints) {
    const d = haversineMeters(clickLat, clickLng, p.lat, p.lng)
    if (d < minDist) {
      minDist = d
      nearest = p
    }
  }
  if (!nearest) return null
  return { ...nearest, distanceMeters: minDist }
}

function getSegmentId(props) {
  return props?.client_seg || props?.facilityid || props?.OB_Name || props?.Name || ''
}

function getFeatureCenter(feature) {
  const geom = feature?.geometry
  if (!geom) return null
  let coords = []
  if (geom.type === 'LineString') coords = geom.coordinates
  else if (geom.type === 'MultiLineString') coords = geom.coordinates[0] || []
  if (coords.length === 0) return null
  const mid = coords[Math.floor(coords.length / 2)]
  return { lat: mid[1], lng: mid[0] }
}

function buildSelectedSegment(feature, nearestPanorama, clickLatLng) {
  const p = feature?.properties || {}
  return {
    id: getSegmentId(p),
    name: p.Name || p.OB_Name || 'Unknown road',
    facilityId: p.facilityid || 'N/A',
    clientSeg: p.client_seg || 'N/A',
    fromStreet: p.From_ST || 'N/A',
    toStreet: p.To_Street || 'N/A',
    accepted: p.Accepted || 'N/A',
    material: p.Pave_MatLG || 'N/A',
    width: p.Width || 'N/A',
    shapeLength: typeof p.Shape_Leng === 'number' ? p.Shape_Leng : null,
    score: typeof p.score === 'number' ? p.score : null,
    label: p.label || 'N/A',
    nearestPanorama,
    clickLatLng
  }
}

function popupHtmlForFeature(selected) {
  const pano = selected?.nearestPanorama
  if (!pano) {
    return `
      <div class="popup-card">
        <div class="popup-road">${selected?.name || 'Road segment'}</div>
        <div class="popup-note">No panorama nearby</div>
      </div>
    `
  }
  return `
    <div class="popup-card">
      <div class="popup-road">${selected?.name || 'Road segment'}</div>
      <div class="popup-iframe-wrap">
        <iframe class="popup-iframe" src="${pano.imageUrl}" loading="lazy"></iframe>
      </div>
      <div class="popup-note">${Math.round(pano.distanceMeters)} m from click</div>
      <a class="popup-action" href="${pano.imageUrl}" target="_blank" rel="noopener noreferrer">Open panorama</a>
    </div>
  `
}

function exportVisibleCSV(features) {
  const headers = ['Name', 'From', 'To', 'PCI Score', 'Label', 'Material', 'Width', 'Length (ft)', 'Facility ID']
  const rows = features.map((f) => {
    const p = f?.properties || {}
    return [
      p.Name || p.OB_Name || '',
      p.From_ST || '',
      p.To_Street || '',
      p.score ?? '',
      p.label || '',
      p.Pave_MatLG || '',
      p.Width || '',
      p.Shape_Leng ? p.Shape_Leng.toFixed(2) : '',
      p.facilityid || ''
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`)
  })
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'road-health-export.csv'
  a.click()
  URL.revokeObjectURL(url)
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function FullscreenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
}

function ExitFullscreenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
}

function MapController({ flyTarget, mapRef }) {
  const map = useMap()
  const prevTarget = useRef(null)

  useEffect(() => {
    mapRef.current = map
    return () => { mapRef.current = null }
  }, [map, mapRef])

  useEffect(() => {
    if (flyTarget && flyTarget !== prevTarget.current) {
      prevTarget.current = flyTarget
      map.flyTo([flyTarget.lat, flyTarget.lng], 17, { duration: 1.2 })
    }
  }, [flyTarget, map])

  return null
}

function MapClickReset({ onClear, suppressRef }) {
  useMapEvents({
    click() {
      if (suppressRef.current) { suppressRef.current = false; return }
      onClear()
    }
  })
  return null
}

export default function App() {
  const [rollupData, setRollupData] = useState(null)
  const [panoramaData, setPanoramaData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [filterMode, setFilterMode] = useState('bad')
  const [selectedSegment, setSelectedSegment] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mapStyle, setMapStyle] = useState('street')
  const [roadWeight, setRoadWeight] = useState('normal')
  const [roadOpacity, setRoadOpacity] = useState('full')
  const [searchQuery, setSearchQuery] = useState('')
  const [flyTarget, setFlyTarget] = useState(null)

  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('rhv-dark') === 'true')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [scoreRange, setScoreRange] = useState([0, 100])
  const [sortBy, setSortBy] = useState('score')
  const [sortAsc, setSortAsc] = useState(true)
  const [materialFilters, setMaterialFilters] = useState(new Set())
  const [fullscreen, setFullscreen] = useState(false)
  const [hiddenGrades, setHiddenGrades] = useState(new Set())
  const [comparisonMode, setComparisonMode] = useState(false)
  const [comparisonSegment, setComparisonSegment] = useState(null)
  const [tourActive, setTourActive] = useState(false)
  const [tourIndex, setTourIndex] = useState(0)
  const [statsExpanded, setStatsExpanded] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [activeRankIndex, setActiveRankIndex] = useState(-1)
  const [shareToast, setShareToast] = useState(false)

  const geoJsonRef = useRef(null)
  const suppressMapClearRef = useRef(false)
  const mapRef = useRef(null)
  const comparisonModeRef = useRef(false)
  const selectedSegmentRef = useRef(null)
  const rankListRef = useRef(null)

  useEffect(() => { comparisonModeRef.current = comparisonMode }, [comparisonMode])
  useEffect(() => { selectedSegmentRef.current = selectedSegment }, [selectedSegment])

  useEffect(() => {
    let cancelled = false
    async function loadData() {
      try {
        setLoading(true)
        setError('')
        const [rollupRes, panoRes] = await Promise.all([
          fetch('/data/brookline/rollup.geojson'),
          fetch('/data/brookline/panoramicImagery.geojson')
        ])
        if (!rollupRes.ok) throw new Error(`Failed to load rollup.geojson (${rollupRes.status})`)
        if (!panoRes.ok) throw new Error(`Failed to load panoramicImagery.geojson (${panoRes.status})`)
        const [rollupJson, panoJson] = await Promise.all([rollupRes.json(), panoRes.json()])
        if (!cancelled) { setRollupData(rollupJson); setPanoramaData(panoJson) }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadData()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    localStorage.setItem('rhv-dark', darkMode)
  }, [darkMode])

  const allFeatures = useMemo(() => rollupData?.features || [], [rollupData])
  const panoramaPoints = useMemo(() => getPanoramaPoints(panoramaData), [panoramaData])

  const materials = useMemo(() => {
    const mats = new Set()
    allFeatures.forEach((f) => {
      const m = f?.properties?.Pave_MatLG
      if (m) mats.add(m)
    })
    return [...mats].sort()
  }, [allFeatures])

  const visibleFeatures = useMemo(() => {
    return allFeatures.filter((f) => {
      const p = f?.properties || {}
      const s = p.score
      if (typeof s !== 'number') return false
      if (filterMode === 'bad' && !BAD_LABELS.has(p.label)) return false
      if (s < scoreRange[0] || s > scoreRange[1]) return false
      const gk = getGradeKey(s)
      if (gk && hiddenGrades.has(gk)) return false
      if (materialFilters.size > 0 && !materialFilters.has(p.Pave_MatLG)) return false
      return true
    })
  }, [allFeatures, filterMode, scoreRange, hiddenGrades, materialFilters])

  const visibleGeoJson = useMemo(() => {
    if (!rollupData) return null
    return { ...rollupData, features: visibleFeatures }
  }, [rollupData, visibleFeatures])

  const stats = useMemo(() => {
    const visibleScores = visibleFeatures.map((f) => f?.properties?.score).filter((v) => typeof v === 'number')
    const avgVisible = visibleScores.length ? visibleScores.reduce((a, b) => a + b, 0) / visibleScores.length : 0
    const criticalCount = allFeatures.filter((f) => {
      const s = f?.properties?.score
      return typeof s === 'number' && s <= 40
    }).length
    return { visibleSegments: visibleFeatures.length, avgVisible, criticalCount }
  }, [allFeatures, visibleFeatures])

  const gradeDistribution = useMemo(() => {
    const counts = { good: 0, fair: 0, poor: 0, critical: 0 }
    const totalLength = { good: 0, fair: 0, poor: 0, critical: 0 }
    allFeatures.forEach((f) => {
      const p = f?.properties || {}
      const gk = getGradeKey(p.score)
      if (gk) {
        counts[gk]++
        totalLength[gk] += (typeof p.Shape_Leng === 'number' ? p.Shape_Leng : 0)
      }
    })
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    const totalLen = Object.values(totalLength).reduce((a, b) => a + b, 0)
    return { counts, totalLength, total, totalLen }
  }, [allFeatures])

  const donutSegments = useMemo(() => {
    const { counts, total } = gradeDistribution
    if (total === 0) return ''
    let cum = 0
    const parts = GRADES.map((g) => {
      const start = cum
      const deg = (counts[g.key] / total) * 360
      cum += deg
      return `${g.color} ${start}deg ${cum}deg`
    })
    return `conic-gradient(${parts.join(', ')})`
  }, [gradeDistribution])

  const sortedSegments = useMemo(() => {
    const scored = allFeatures
      .filter((f) => typeof f?.properties?.score === 'number')
      .map((f) => {
        const p = f.properties
        return {
          id: getSegmentId(p),
          name: p.Name || p.OB_Name || 'Unknown road',
          fromStreet: p.From_ST || 'N/A',
          toStreet: p.To_Street || 'N/A',
          label: p.label || 'N/A',
          score: p.score,
          width: p.Width ? Number(p.Width) : 0,
          length: typeof p.Shape_Leng === 'number' ? p.Shape_Leng : 0,
          center: getFeatureCenter(f),
          feature: f
        }
      })

    scored.sort((a, b) => {
      let cmp = 0
      if (sortBy === 'score') cmp = a.score - b.score
      else if (sortBy === 'name') cmp = a.name.localeCompare(b.name)
      else if (sortBy === 'length') cmp = b.length - a.length
      else if (sortBy === 'width') cmp = b.width - a.width
      return sortAsc ? cmp : -cmp
    })

    return scored.slice(0, 50)
  }, [allFeatures, sortBy, sortAsc])

  const filteredSegments = useMemo(() => {
    if (!searchQuery.trim()) return sortedSegments
    const q = searchQuery.toLowerCase()
    return sortedSegments.filter((item) =>
      item.name.toLowerCase().includes(q) ||
      item.fromStreet.toLowerCase().includes(q) ||
      item.toStreet.toLowerCase().includes(q)
    )
  }, [sortedSegments, searchQuery])

  const selectedSegmentId = selectedSegment?.id || ''
  const comparisonSegmentId = comparisonSegment?.id || ''

  const effectiveTileKey = darkMode && mapStyle === 'street' ? 'dark' : mapStyle
  const tile = TILE_LAYERS[effectiveTileKey] || TILE_LAYERS.street

  useEffect(() => {
    if (!tourActive || sortedSegments.length === 0) return
    const item = sortedSegments[tourIndex % sortedSegments.length]
    if (item.center) setFlyTarget({ ...item.center, _t: Date.now() })
    const nearest = findNearestPanorama(item.center?.lat || 0, item.center?.lng || 0, panoramaPoints)
    setSelectedSegment(buildSelectedSegment(item.feature, nearest, item.center))
    setActiveRankIndex(tourIndex)

    const timer = setTimeout(() => {
      const next = tourIndex + 1
      if (next >= Math.min(sortedSegments.length, 12)) {
        setTourActive(false)
        setTourIndex(0)
      } else {
        setTourIndex(next)
      }
    }, 4000)
    return () => clearTimeout(timer)
  }, [tourActive, tourIndex, sortedSegments, panoramaPoints])

  useEffect(() => {
    function handleKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

      if (e.key === 'd' || e.key === 'D') { setDarkMode((p) => !p); return }
      if (e.key === 'f') { setFullscreen((p) => !p); return }
      if (e.key === '[') { setSidebarCollapsed((p) => !p); return }
      if (e.key === 't' || e.key === 'T') {
        setTourActive((p) => {
          if (!p) setTourIndex(0)
          return !p
        })
        return
      }
      if (e.key === 'c') {
        setComparisonMode((p) => {
          if (p) setComparisonSegment(null)
          return !p
        })
        return
      }
      if (e.key === 'e') { exportVisibleCSV(visibleFeatures); return }
      if (e.key === '?') { e.preventDefault(); setShortcutsOpen((p) => !p); return }
      if (e.key === 'Escape') {
        if (shortcutsOpen) { setShortcutsOpen(false); return }
        if (fullscreen) { setFullscreen(false); return }
        if (tourActive) { setTourActive(false); return }
        if (comparisonMode) { setComparisonMode(false); setComparisonSegment(null); return }
        setSelectedSegment(null)
        setActiveRankIndex(-1)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveRankIndex((p) => Math.min(p + 1, filteredSegments.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveRankIndex((p) => Math.max(p - 1, 0))
        return
      }
      if (e.key === 'Enter' && activeRankIndex >= 0 && activeRankIndex < filteredSegments.length) {
        handleRankClick(filteredSegments[activeRankIndex])
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [visibleFeatures, filteredSegments, activeRankIndex, shortcutsOpen, fullscreen, tourActive, comparisonMode])

  useEffect(() => {
    if (activeRankIndex >= 0 && rankListRef.current) {
      const items = rankListRef.current.querySelectorAll('.rank-item')
      if (items[activeRankIndex]) {
        items[activeRankIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
  }, [activeRankIndex])

  useEffect(() => {
    if (shareToast) {
      const t = setTimeout(() => setShareToast(false), 2000)
      return () => clearTimeout(t)
    }
  }, [shareToast])

  const toggleDarkMode = useCallback(() => setDarkMode((p) => !p), [])
  const toggleGrade = useCallback((key) => {
    setHiddenGrades((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleMaterial = useCallback((mat) => {
    setMaterialFilters((prev) => {
      const next = new Set(prev)
      if (next.has(mat)) next.delete(mat)
      else next.add(mat)
      return next
    })
  }, [])

  const handleRankClick = useCallback((item) => {
    if (item.center) setFlyTarget({ lat: item.center.lat, lng: item.center.lng, _t: Date.now() })
    const nearest = findNearestPanorama(item.center?.lat || 0, item.center?.lng || 0, panoramaPoints)
    const seg = buildSelectedSegment(item.feature, nearest, item.center)
    if (comparisonModeRef.current && selectedSegmentRef.current) {
      setComparisonSegment(seg)
    } else {
      setSelectedSegment(seg)
    }
  }, [panoramaPoints])

  const handleShare = useCallback(() => {
    const params = new URLSearchParams()
    if (darkMode) params.set('dm', '1')
    params.set('f', filterMode)
    if (scoreRange[0] !== 0 || scoreRange[1] !== 100) params.set('sr', `${scoreRange[0]}-${scoreRange[1]}`)
    if (mapStyle !== 'street') params.set('ms', mapStyle)
    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`
    navigator.clipboard.writeText(url).then(() => setShareToast(true))
  }, [darkMode, filterMode, scoreRange, mapStyle])

  const handleAnalyzeViewport = useCallback(() => {
    if (!mapRef.current) return
    const bounds = mapRef.current.getBounds()
    const inView = allFeatures.filter((f) => {
      const center = getFeatureCenter(f)
      if (!center) return false
      return bounds.contains([center.lat, center.lng])
    })
    const scores = inView.map((f) => f?.properties?.score).filter((s) => typeof s === 'number')
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    const worst = scores.length ? Math.min(...scores) : 0
    const best = scores.length ? Math.max(...scores) : 0
    const critical = scores.filter((s) => s <= 40).length
    alert(`Viewport Analysis:\n${scores.length} segments in view\nAvg PCI: ${avg.toFixed(1)}\nBest: ${best.toFixed(1)}\nWorst: ${worst.toFixed(1)}\nCritical (≤40): ${critical}`)
  }, [allFeatures])

  const startTour = useCallback(() => {
    setComparisonMode(false)
    setComparisonSegment(null)
    setTourIndex(0)
    setTourActive(true)
  }, [])

  const styleFeature = useCallback((feature) => {
    const p = feature?.properties || {}
    const id = getSegmentId(p)
    const isSelected = selectedSegmentId && id === selectedSegmentId
    const isComparison = comparisonSegmentId && id === comparisonSegmentId
    return {
      color: scoreToRoadColor(p.score),
      weight: (isSelected || isComparison) ? WEIGHTS[roadWeight] + 3 : WEIGHTS[roadWeight],
      opacity: (isSelected || isComparison) ? 1 : OPACITIES[roadOpacity],
      lineCap: 'round',
      lineJoin: 'round',
      dashArray: isComparison ? '8 6' : undefined
    }
  }, [selectedSegmentId, comparisonSegmentId, roadWeight, roadOpacity])

  const onEachFeature = useCallback((feature, layer) => {
    const p = feature?.properties || {}
    const name = p.Name || p.OB_Name || 'Unknown road'
    const score = formatScore(p.score)
    const label = p.label || 'N/A'

    layer.bindTooltip(`${name} · ${label} · PCI ${score}`, {
      sticky: true,
      direction: 'top',
      opacity: 0.98,
      className: 'road-tooltip'
    })

    layer.on('mouseover', (e) => {
      e.target.setStyle({ weight: WEIGHTS[roadWeight] + 4, opacity: 1 })
      if (e.target.bringToFront) e.target.bringToFront()
    })

    layer.on('mouseout', (e) => {
      if (geoJsonRef.current?.resetStyle) geoJsonRef.current.resetStyle(e.target)
    })

    layer.on('click', (e) => {
      suppressMapClearRef.current = true
      if (e.originalEvent) {
        L.DomEvent.stopPropagation(e.originalEvent)
        L.DomEvent.preventDefault(e.originalEvent)
      }
      const clickLat = e.latlng.lat
      const clickLng = e.latlng.lng
      const nearest = findNearestPanorama(clickLat, clickLng, panoramaPoints)
      const selected = buildSelectedSegment(feature, nearest, { lat: clickLat, lng: clickLng })

      if (comparisonModeRef.current && selectedSegmentRef.current) {
        setComparisonSegment(selected)
      } else {
        setSelectedSegment(selected)
        setComparisonSegment(null)
      }

      if (!comparisonModeRef.current) {
        layer.bindPopup(popupHtmlForFeature(selected), { maxWidth: 400, className: 'road-popup-shell' }).openPopup(e.latlng)
      }
    })
  }, [roadWeight, panoramaPoints])

  const geoJsonKey = `${filterMode}-${roadWeight}-${roadOpacity}-${scoreRange[0]}-${scoreRange[1]}-${[...hiddenGrades].sort().join(',')}-${[...materialFilters].sort().join(',')}-${selectedSegmentId}-${comparisonSegmentId}`

  const minPercent = scoreRange[0]
  const maxPercent = scoreRange[1]
  const maxCount = Math.max(...Object.values(gradeDistribution.counts), 1)

  return (
    <div className={`page-shell ${fullscreen ? 'fullscreen-mode' : ''}`}>
      {!fullscreen && (
        <aside className={`sidebar-shell ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <div className="sidebar-scroll">
            <div className="sidebar-content">
              <div className="brand-card">
                <div className="brand-top-row">
                  <div>
                    <div className="brand-kicker">CivicHacks 2026</div>
                    <h1>{sidebarCollapsed ? 'RHV' : 'Road Health Viewer'}</h1>
                  </div>
                  <div className="brand-actions">
                    <button type="button" className="icon-btn" onClick={toggleDarkMode} aria-label="Toggle theme">
                      {darkMode ? <SunIcon /> : <MoonIcon />}
                    </button>
                    <button type="button" className={settingsOpen ? 'icon-btn active' : 'icon-btn'} onClick={() => setSettingsOpen(!settingsOpen)} aria-label="Settings">
                      <SettingsIcon />
                    </button>
                  </div>
                </div>
                {!sidebarCollapsed && (
                  <p>Pavement condition map for Brookline, MA with click-to-validate panoramic imagery.</p>
                )}

                {settingsOpen && !sidebarCollapsed && (
                  <div className="settings-panel">
                    <div className="setting-row">
                      <span className="setting-label">Map</span>
                      <div className="setting-options">
                        {Object.entries({ street: 'Street', satellite: 'Satellite', topo: 'Topo' }).map(([key, label]) => (
                          <button key={key} type="button" className={mapStyle === key ? 'opt-btn active' : 'opt-btn'} onClick={() => setMapStyle(key)}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="setting-row">
                      <span className="setting-label">Weight</span>
                      <div className="setting-options">
                        {Object.entries({ thin: 'Thin', normal: 'Normal', bold: 'Bold' }).map(([key, label]) => (
                          <button key={key} type="button" className={roadWeight === key ? 'opt-btn active' : 'opt-btn'} onClick={() => setRoadWeight(key)}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="setting-row">
                      <span className="setting-label">Opacity</span>
                      <div className="setting-options">
                        {Object.entries({ light: 'Light', medium: 'Medium', full: 'Full' }).map(([key, label]) => (
                          <button key={key} type="button" className={roadOpacity === key ? 'opt-btn active' : 'opt-btn'} onClick={() => setRoadOpacity(key)}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {!sidebarCollapsed && (
                <>
                  <div className="panel">
                    <div className="filter-row">
                      <div className="seg-control">
                        <button type="button" className={filterMode === 'bad' ? 'seg-btn active' : 'seg-btn'} onClick={() => setFilterMode('bad')}>
                          Poor roads
                        </button>
                        <button type="button" className={filterMode === 'all' ? 'seg-btn active' : 'seg-btn'} onClick={() => setFilterMode('all')}>
                          All roads
                        </button>
                      </div>
                    </div>

                    <div className="range-section">
                      <div className="range-header">
                        <span className="setting-label">PCI Range</span>
                        <span className="range-values">{scoreRange[0]} – {scoreRange[1]}</span>
                      </div>
                      <div className="range-slider">
                        <div className="range-track">
                          <div className="range-fill" style={{ left: `${minPercent}%`, width: `${maxPercent - minPercent}%` }} />
                        </div>
                        <input
                          type="range" min={0} max={100} value={scoreRange[0]}
                          className="range-thumb"
                          onChange={(e) => setScoreRange([Math.min(Number(e.target.value), scoreRange[1] - 1), scoreRange[1]])}
                        />
                        <input
                          type="range" min={0} max={100} value={scoreRange[1]}
                          className="range-thumb"
                          onChange={(e) => setScoreRange([scoreRange[0], Math.max(Number(e.target.value), scoreRange[0] + 1)])}
                        />
                      </div>
                    </div>

                    {materials.length > 1 && (
                      <div className="material-chips">
                        {materials.map((mat) => (
                          <button
                            key={mat} type="button"
                            className={materialFilters.has(mat) ? 'chip active' : 'chip'}
                            onClick={() => toggleMaterial(mat)}
                          >
                            {mat}
                          </button>
                        ))}
                        {materialFilters.size > 0 && (
                          <button type="button" className="chip clear-chip" onClick={() => setMaterialFilters(new Set())}>
                            Clear
                          </button>
                        )}
                      </div>
                    )}

                    <div className="stat-row">
                      <div className="stat">
                        <span className="stat-val">{stats.visibleSegments}</span>
                        <span className="stat-label">visible</span>
                      </div>
                      <div className="stat-divider" />
                      <div className="stat">
                        <span className="stat-val">{stats.criticalCount}</span>
                        <span className="stat-label">critical</span>
                      </div>
                      <div className="stat-divider" />
                      <div className="stat">
                        <span className="stat-val">{stats.avgVisible ? stats.avgVisible.toFixed(1) : '—'}</span>
                        <span className="stat-label">avg PCI</span>
                      </div>
                    </div>
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <h2>Distribution</h2>
                      <button type="button" className="text-btn" onClick={() => setStatsExpanded((p) => !p)}>
                        {statsExpanded ? 'Less' : 'More'}
                      </button>
                    </div>
                    <div className="dist-chart">
                      {GRADES.map((g) => (
                        <div key={g.key} className="dist-row">
                          <span className="dist-label">{g.label}</span>
                          <div className="dist-bar-track">
                            <div
                              className="dist-bar-fill"
                              style={{
                                width: `${(gradeDistribution.counts[g.key] / maxCount) * 100}%`,
                                background: g.color
                              }}
                            />
                          </div>
                          <span className="dist-count">{gradeDistribution.counts[g.key]}</span>
                        </div>
                      ))}
                    </div>

                    {statsExpanded && (
                      <div className="stats-dashboard">
                        <div className="donut-section">
                          <div className="donut" style={{ background: donutSegments || 'var(--border)' }}>
                            <div className="donut-hole">
                              <span className="donut-total">{gradeDistribution.total}</span>
                              <span className="donut-total-label">total</span>
                            </div>
                          </div>
                          <div className="donut-legend">
                            {GRADES.map((g) => {
                              const pct = gradeDistribution.total > 0
                                ? ((gradeDistribution.counts[g.key] / gradeDistribution.total) * 100).toFixed(1)
                                : '0.0'
                              return (
                                <div key={g.key} className="donut-legend-item">
                                  <span className="donut-legend-dot" style={{ background: g.color }} />
                                  <span className="donut-legend-label">{g.label}</span>
                                  <span className="donut-legend-pct">{pct}%</span>
                                </div>
                              )
                            })}
                          </div>
                        </div>

                        <div className="detail-grid">
                          <div className="detail-item">
                            <div className="detail-label">Total Length</div>
                            <div className="detail-value">{(gradeDistribution.totalLen / 5280).toFixed(1)} mi</div>
                          </div>
                          <div className="detail-item">
                            <div className="detail-label">Avg Score</div>
                            <div className="detail-value">
                              {gradeDistribution.total > 0
                                ? (allFeatures.reduce((sum, f) => sum + (typeof f?.properties?.score === 'number' ? f.properties.score : 0), 0) / gradeDistribution.total).toFixed(1)
                                : '—'}
                            </div>
                          </div>
                          <div className="detail-item">
                            <div className="detail-label">Critical Length</div>
                            <div className="detail-value">{((gradeDistribution.totalLength.critical + gradeDistribution.totalLength.poor) / 5280).toFixed(1)} mi</div>
                          </div>
                          <div className="detail-item">
                            <div className="detail-label">Good Length</div>
                            <div className="detail-value">{(gradeDistribution.totalLength.good / 5280).toFixed(1)} mi</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <h2>{comparisonMode ? 'Compare Segments' : 'Selected Segment'}</h2>
                      <div className="panel-header-actions">
                        {selectedSegment && !comparisonMode && (
                          <button type="button" className="text-btn" onClick={() => { setComparisonMode(true) }}>
                            Compare
                          </button>
                        )}
                        {comparisonMode && (
                          <button type="button" className="text-btn" onClick={() => { setComparisonMode(false); setComparisonSegment(null) }}>
                            Exit
                          </button>
                        )}
                        {selectedSegment && (
                          <button type="button" className="text-btn" onClick={() => { setSelectedSegment(null); setComparisonSegment(null); setComparisonMode(false) }}>
                            Clear
                          </button>
                        )}
                      </div>
                    </div>

                    {!selectedSegment && !comparisonMode && (
                      <div className="empty-state">Click a road on the map to inspect it.</div>
                    )}

                    {comparisonMode && !selectedSegment && (
                      <div className="empty-state">Click a road to select the first segment.</div>
                    )}

                    {comparisonMode && selectedSegment && !comparisonSegment && (
                      <div>
                        <SegmentCard segment={selectedSegment} label="A" />
                        <div className="empty-state" style={{ marginTop: 8 }}>Click another road to compare.</div>
                      </div>
                    )}

                    {comparisonMode && selectedSegment && comparisonSegment && (
                      <div className="comparison-grid">
                        <SegmentCard segment={selectedSegment} label="A" />
                        <SegmentCard segment={comparisonSegment} label="B" />
                      </div>
                    )}

                    {!comparisonMode && selectedSegment && (
                      <div className="selected-details">
                        <div className="selected-title-row">
                          <span className="selected-road">{selectedSegment.name}</span>
                          <span className={`badge ${scoreToBadgeTone(selectedSegment.score)}`}>
                            {selectedSegment.label}
                          </span>
                        </div>

                        <div className="selected-route">
                          {selectedSegment.fromStreet} → {selectedSegment.toStreet}
                        </div>

                        <div className="detail-grid">
                          <div className="detail-item">
                            <div className="detail-label">PCI</div>
                            <div className="detail-value">{formatScore(selectedSegment.score)}</div>
                          </div>
                          <div className="detail-item">
                            <div className="detail-label">Width</div>
                            <div className="detail-value">
                              {selectedSegment.width !== 'N/A' ? `${selectedSegment.width} ft` : '—'}
                            </div>
                          </div>
                          <div className="detail-item">
                            <div className="detail-label">Length</div>
                            <div className="detail-value">
                              {selectedSegment.shapeLength != null ? `${selectedSegment.shapeLength.toFixed(0)} ft` : '—'}
                            </div>
                          </div>
                          <div className="detail-item">
                            <div className="detail-label">Material</div>
                            <div className="detail-value">{selectedSegment.material || '—'}</div>
                          </div>
                        </div>

                        {selectedSegment.nearestPanorama && (
                          <div className="pano-preview">
                            <iframe
                              className="pano-iframe"
                              src={selectedSegment.nearestPanorama.imageUrl}
                              loading="lazy"
                              title="Street panorama"
                            />
                            <div className="pano-meta">
                              <span>{Math.round(selectedSegment.nearestPanorama.distanceMeters)} m from click</span>
                              <a href={selectedSegment.nearestPanorama.imageUrl} target="_blank" rel="noopener noreferrer">
                                Open full view
                              </a>
                            </div>
                          </div>
                        )}

                        {!selectedSegment.nearestPanorama && (
                          <div className="empty-state">No panorama available near this location.</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <h2>Ranked Segments</h2>
                      <span className="panel-note">{allFeatures.length} total</span>
                    </div>

                    <div className="sort-row">
                      <div className="sort-options">
                        {SORT_OPTIONS.map((opt) => (
                          <button
                            key={opt.key} type="button"
                            className={sortBy === opt.key ? 'sort-btn active' : 'sort-btn'}
                            onClick={() => {
                              if (sortBy === opt.key) setSortAsc((p) => !p)
                              else { setSortBy(opt.key); setSortAsc(true) }
                            }}
                          >
                            {opt.label}
                            {sortBy === opt.key && <span className="sort-dir">{sortAsc ? '↑' : '↓'}</span>}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="search-wrap">
                      <SearchIcon />
                      <input
                        type="text"
                        className="search-input"
                        placeholder="Search roads..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                      {searchQuery && (
                        <button type="button" className="search-clear" onClick={() => setSearchQuery('')}>
                          &times;
                        </button>
                      )}
                    </div>

                    <div className="rank-list" ref={rankListRef}>
                      {filteredSegments.length === 0 && <div className="empty-state">No matches.</div>}
                      {filteredSegments.map((item, idx) => {
                        const isSelected = selectedSegmentId && selectedSegmentId === item.id
                        const isKeyNav = activeRankIndex === idx
                        return (
                          <button
                            key={item.id || `${item.name}-${idx}`}
                            type="button"
                            className={`rank-item ${isSelected ? 'active' : ''} ${isKeyNav ? 'keynav' : ''}`}
                            onClick={() => { handleRankClick(item); setActiveRankIndex(idx) }}
                          >
                            <span className="rank-index">{idx + 1}</span>
                            <span className="rank-main">
                              <span className="rank-title">{item.name}</span>
                              <span className="rank-sub">{item.fromStreet} → {item.toStreet}</span>
                            </span>
                            <span className={`score-pill ${scoreToBadgeTone(item.score)}`}>
                              {formatScore(item.score)}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="panel toolbar-panel">
                    <button type="button" className="toolbar-btn" onClick={() => exportVisibleCSV(visibleFeatures)}>
                      Export CSV
                    </button>
                    <button type="button" className="toolbar-btn" onClick={handleShare}>
                      Share View
                    </button>
                    <button type="button" className="toolbar-btn" onClick={handleAnalyzeViewport}>
                      Analyze View
                    </button>
                    <button type="button" className="toolbar-btn" onClick={() => setShortcutsOpen(true)}>
                      Shortcuts
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <button
            type="button"
            className="collapse-toggle"
            onClick={() => setSidebarCollapsed((p) => !p)}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        </aside>
      )}

      <main className="map-stage">
        <div className="legend-card">
          <div className="legend-title">PCI</div>
          {GRADES.map((g) => (
            <button
              key={g.key}
              type="button"
              className={`legend-item ${hiddenGrades.has(g.key) ? 'hidden-grade' : ''}`}
              onClick={() => toggleGrade(g.key)}
            >
              <span className={`legend-dot ${g.dotClass}`} />
              <span>{g.label} ({g.range})</span>
            </button>
          ))}
        </div>

        <div className="map-loc-chip">Brookline, MA</div>

        <div className="map-controls-top">
          <button type="button" className="map-control-btn" onClick={() => setFullscreen((p) => !p)} aria-label="Fullscreen">
            {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
          {!tourActive && (
            <button type="button" className="map-control-btn tour-btn" onClick={startTour} aria-label="Tour worst roads">
              ▶
            </button>
          )}
          {tourActive && (
            <button type="button" className="map-control-btn tour-btn active" onClick={() => setTourActive(false)} aria-label="Stop tour">
              ⏸
            </button>
          )}
        </div>

        {tourActive && (
          <div className="tour-overlay">
            <div className="tour-bar tour-bar-top" />
            <div className="tour-info">
              <span className="tour-counter">{tourIndex + 1} / {Math.min(sortedSegments.length, 12)}</span>
              {selectedSegment && (
                <span className="tour-road">{selectedSegment.name}</span>
              )}
              {selectedSegment && (
                <span className={`score-pill ${scoreToBadgeTone(selectedSegment.score)}`}>
                  PCI {formatScore(selectedSegment.score)}
                </span>
              )}
            </div>
            <div className="tour-bar tour-bar-bottom" />
          </div>
        )}

        {fullscreen && selectedSegment && !tourActive && (
          <div className="fullscreen-info">
            <span className="fullscreen-road">{selectedSegment.name}</span>
            <span className={`badge ${scoreToBadgeTone(selectedSegment.score)}`}>{selectedSegment.label}</span>
            <span className="fullscreen-score">PCI {formatScore(selectedSegment.score)}</span>
          </div>
        )}

        {shareToast && <div className="toast">Link copied to clipboard</div>}

        {loading && (
          <div className="center-overlay">
            <div className="loader" />
            Loading data…
          </div>
        )}
        {error && <div className="center-overlay error">{error}</div>}

        <MapContainer center={BROOKLINE_CENTER} zoom={BROOKLINE_ZOOM} className="map-canvas" preferCanvas>
          <MapController flyTarget={flyTarget} mapRef={mapRef} />
          <MapClickReset onClear={() => { setSelectedSegment(null); setComparisonSegment(null) }} suppressRef={suppressMapClearRef} />
          <TileLayer key={effectiveTileKey} attribution={tile.attr} url={tile.url} />
          <ScaleControl position="bottomleft" />
          {visibleGeoJson && (
            <GeoJSON
              key={geoJsonKey}
              ref={geoJsonRef}
              data={visibleGeoJson}
              style={styleFeature}
              onEachFeature={onEachFeature}
            />
          )}
        </MapContainer>
      </main>

      {shortcutsOpen && (
        <div className="modal-backdrop" onClick={() => setShortcutsOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Keyboard Shortcuts</h2>
              <button type="button" className="modal-close" onClick={() => setShortcutsOpen(false)}>&times;</button>
            </div>
            <div className="shortcuts-grid">
              {SHORTCUTS.map(([key, desc]) => (
                <div key={key} className="shortcut-row">
                  <kbd className="shortcut-key">{key}</kbd>
                  <span className="shortcut-desc">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SegmentCard({ segment, label }) {
  return (
    <div className="segment-card">
      <div className="segment-card-label">{label}</div>
      <div className="segment-card-name">{segment.name}</div>
      <div className="segment-card-route">{segment.fromStreet} → {segment.toStreet}</div>
      <div className="segment-card-metrics">
        <div>
          <span className="segment-card-metric-label">PCI</span>
          <span className={`segment-card-metric-value ${scoreToBadgeTone(segment.score)}-text`}>{formatScore(segment.score)}</span>
        </div>
        <div>
          <span className="segment-card-metric-label">Label</span>
          <span className="segment-card-metric-value">{segment.label}</span>
        </div>
        <div>
          <span className="segment-card-metric-label">Width</span>
          <span className="segment-card-metric-value">{segment.width !== 'N/A' ? `${segment.width} ft` : '—'}</span>
        </div>
        <div>
          <span className="segment-card-metric-label">Material</span>
          <span className="segment-card-metric-value">{segment.material || '—'}</span>
        </div>
      </div>
    </div>
  )
}
