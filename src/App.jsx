import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { GeoJSON, MapContainer, ScaleControl, TileLayer, useMap, useMapEvents } from 'react-leaflet'

const BROOKLINE_CENTER = [42.3318, -71.1212]
const BROOKLINE_ZOOM = 13

function formatScore(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'N/A'
  return score.toFixed(2)
}

function scoreToRoadColor(score) {
  const s = typeof score === 'number' ? score : Number(score)
  if (!Number.isFinite(s)) return '#9aa0a6'
  if (s <= 30) return '#8b0000'
  if (s <= 40) return '#d93025'
  if (s <= 55) return '#fbbc04'
  return '#34a853'
}

function scoreToBadgeTone(score) {
  const s = typeof score === 'number' ? score : Number(score)
  if (!Number.isFinite(s)) return 'neutral'
  if (s <= 30) return 'critical'
  if (s <= 40) return 'high'
  if (s <= 55) return 'medium'
  return 'low'
}

function roadBucketKey(score) {
  const s = typeof score === 'number' ? score : Number(score)
  if (!Number.isFinite(s)) return null
  if (s <= 30) return 'severe'
  if (s <= 40) return 'veryPoor'
  if (s <= 55) return 'poor'
  return 'good'
}

function hasValidRoadScore(score) {
  const s = typeof score === 'number' ? score : Number(score)
  return Number.isFinite(s) && s > 0
}

function normalizeSidewalkCondition(value) {
  const v = String(value || '').trim().toLowerCase()
  if (v === 'good') return 'Good'
  if (v === 'fair') return 'Fair'
  if (v === 'poor') return 'Poor'
  return 'Unknown'
}

function sidewalkBucketKey(value) {
  const c = normalizeSidewalkCondition(value)
  if (c === 'Good') return 'good'
  if (c === 'Fair') return 'fair'
  if (c === 'Poor') return 'poor'
  return null
}

function sidewalkConditionColor(value) {
  const key = sidewalkBucketKey(value)
  if (key === 'good') return '#34a853'
  if (key === 'fair') return '#fbbc04'
  if (key === 'poor') return '#d93025'
  return '#9aa0a6'
}

function sidewalkConditionBadgeTone(value) {
  const key = sidewalkBucketKey(value)
  if (key === 'poor') return 'high'
  if (key === 'fair') return 'medium'
  if (key === 'good') return 'low'
  return 'neutral'
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

function getLineChains(geometry) {
  if (!geometry) return []
  if (geometry.type === 'LineString') return [geometry.coordinates || []]
  if (geometry.type === 'MultiLineString') return geometry.coordinates || []
  return []
}

function getFeatureAnchorLatLng(feature) {
  const chains = getLineChains(feature?.geometry)
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  let found = false
  for (const chain of chains) {
    for (const coord of chain) {
      if (!Array.isArray(coord) || coord.length < 2) continue
      const lng = Number(coord[0])
      const lat = Number(coord[1])
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      found = true
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
    }
  }
  if (!found) return null
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 }
}

function geometryLengthFeet(feature) {
  const chains = getLineChains(feature?.geometry)
  let meters = 0
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i += 1) {
      const prev = chain[i - 1]
      const curr = chain[i]
      if (!Array.isArray(prev) || !Array.isArray(curr) || prev.length < 2 || curr.length < 2) continue
      meters += haversineMeters(Number(prev[1]), Number(prev[0]), Number(curr[1]), Number(curr[0]))
    }
  }
  return meters * 3.28084
}

function getRoadSegmentId(props) {
  return String(props?.client_seg || props?.facilityid || props?.OB_Name || props?.Name || '')
}

function getSidewalkSegmentId(props) {
  return String(props?.feature_id || props?.id || '')
}

function getFeatureIdByMode(feature, viewMode) {
  const p = feature?.properties || {}
  return viewMode === 'roads' ? `roads:${getRoadSegmentId(p)}` : `sidewalks:${getSidewalkSegmentId(p)}`
}

