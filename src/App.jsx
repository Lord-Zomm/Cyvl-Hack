import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { GeoJSON, MapContainer, ScaleControl, TileLayer, useMapEvents } from 'react-leaflet'

const BROOKLINE_CENTER = [42.3318, -71.1212]
const BROOKLINE_ZOOM = 13
const BAD_LABELS = new Set(['Poor', 'Very Poor', 'Serious', 'Failed'])

function formatScore(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'N/A'
  return score.toFixed(2)
}

function scoreToRoadColor(score) {
  const s = typeof score === 'number' ? score : 0
  if (s <= 30) return '#8b0000'
  if (s <= 40) return '#d93025'
  if (s <= 55) return '#fbbc04'
  return '#34a853'
}

function scoreToBadgeTone(score) {
  const s = typeof score === 'number' ? score : 0
  if (s <= 30) return 'critical'
  if (s <= 40) return 'high'
  if (s <= 55) return 'medium'
  return 'low'
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
        <div class="popup-inline-note">No panorama found near this click location</div>
      </div>
    `
  }

  return `
    <div class="popup-card">
      <div class="popup-road">${selected?.name || 'Road segment'}</div>
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

function getVisibleFeatures(features, mode) {
  if (!Array.isArray(features)) return []
  if (mode === 'all') return features.filter((f) => typeof f?.properties?.score === 'number')
  return features.filter((f) => {
    const p = f?.properties || {}
    return BAD_LABELS.has(p.label) && typeof p.score === 'number'
  })
}

function summaryStats(allFeatures, visibleFeatures) {
  const visibleScores = visibleFeatures.map((f) => f?.properties?.score).filter((v) => typeof v === 'number')
  const avgVisible = visibleScores.length ? visibleScores.reduce((a, b) => a + b, 0) / visibleScores.length : 0
  const criticalCount = allFeatures.filter((f) => {
    const s = f?.properties?.score
    return typeof s === 'number' && s <= 40
  }).length
  return {
    visibleSegments: visibleFeatures.length,
    avgVisible,
    criticalCount
  }
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

export default function App() {
  const [rollupData, setRollupData] = useState(null)
  const [panoramaData, setPanoramaData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterMode, setFilterMode] = useState('bad')
  const [selectedSegment, setSelectedSegment] = useState(null)

  const geoJsonRef = useRef(null)
  const suppressMapClearRef = useRef(false)

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

        if (!cancelled) {
          setRollupData(rollupJson)
          setPanoramaData(panoJson)
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

  const allFeatures = useMemo(() => rollupData?.features || [], [rollupData])
  const panoramaPoints = useMemo(() => getPanoramaPoints(panoramaData), [panoramaData])

  const visibleFeatures = useMemo(() => getVisibleFeatures(allFeatures, filterMode), [allFeatures, filterMode])

  const visibleGeoJson = useMemo(() => {
    if (!rollupData) return null
    return { ...rollupData, features: visibleFeatures }
  }, [rollupData, visibleFeatures])

  const stats = useMemo(() => summaryStats(allFeatures, visibleFeatures), [allFeatures, visibleFeatures])

  const worstSegments = useMemo(() => {
    return [...allFeatures]
      .filter((f) => typeof f?.properties?.score === 'number')
      .sort((a, b) => a.properties.score - b.properties.score)
      .slice(0, 12)
      .map((f) => {
        const p = f.properties
        return {
          id: getSegmentId(p),
          name: p.Name || p.OB_Name || 'Unknown road',
          fromStreet: p.From_ST || 'N/A',
          toStreet: p.To_Street || 'N/A',
          label: p.label || 'N/A',
          score: p.score
        }
      })
  }, [allFeatures])

  const selectedSegmentId = selectedSegment?.id || ''

  const styleFeature = (feature) => {
    const p = feature?.properties || {}
    const id = getSegmentId(p)
    const isSelected = selectedSegmentId && id === selectedSegmentId
    return {
      color: scoreToRoadColor(p.score),
      weight: isSelected ? 8 : 6,
      opacity: isSelected ? 1 : 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    }
  }

  const onEachFeature = (feature, layer) => {
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
      e.target.setStyle({ weight: 9, opacity: 1 })
      if (e.target.bringToFront) e.target.bringToFront()
    })

    layer.on('mouseout', (e) => {
      if (geoJsonRef.current && geoJsonRef.current.resetStyle) geoJsonRef.current.resetStyle(e.target)
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
      setSelectedSegment(selected)
      layer.bindPopup(popupHtmlForFeature(selected), { maxWidth: 420, className: 'road-popup-shell' }).openPopup(e.latlng)
    })
  }

  return (
    <div className="page-shell">
      <aside className="sidebar-shell">
        <div className="sidebar-scroll">
          <div className="sidebar-content">
            <div className="brand-card">
              <div className="brand-kicker">CIVICHACKS 2026 · CITYHACK</div>
              <h1>Cyvl Road Health Viewer</h1>
              <p>
                Interactive pavement condition map using Cyvl rollup PCI scores with click-to-validate
                street-level panorama imagery.
              </p>
            </div>

            <div className="panel compact-panel">
              <div className="compact-row">
                <div className="compact-label">Filter</div>
                <div className="segmented-control compact">
                  <button
                    type="button"
                    className={filterMode === 'bad' ? 'seg-btn active' : 'seg-btn'}
                    onClick={() => setFilterMode('bad')}
                  >
                    Poor
                  </button>
                  <button
                    type="button"
                    className={filterMode === 'all' ? 'seg-btn active' : 'seg-btn'}
                    onClick={() => setFilterMode('all')}
                  >
                    All roads
                  </button>
                </div>
              </div>

              <div className="mini-stats">
                <div className="mini-stat">
                  <span className="mini-stat-label">Visible</span>
                  <span className="mini-stat-value">{stats.visibleSegments}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat-label">Critical</span>
                  <span className="mini-stat-value">{stats.criticalCount}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat-label">Avg PCI</span>
                  <span className="mini-stat-value">{stats.avgVisible ? stats.avgVisible.toFixed(1) : 'N/A'}</span>
                </div>
              </div>
            </div>

            <div className="panel selected-inline-panel">
              <div className="panel-header">
                <h2>Selected Segment</h2>
                {selectedSegment && (
                  <button type="button" className="text-btn" onClick={() => setSelectedSegment(null)}>
                    Clear
                  </button>
                )}
              </div>

              {!selectedSegment && (
                <div className="empty-state">
                  Click a road segment on the map to view segment details here. Click empty map space to clear.
                </div>
              )}

              {selectedSegment && (
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
                        {selectedSegment.shapeLength != null ? `${selectedSegment.shapeLength.toFixed(1)} ft` : 'N/A'}
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
                <h2>Top Worst Segments</h2>
                <span className="panel-chip">By PCI</span>
              </div>
              <div className="rank-list">
                {worstSegments.length === 0 && <div className="empty-state">No scored segments found.</div>}
                {worstSegments.map((item, idx) => {
                  const selected = selectedSegmentId && selectedSegmentId === item.id
                  return (
                    <div key={item.id || `${item.name}-${idx}`} className={selected ? 'rank-item selected' : 'rank-item'}>
                      <div className="rank-index">{idx + 1}</div>
                      <div className="rank-main">
                        <div className="rank-title">{item.name}</div>
                        <div className="rank-subline">
                          {item.fromStreet} to {item.toStreet}
                        </div>
                      </div>
                      <div className={`score-pill ${scoreToBadgeTone(item.score)}`}>
                        {formatScore(item.score)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <main className="map-stage">
        <div className="map-top-overlay">
          <div className="legend-card">
            <div className="legend-title">PCI Severity</div>
            <div className="legend-item">
              <span className="legend-line c1"></span>
              <span>Good</span>
            </div>
            <div className="legend-item">
              <span className="legend-line c2"></span>
              <span>Poor</span>
            </div>
            <div className="legend-item">
              <span className="legend-line c3"></span>
              <span>Very Poor</span>
            </div>
            <div className="legend-item">
              <span className="legend-line c4"></span>
              <span>Severe</span>
            </div>
          </div>
        </div>

        <div className="map-bottom-chip">Brookline, MA</div>

        {loading && <div className="center-overlay">Loading Brookline data…</div>}
        {error && <div className="center-overlay error">{error}</div>}

        <MapContainer center={BROOKLINE_CENTER} zoom={BROOKLINE_ZOOM} className="map-canvas" preferCanvas>
          <MapClickReset onClear={() => setSelectedSegment(null)} suppressMapClearRef={suppressMapClearRef} />
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ScaleControl position="bottomleft" />
          {visibleGeoJson && (
            <GeoJSON
              key={filterMode}
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