function buildSelectedRoadSegment(feature, nearestPanorama, clickLatLng) {
  const p = feature?.properties || {}
  return {
    mode: 'roads',
    id: `roads:${getRoadSegmentId(p)}`,
    rawId: getRoadSegmentId(p),
    name: p.Name || p.OB_Name || 'Unknown road',
    fromStreet: p.From_ST || 'N/A',
    toStreet: p.To_Street || 'N/A',
    material: p.Pave_MatLG || 'N/A',
    width: p.Width || 'N/A',
    shapeLength: typeof p.Shape_Leng === 'number' ? p.Shape_Leng : Number(p.Shape_Leng),
    score: typeof p.score === 'number' ? p.score : Number(p.score),
    label: p.label || 'N/A',
    nearestPanorama,
    clickLatLng,
    anchorLatLng: getFeatureAnchorLatLng(feature),
    feature
  }
}

function buildSelectedSidewalkSegment(feature, nearestPanorama, clickLatLng) {
  const p = feature?.properties || {}
  return {
    mode: 'sidewalks',
    id: `sidewalks:${getSidewalkSegmentId(p)}`,
    rawId: getSidewalkSegmentId(p),
    name: p.Type || 'Sidewalk',
    label: normalizeSidewalkCondition(p.condition || p.Condition),
    material: p.Material || 'N/A',
    sidewalkType: p.Type || 'N/A',
    approxLengthFt: geometryLengthFeet(feature),
    nearestPanorama,
    clickLatLng,
    anchorLatLng: getFeatureAnchorLatLng(feature),
    feature
  }
}

function popupHtmlForFeature(selected) {
  const pano = selected?.nearestPanorama
  if (!pano) {
    return `
      <div class="popup-card">
        <div class="popup-road">${selected?.name || 'Segment'}</div>
        <div class="popup-inline-note">No panorama found near this click location</div>
      </div>
    `
  }

  const subtitle =
    selected?.mode === 'sidewalks'
      ? `Sidewalk · ${selected?.label || 'Unknown'}`
      : `${selected?.label || 'Unknown'} · PCI ${formatScore(selected?.score)}`

  return `
    <div class="popup-card">
      <div class="popup-road">${selected?.name || 'Segment'}</div>
      <div class="popup-subtitle">${subtitle}</div>
      <div class="popup-iframe-wrap">
        <iframe class="popup-iframe" src="${pano.imageUrl}" loading="lazy"></iframe>
      </div>
      <div class="popup-inline-note">${Math.round(pano.distanceMeters)} m from clicked point</div>
      <div class="popup-actions">
        <a class="popup-action" href="${pano.imageUrl}" target="_blank" rel="noopener noreferrer">View in new tab</a>
      </div>
    </div>
  `
}

function MapClickReset({ onClear, suppressMapClearRef }) {
  useMapEvents({
    click() {
      if (suppressMapClearRef.current) {
        suppressMapClearRef.current = false
        return
      }
      onClear()
    }
  })
  return null
}

function MapCapture({ onReady }) {
  const map = useMap()
  useEffect(() => {
    onReady(map)
  }, [map, onReady])
  return null
}

export default function App() {
  const [rollupData, setRollupData] = useState(null)
  const [panoramaData, setPanoramaData] = useState(null)
  const [sidewalkData, setSidewalkData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [viewMode, setViewMode] = useState('roads')
  const [basemapMode, setBasemapMode] = useState('road')
  const [selectedSegment, setSelectedSegment] = useState(null)
  const [sidebarWidth, setSidebarWidth] = useState(420)
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [roadLegendEnabled, setRoadLegendEnabled] = useState({
    good: false,
    poor: true,
    veryPoor: true,
    severe: true
  })
  const [sidewalkLegendEnabled, setSidewalkLegendEnabled] = useState({
    good: false,
    fair: true,
    poor: true
  })

  const geoJsonRef = useRef(null)
  const suppressMapClearRef = useRef(false)
  const mapRef = useRef(null)
  const pageShellRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    async function loadData() {
      try {
        setLoading(true)
        setError('')

        const [rollupRes, panoRes, sidewalkRes] = await Promise.all([
          fetch('/data/brookline/rollup.geojson'),
          fetch('/data/brookline/panoramicImagery.geojson'),
          fetch('/data/brookline/aboveGroundAssets.geojson')
        ])

        if (!rollupRes.ok) throw new Error(`Failed to load rollup.geojson (${rollupRes.status})`)
        if (!panoRes.ok) throw new Error(`Failed to load panoramicImagery.geojson (${panoRes.status})`)
        if (!sidewalkRes.ok) throw new Error(`Failed to load aboveGroundAssets.geojson (${sidewalkRes.status})`)

        const [rollupJson, panoJson, sidewalkJsonRaw] = await Promise.all([
          rollupRes.json(),
          panoRes.json(),
          sidewalkRes.json()
        ])

        const sidewalkFeatures = (sidewalkJsonRaw?.features || []).filter((f) => {
          const p = f?.properties || {}
          const isSidewalk = String(p.asset_type || '').toUpperCase() === 'SIDEWALK'
          const t = f?.geometry?.type
          const isLine = t === 'LineString' || t === 'MultiLineString'
          return isSidewalk && isLine
        })

        if (!cancelled) {
          setRollupData(rollupJson)
          setPanoramaData(panoJson)
          setSidewalkData({
            type: 'FeatureCollection',
            features: sidewalkFeatures
          })
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadData()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isResizingSidebar) return

    const onMouseMove = (e) => {
      const rect = pageShellRef.current?.getBoundingClientRect()
      if (!rect) return
      const next = e.clientX - rect.left - 5
      const clamped = Math.max(300, Math.min(760, next))
      setSidebarWidth(clamped)
    }

    const onMouseUp = () => {
      setIsResizingSidebar(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizingSidebar])

  useEffect(() => {
    setSelectedSegment(null)
  }, [viewMode])

  const panoramaPoints = useMemo(() => getPanoramaPoints(panoramaData), [panoramaData])

  const activeData = useMemo(() => (viewMode === 'roads' ? rollupData : sidewalkData), [viewMode, rollupData, sidewalkData])
  const allFeatures = useMemo(() => activeData?.features || [], [activeData])

  const legendItems = useMemo(() => {
    if (viewMode === 'roads') {
      return [
        { key: 'good', label: 'Good', color: '#34a853' },
        { key: 'poor', label: 'Poor', color: '#fbbc04' },
        { key: 'veryPoor', label: 'Very Poor', color: '#d93025' },
        { key: 'severe', label: 'Severe', color: '#8b0000' }
      ]
    }
    return [
      { key: 'good', label: 'Good', color: '#34a853' },
      { key: 'fair', label: 'Fair', color: '#fbbc04' },
      { key: 'poor', label: 'Poor', color: '#d93025' }
    ]
  }, [viewMode])

  const legendSignature = useMemo(() => {
    const obj = viewMode === 'roads' ? roadLegendEnabled : sidewalkLegendEnabled
    return Object.entries(obj)
      .map(([k, v]) => `${k}:${v ? 1 : 0}`)
      .join('|')
  }, [viewMode, roadLegendEnabled, sidewalkLegendEnabled])

  const visibleFeatures = useMemo(() => {
    if (!Array.isArray(allFeatures)) return []
    if (viewMode === 'roads') {
      return allFeatures.filter((f) => {
        const bucket = roadBucketKey(f?.properties?.score)
        return bucket && roadLegendEnabled[bucket]
      })
    }
    return allFeatures.filter((f) => {
      const p = f?.properties || {}
      const bucket = sidewalkBucketKey(p.condition || p.Condition)
      return bucket && sideLegendEnabledOr(sidewalkLegendEnabled, bucket)
    })
  }, [allFeatures, viewMode, roadLegendEnabled, sidewalkLegendEnabled])

  const visibleGeoJson = useMemo(() => {
    if (!activeData) return null
    return { ...activeData, features: visibleFeatures }
  }, [activeData, visibleFeatures])

  const featureIndex = useMemo(() => {
    const map = new Map()
    for (const f of allFeatures) {
      map.set(getFeatureIdByMode(f, viewMode), f)
    }
    return map
  }, [allFeatures, viewMode])

  const distributionRows = useMemo(() => {
    const counts = new Map()
    for (const item of legendItems) counts.set(item.key, 0)
    for (const f of visibleFeatures) {
      const p = f?.properties || {}
      const key = viewMode === 'roads' ? roadBucketKey(p.score) : sidewalkBucketKey(p.condition || p.Condition)
      if (key && counts.has(key)) counts.set(key, (counts.get(key) || 0) + 1)
    }
    const rows = legendItems.map((item) => ({
      ...item,
      count: counts.get(item.key) || 0
    }))
    const max = rows.reduce((m, r) => Math.max(m, r.count), 0)
    return rows.map((r) => ({ ...r, pct: max > 0 ? (r.count / max) * 100 : 0 }))
  }, [legendItems, visibleFeatures, viewMode])

  const worstSegments = useMemo(() => {
    if (viewMode === 'roads') {
      return [...allFeatures]
        .filter((f) => {
          const s = Number(f?.properties?.score)
          return hasValidRoadScore(s)
        })
        .sort((a, b) => Number(a.properties.score) - Number(b.properties.score))
        .slice(0, 12)
        .map((f) => {
          const p = f.properties || {}
          return {
            id: getFeatureIdByMode(f, 'roads'),
            name: p.Name || p.OB_Name || 'Unknown road',
            fromStreet: p.From_ST || 'N/A',
            toStreet: p.To_Street || 'N/A',
            label: p.label || 'N/A',
            score: Number(p.score),
            anchorLatLng: getFeatureAnchorLatLng(f)
          }
        })
    }

    const rank = { poor: 0, fair: 1, good: 2 }
    return [...allFeatures]
      .filter((f) => sidewalkBucketKey(f?.properties?.condition || f?.properties?.Condition))
      .sort((a, b) => {
        const pa = a.properties || {}
        const pb = b.properties || {}
        const ka = sidewalkBucketKey(pa.condition || pa.Condition)
        const kb = sidewalkBucketKey(pb.condition || pb.Condition)
        const ra = rank[ka] ?? 9
        const rb = rank[kb] ?? 9
        if (ra !== rb) return ra - rb
        return geometryLengthFeet(b) - geometryLengthFeet(a)
      })
      .slice(0, 12)
      .map((f) => {
        const p = f.properties || {}
        const condition = normalizeSidewalkCondition(p.condition || p.Condition)
        return {
          id: getFeatureIdByMode(f, 'sidewalks'),
          name: p.Type || 'Sidewalk',
          fromStreet: 'Sidewalk segment',
          toStreet: p.Material || 'N/A',
          label: condition,
          score: null,
          anchorLatLng: getFeatureAnchorLatLng(f)
        }
      })
  }, [allFeatures, viewMode])

  const selectedSegmentId = selectedSegment?.id || ''

  const styleFeature = (feature) => {
    const p = feature?.properties || {}
    const id = getFeatureIdByMode(feature, viewMode)
    const isSelected = selectedSegmentId && id === selectedSegmentId
    const color =
      viewMode === 'roads'
        ? scoreToRoadColor(p.score)
        : sidewalkConditionColor(p.condition || p.Condition)

    return {
      color,
      weight: isSelected ? 8 : 6,
      opacity: isSelected ? 1 : 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    }
  }

  const selectFeatureFromMapInteraction = (feature, clickLatLng, layer, e) => {
    const nearest = findNearestPanorama(clickLatLng.lat, clickLatLng.lng, panoramaPoints)
    const selected =
      viewMode === 'roads'
        ? buildSelectedRoadSegment(feature, nearest, clickLatLng)
        : buildSelectedSidewalkSegment(feature, nearest, clickLatLng)

    setSelectedSegment(selected)

    if (layer && e) {
      layer.bindPopup(popupHtmlForFeature(selected), { maxWidth: 420, className: 'road-popup-shell' }).openPopup(e.latlng)
    }
  }

  const onEachFeature = (feature, layer) => {
    const p = feature?.properties || {}
    const isRoad = viewMode === 'roads'
    const name = isRoad ? p.Name || p.OB_Name || 'Unknown road' : p.Type || 'Sidewalk'
    const tooltipText = isRoad
      ? `${name} · ${p.label || 'N/A'} · PCI ${formatScore(Number(p.score))}`
      : `${name} · ${normalizeSidewalkCondition(p.condition || p.Condition)} · ${p.Material || 'N/A'}`

    layer.bindTooltip(tooltipText, {
      sticky: true,
      direction: 'top',
      opacity: 0.98,
      className: 'road-tooltip'
    })

    layer.on('mouseover', (evt) => {
      evt.target.setStyle({ weight: 9, opacity: 1 })
      if (evt.target.bringToFront) evt.target.bringToFront()
    })

    layer.on('mouseout', (evt) => {
      if (geoJsonRef.current && geoJsonRef.current.resetStyle) geoJsonRef.current.resetStyle(evt.target)
    })

    layer.on('click', (evt) => {
      suppressMapClearRef.current = true
      if (evt.originalEvent) {
        L.DomEvent.stopPropagation(evt.originalEvent)
        L.DomEvent.preventDefault(evt.originalEvent)
      }

      selectFeatureFromMapInteraction(
        feature,
        { lat: evt.latlng.lat, lng: evt.latlng.lng },
        layer,
        evt
      )
    })
  }

  const handleLegendToggle = (key) => {
    if (viewMode === 'roads') {
      setRoadLegendEnabled((prev) => ({ ...prev, [key]: !prev[key] }))
      return
    }
    setSidewalkLegendEnabled((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const legendEnabledMap = viewMode === 'roads' ? roadLegendEnabled : sidewalkLegendEnabled

  const handleLeaderboardClick = (item) => {
    const feature = featureIndex.get(item.id)
    if (!feature) return

    const anchor = item.anchorLatLng || getFeatureAnchorLatLng(feature)
    const clickLatLng = anchor || { lat: BROOKLINE_CENTER[0], lng: BROOKLINE_CENTER[1] }
    const nearest = findNearestPanorama(clickLatLng.lat, clickLatLng.lng, panoramaPoints)

    const selected =
      viewMode === 'roads'
        ? buildSelectedRoadSegment(feature, nearest, clickLatLng)
        : buildSelectedSidewalkSegment(feature, nearest, clickLatLng)

    setSelectedSegment(selected)

    if (anchor && mapRef.current) {
      const currentZoom = mapRef.current.getZoom ? mapRef.current.getZoom() : BROOKLINE_ZOOM
      mapRef.current.flyTo([anchor.lat, anchor.lng], Math.max(currentZoom, 16), {
        duration: 0.8
      })
    }
  }

  const pageShellStyle = {
    '--sidebar-w': `${sidebarWidth}px`
  }

  const selectedModeButtonClass = (mode) => (viewMode === mode ? 'seg-btn active' : 'seg-btn')

  return (
    <div ref={pageShellRef} className="page-shell" style={pageShellStyle}>
      <aside className="sidebar-shell">
        <div className="sidebar-scroll">
          <div className="sidebar-content">
            <div className="brand-card">
              <div className="brand-card-top">
                <div className="brand-kicker">CIVICHACKS 2026 · CITYHACK</div>
                <button
                  type="button"
                  className="icon-toggle-btn"
                  onClick={() => setBasemapMode((m) => (m === 'road' ? 'satellite' : 'road'))}
                  title={basemapMode === 'road' ? 'Switch to satellite' : 'Switch to map'}
                  aria-label={basemapMode === 'road' ? 'Switch to satellite basemap' : 'Switch to map basemap'}
                >
                  {basemapMode === 'road' ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true" className="icon-svg">
                      <path d="M3 6.5 8.5 4l7 2.5L21 4v13.5L15.5 20l-7-2.5L3 20V6.5Zm6 9.94 5 1.78V7.56L9 5.78v10.66Zm-4 .68 2-.91V5.93l-2 .91v10.28Zm12-1.02 2-.91V4.91l-2 .91v10.28Z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true" className="icon-svg">
                      <path d="M4 5h7v6H4V5Zm9 0h7v6h-7V5ZM4 13h7v6H4v-6Zm9 0h7v6h-7v-6ZM6 7v2h3V7H6Zm9 0v2h3V7h-3Zm-9 8v2h3v-2H6Zm9 0v2h3v-2h-3Z" />
                    </svg>
                  )}
                </button>
              </div>

              <h1>Pavement Condition Viewer</h1>
              <p>
                Interactive pavement and sidewalk condition map with street-level panoramas.
              </p>
            </div>

            <div className="panel compact-panel">
              <div className="compact-row mode-row">
                <div className="compact-label">Mode</div>
                <div className="segmented-control compact">
                  <button
                    type="button"
                    className={selectedModeButtonClass('roads')}
                    onClick={() => setViewMode('roads')}
                  >
                    Roads
                  </button>
                  <button
                    type="button"
                    className={selectedModeButtonClass('sidewalks')}
                    onClick={() => setViewMode('sidewalks')}
                  >
                    Sidewalks
                  </button>
                </div>
              </div>
              <div className="helper-inline-text">
                Tap legend items to show/hide categories.
              </div>
            </div>

            <div className="panel selected-inline-panel">
              <div className="panel-header">
                <h2>{viewMode === 'roads' ? 'Selected Segment' : 'Selected Sidewalk'}</h2>
                {selectedSegment && (
                  <button type="button" className="text-btn" onClick={() => setSelectedSegment(null)}>
                    Clear
                  </button>
                )}
              </div>

              {!selectedSegment && (
                <div className="empty-state">
                  Click a {viewMode === 'roads' ? 'road segment' : 'sidewalk segment'} on the map to view details here. Click empty map space to clear.
                </div>
              )}

              {selectedSegment && selectedSegment.mode === 'roads' && (
                <div className="selected-details">
                  <div className="selected-title-row">
                    <div className="selected-road">{selectedSegment.name}</div>
                    <div className={`condition-badge ${scoreToBadgeTone(selectedSegment.score)}`}>
                      {selectedSegment.label}
                    </div>
                  </div>

                  <div className="selected-route">
                    {selectedSegment.fromStreet} to {selectedSegment.toStreet}
                  </div>

                  <div className="selected-summary-strip">
                    <div className="overlay-metric">
                      <div className="overlay-metric-label">PCI Score</div>
                      <div className="overlay-metric-value">{formatScore(selectedSegment.score)}</div>
                    </div>
                    <div className="selected-pano-chip">
                      {selectedSegment.nearestPanorama
                        ? `${Math.round(selectedSegment.nearestPanorama.distanceMeters)} m to panorama`
                        : 'No nearby panorama'}
                    </div>
                  </div>

                  <div className="detail-grid detail-grid-5">
                    <div className="detail-item">
                      <div className="detail-label">PCI Score</div>
                      <div className="detail-value">{formatScore(selectedSegment.score)}</div>
                    </div>

                    <div className="detail-item">
                      <div className="detail-label">Width</div>
                      <div className="detail-value">
                        {selectedSegment.width && selectedSegment.width !== 'N/A' ? `${selectedSegment.width} ft` : 'N/A'}
                      </div>
                    </div>

                    <div className="detail-item">
                      <div className="detail-label">Length</div>
                      <div className="detail-value">
                        {Number.isFinite(selectedSegment.shapeLength) ? `${selectedSegment.shapeLength.toFixed(1)} ft` : 'N/A'}
                      </div>
                    </div>

                    <div className="detail-item">
                      <div className="detail-label">Material</div>
                      <div className="detail-value">{selectedSegment.material || 'N/A'}</div>
                    </div>

                    <div className="detail-item span-2">
                      <div className="detail-label">Clicked Location</div>
                      <div className="detail-value mono">
                        {selectedSegment.clickLatLng
                          ? `${selectedSegment.clickLatLng.lat.toFixed(6)}, ${selectedSegment.clickLatLng.lng.toFixed(6)}`
                          : 'N/A'}
                      </div>
                    </div>
                  </div>

                  <div className="selected-footer">
                    {selectedSegment.nearestPanorama ? (
                      <a
                        className="primary-action"
                        href={selectedSegment.nearestPanorama.imageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open Panorama
                      </a>
                    ) : (
                      <button className="primary-action disabled" type="button" disabled>
                        Panorama unavailable
                      </button>
                    )}
                  </div>
                </div>
              )}

              {selectedSegment && selectedSegment.mode === 'sidewalks' && (
                <div className="selected-details">
                  <div className="selected-title-row">
                    <div className="selected-road">{selectedSegment.name}</div>
                    <div className={`condition-badge ${sidewalkConditionBadgeTone(selectedSegment.label)}`}>
                      {selectedSegment.label}
                    </div>
                  </div>

                  <div className="selected-route">Sidewalk segment</div>

                  <div className="selected-summary-strip">
                    <div className="overlay-metric">
                      <div className="overlay-metric-label">Condition</div>
                      <div className="overlay-metric-value smaller">{selectedSegment.label}</div>
                    </div>
                    <div className="selected-pano-chip">
                      {selectedSegment.nearestPanorama
                        ? `${Math.round(selectedSegment.nearestPanorama.distanceMeters)} m to panorama`
                        : 'No nearby panorama'}
                    </div>
                  </div>

                  <div className="detail-grid detail-grid-5">
                    <div className="detail-item">
                      <div className="detail-label">Condition</div>
                      <div className="detail-value">{selectedSegment.label}</div>
                    </div>

                    <div className="detail-item">
                      <div className="detail-label">Type</div>
                      <div className="detail-value">{selectedSegment.sidewalkType || 'N/A'}</div>
                    </div>

                    <div className="detail-item">
                      <div className="detail-label">Length</div>
                      <div className="detail-value">
                        {Number.isFinite(selectedSegment.approxLengthFt) ? `${selectedSegment.approxLengthFt.toFixed(1)} ft` : 'N/A'}
                      </div>
                    </div>

                    <div className="detail-item">
                      <div className="detail-label">Material</div>
                      <div className="detail-value">{selectedSegment.material || 'N/A'}</div>
                    </div>

                    <div className="detail-item span-2">
                      <div className="detail-label">Clicked Location</div>
                      <div className="detail-value mono">
                        {selectedSegment.clickLatLng
                          ? `${selectedSegment.clickLatLng.lat.toFixed(6)}, ${selectedSegment.clickLatLng.lng.toFixed(6)}`
                          : 'N/A'}
                      </div>
                    </div>
                  </div>

                  <div className="selected-footer">
                    {selectedSegment.nearestPanorama ? (
                      <a
                        className="primary-action"
                        href={selectedSegment.nearestPanorama.imageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open Panorama
                      </a>
                    ) : (
                      <button className="primary-action disabled" type="button" disabled>
                        Panorama unavailable
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-header">
                <h2>{viewMode === 'roads' ? 'Top Worst Segments' : 'Top Sidewalk Priorities'}</h2>
                <span className="panel-chip">{viewMode === 'roads' ? 'By PCI' : 'By Condition'}</span>
              </div>
              <div className="rank-list">
                {worstSegments.length === 0 && <div className="empty-state">No segments found.</div>}
                {worstSegments.map((item, idx) => {
                  const selected = selectedSegmentId && selectedSegmentId === item.id
                  const tone =
                    viewMode === 'roads'
                      ? scoreToBadgeTone(item.score)
                      : sidewalkConditionBadgeTone(item.label)
                  return (
                    <button
                      type="button"
                      key={item.id || `${item.name}-${idx}`}
                      className={selected ? 'rank-item selected clickable' : 'rank-item clickable'}
                      onClick={() => handleLeaderboardClick(item)}
                    >
                      <div className="rank-index">{idx + 1}</div>
                      <div className="rank-main">
                        <div className="rank-title">{item.name}</div>
                        <div className="rank-subline">
                          {viewMode === 'roads'
                            ? `${item.fromStreet} to ${item.toStreet}`
                            : `${item.fromStreet} · ${item.toStreet}`}
                        </div>
                      </div>
                      <div className={`score-pill ${tone}`}>
                        {viewMode === 'roads' ? formatScore(item.score) : item.label}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <h2>{viewMode === 'roads' ? 'Road Condition Distribution' : 'Sidewalk Condition Distribution'}</h2>
                <span className="panel-chip">{visibleFeatures.length} visible</span>
              </div>
              <div className="distribution-list">
                {distributionRows.map((row) => (
                  <div className="distribution-row" key={row.key}>
                    <div className="distribution-label-wrap">
                      <span className="distribution-dot" style={{ background: row.color }}></span>
                      <span className="distribution-label">{row.label}</span>
                    </div>
                    <div className="distribution-bar-track">
                      <div
                        className="distribution-bar-fill"
                        style={{ width: `${row.pct}%`, background: row.color }}
                      ></div>
                    </div>
                    <div className="distribution-count">{row.count}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <div
        className={isResizingSidebar ? 'sidebar-resizer active' : 'sidebar-resizer'}
        onMouseDown={() => setIsResizingSidebar(true)}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      />

      <main className="map-stage">
        <div className="map-top-overlay">

          <div className="legend-card">
            <div className="legend-title">
              {viewMode === 'roads' ? 'PCI Severity' : 'Sidewalk Condition'}
            </div>
            <div className="legend-list subtle">
              {legendItems.map((item) => {
                const enabled = !!legendEnabledMap[item.key]
                return (
                  <button
                    type="button"
                    key={item.key}
                    className={enabled ? 'legend-item-toggle enabled' : 'legend-item-toggle'}
                    onClick={() => handleLegendToggle(item.key)}
                    aria-pressed={enabled}
                    title={enabled ? `Hide ${item.label}` : `Show ${item.label}`}
                  >
                    <span
                      className={enabled ? 'legend-dot-toggle enabled' : 'legend-dot-toggle'}
                      style={{ '--dot-color': item.color }}
                      aria-hidden="true"
                    >
                      {enabled ? '✓' : ''}
                    </span>
                    <span className="legend-item-label">{item.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="map-bottom-chip">Brookline, MA</div>

        {loading && <div className="center-overlay">Loading Brookline data…</div>}
        {error && <div className="center-overlay error">{error}</div>}

        <MapContainer center={BROOKLINE_CENTER} zoom={BROOKLINE_ZOOM} className="map-canvas" preferCanvas>
          <MapCapture onReady={(map) => { mapRef.current = map }} />
          <MapClickReset onClear={() => setSelectedSegment(null)} suppressMapClearRef={suppressMapClearRef} />

          {basemapMode === 'road' ? (
            <TileLayer
              attribution="&copy; OpenStreetMap contributors"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          ) : (
            <TileLayer
              attribution="Tiles &copy; Esri"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            />
          )}

          <ScaleControl position="bottomleft" />

          {visibleGeoJson && (
            <GeoJSON
              key={`${viewMode}-${basemapMode}-${legendSignature}`}
              ref={geoJsonRef}
              data={visibleGeoJson}
              style={styleFeature}
              onEachFeature={onEachFeature}
            />
          )}
        </MapContainer>
      </main>
    </div>
  )
}

function sideLegendEnabledOr(obj, key) {
  return !!obj[key]
}