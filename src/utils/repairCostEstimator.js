// src/utils/repairCostEstimator.js

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v === 'string') {
    // handles values like "24", "24.5", '24 ft'
    const m = v.match(/-?\d+(\.\d+)?/)
    return m ? Number(m[0]) : NaN
  }
  return NaN
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x))
}

function roundCurrency(x) {
  if (!Number.isFinite(x)) return 0
  // round to nearest $50 for cleaner UI
  return Math.round(x / 50) * 50
}

function compactUSD(n) {
  if (!Number.isFinite(n)) return 'N/A'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${Math.round(n)}`
}

function fullUSD(n) {
  if (!Number.isFinite(n)) return 'N/A'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(n)
}

function inferRoadWidthFt(segment) {
  const explicit = toNum(segment?.width)
  if (Number.isFinite(explicit) && explicit > 6 && explicit < 120) return explicit

  // Fallback for local streets if width missing
  return 28
}

function inferRoadLengthFt(segment) {
  const len = toNum(segment?.shapeLength)
  if (Number.isFinite(len) && len > 0) return len
  return NaN
}

function inferSidewalkWidthFt(segment) {
  const t = String(segment?.sidewalkType || segment?.name || '').toLowerCase()

  if (t.includes('bike')) return 10
  if (t.includes('driveway') || t.includes('apron')) return 10
  if (t.includes('ramp') || t.includes('curb cut')) return 6
  if (t.includes('no sidewalk')) return 5 // estimating new install width if needed
  return 5 // typical urban sidewalk width
}

function normalizeMaterial(segment) {
  const m = String(segment?.material || '').toLowerCase()
  if (m.includes('asphalt') || m.includes('bituminous')) return 'asphalt'
  if (m.includes('brick')) return 'brick'
  if (m.includes('concrete')) return 'concrete'
  return 'unknown'
}

function estimateRoadRepairCost(segment) {
  const score = toNum(segment?.score)
  const lengthFt = inferRoadLengthFt(segment)
  const widthFt = inferRoadWidthFt(segment)

  if (!Number.isFinite(lengthFt) || lengthFt <= 0) {
    return {
      ok: false,
      kind: 'roads',
      reason: 'Missing/invalid road length',
      badgeText: 'Cost N/A'
    }
  }

  const areaSqFt = lengthFt * widthFt
  const areaSqYd = areaSqFt / 9

  // HMA density approximation: ~110 lb / SY / inch => 0.055 ton / SY / inch
  const tonsPerSqYdPerInch = 0.055

  // Brookline urban/traffic complexity factor (planning heuristic)
  // Small/short jobs and dense streets usually cost more per unit.
  let urbanFactorMid = 1.15
  if (widthFt >= 36) urbanFactorMid += 0.05
  if (lengthFt >= 450) urbanFactorMid += 0.04
  if (areaSqYd < 250) urbanFactorMid += 0.06
  urbanFactorMid = clamp(urbanFactorMid, 1.10, 1.32)

  const urbanFactorLow = Math.max(1.05, urbanFactorMid - 0.07)
  const urbanFactorHigh = urbanFactorMid + 0.10

  // Expected utility adjustments (manholes/gates/etc.) — probabilistic allowance
  const expectedStructureCount = clamp((lengthFt / 320) * (widthFt / 28) * 0.8, 0.15, 4.5)

  const trafficAndMobilization = (low, mid, high) => {
    const sizeAdj = clamp(areaSqYd / 250, 0.5, 5)
    return {
      low: low + 300 * sizeAdj,
      mid: mid + 550 * sizeAdj,
      high: high + 900 * sizeAdj
    }
  }

  let treatment = 'Monitor / preventive maintenance'
  let confidence = 'low'
  let breakdown = {
    milling: { low: 0, mid: 0, high: 0 },
    asphalt: { low: 0, mid: 0, high: 0 },
    patching: { low: 0, mid: 0, high: 0 },
    utilityAdjustments: { low: 0, mid: 0, high: 0 },
    trafficMobilization: { low: 0, mid: 0, high: 0 }
  }

  if (!Number.isFinite(score)) {
    // Fallback if PCI missing
    treatment = 'Mill & overlay (assumed)'
    confidence = 'low'
    const thicknessIn = 1.5
    const hmaTons = areaSqYd * thicknessIn * tonsPerSqYdPerInch

    breakdown.milling = {
      low: areaSqYd * 5.0 * urbanFactorLow,
      mid: areaSqYd * 7.0 * urbanFactorMid,
      high: areaSqYd * 10.0 * urbanFactorHigh
    }
    breakdown.asphalt = {
      low: hmaTons * 115 * urbanFactorLow,
      mid: hmaTons * 145 * urbanFactorMid,
      high: hmaTons * 180 * urbanFactorHigh
    }
    breakdown.utilityAdjustments = {
      low: expectedStructureCount * 250,
      mid: expectedStructureCount * 360,
      high: expectedStructureCount * 550
    }
    breakdown.trafficMobilization = trafficAndMobilization(1200, 2200, 4000)
  } else if (score >= 70) {
    treatment = 'Preventive maintenance / monitor'
    confidence = 'low'

    // mostly crack sealing / localized patching allowance
    const patchShare = 0.03
    const patchThicknessIn = 2.0
    const patchTons = areaSqYd * patchShare * patchThicknessIn * tonsPerSqYdPerInch

    breakdown.patching = {
      low: patchTons * 210 * urbanFactorLow + lengthFt * 1.0,
      mid: patchTons * 250 * urbanFactorMid + lengthFt * 1.8,
      high: patchTons * 320 * urbanFactorHigh + lengthFt * 3.0
    }
    breakdown.trafficMobilization = trafficAndMobilization(700, 1200, 2400)
  } else if (score > 55) {
    treatment = 'Targeted patching + crack sealing'
    confidence = 'medium'

    const patchShare = 0.08
    const patchThicknessIn = 2.0
    const patchTons = areaSqYd * patchShare * patchThicknessIn * tonsPerSqYdPerInch

    breakdown.patching = {
      low: patchTons * 210 * urbanFactorLow + areaSqYd * 1.2,
      mid: patchTons * 250 * urbanFactorMid + areaSqYd * 2.2,
      high: patchTons * 320 * urbanFactorHigh + areaSqYd * 3.8
    }
    breakdown.utilityAdjustments = {
      low: expectedStructureCount * 120,
      mid: expectedStructureCount * 200,
      high: expectedStructureCount * 325
    }
    breakdown.trafficMobilization = trafficAndMobilization(900, 1600, 3000)
  } else if (score > 40) {
    treatment = 'Mill + overlay (1.5")'
    confidence = 'medium'

    const thicknessIn = 1.5
    const hmaTons = areaSqYd * thicknessIn * tonsPerSqYdPerInch

    breakdown.milling = {
      low: areaSqYd * 4.5 * urbanFactorLow,
      mid: areaSqYd * 6.5 * urbanFactorMid,
      high: areaSqYd * 9.0 * urbanFactorHigh
    }
    breakdown.asphalt = {
      low: hmaTons * 110 * urbanFactorLow,
      mid: hmaTons * 140 * urbanFactorMid,
      high: hmaTons * 175 * urbanFactorHigh
    }
    breakdown.patching = {
      low: areaSqYd * 0.8,
      mid: areaSqYd * 1.5,
      high: areaSqYd * 2.8
    }
    breakdown.utilityAdjustments = {
      low: expectedStructureCount * 220,
      mid: expectedStructureCount * 340,
      high: expectedStructureCount * 500
    }
    breakdown.trafficMobilization = trafficAndMobilization(1200, 2200, 4000)
  } else if (score > 25) {
    treatment = 'Mill + leveling + overlay (2–2.5")'
    confidence = 'medium'

    const thicknessIn = 2.25
    const hmaTons = areaSqYd * thicknessIn * tonsPerSqYdPerInch

    breakdown.milling = {
      low: areaSqYd * 5.0 * urbanFactorLow,
      mid: areaSqYd * 7.5 * urbanFactorMid,
      high: areaSqYd * 10.5 * urbanFactorHigh
    }
    breakdown.asphalt = {
      low: hmaTons * 120 * urbanFactorLow,
      mid: hmaTons * 155 * urbanFactorMid,
      high: hmaTons * 195 * urbanFactorHigh
    }
    breakdown.patching = {
      low: areaSqYd * 2.0,
      mid: areaSqYd * 4.0,
      high: areaSqYd * 7.5
    }
    breakdown.utilityAdjustments = {
      low: expectedStructureCount * 250,
      mid: expectedStructureCount * 380,
      high: expectedStructureCount * 575
    }
    breakdown.trafficMobilization = trafficAndMobilization(1500, 2800, 5000)
  } else {
    treatment = 'Partial-depth / full-depth rehab (planning)'
    confidence = 'low'

    // Blended approach because PCI alone is not enough to know exact rehab scope.
    // Assume a share of area needs deep repair + remainder gets surfacing.
    const rehabShareLow = 0.20
    const rehabShareMid = 0.35
    const rehabShareHigh = 0.60

    const overlayThicknessIn = 1.5
    const overlayTons = areaSqYd * overlayThicknessIn * tonsPerSqYdPerInch

    breakdown.milling = {
      low: areaSqYd * 3.5 * urbanFactorLow,
      mid: areaSqYd * 5.5 * urbanFactorMid,
      high: areaSqYd * 8.0 * urbanFactorHigh
    }

    breakdown.asphalt = {
      low: overlayTons * 115 * urbanFactorLow,
      mid: overlayTons * 150 * urbanFactorMid,
      high: overlayTons * 190 * urbanFactorHigh
    }

    breakdown.patching = {
      // "patching" bucket acts as deep-repair / reconstruction allowance here
      low: areaSqYd * rehabShareLow * 45,
      mid: areaSqYd * rehabShareMid * 75,
      high: areaSqYd * rehabShareHigh * 130
    }

    breakdown.utilityAdjustments = {
      low: expectedStructureCount * 300,
      mid: expectedStructureCount * 450,
      high: expectedStructureCount * 700
    }

    breakdown.trafficMobilization = trafficAndMobilization(1800, 3500, 6500)
  }

  const low =
    breakdown.milling.low +
    breakdown.asphalt.low +
    breakdown.patching.low +
    breakdown.utilityAdjustments.low +
    breakdown.trafficMobilization.low

  const mid =
    breakdown.milling.mid +
    breakdown.asphalt.mid +
    breakdown.patching.mid +
    breakdown.utilityAdjustments.mid +
    breakdown.trafficMobilization.mid

  const high =
    breakdown.milling.high +
    breakdown.asphalt.high +
    breakdown.patching.high +
    breakdown.utilityAdjustments.high +
    breakdown.trafficMobilization.high

  return {
    ok: true,
    kind: 'roads',
    treatment,
    confidence,
    quantities: {
      lengthFt,
      widthFt,
      areaSqFt,
      areaSqYd,
      expectedStructureCount: Number(expectedStructureCount.toFixed(2))
    },
    low: roundCurrency(low),
    mid: roundCurrency(mid),
    high: roundCurrency(high),
    badgeText: compactUSD(roundCurrency(mid)),
    rangeText: `${fullUSD(roundCurrency(low))} – ${fullUSD(roundCurrency(high))}`,
    breakdown: {
      milling: roundCurrency(breakdown.milling.mid),
      asphalt: roundCurrency(breakdown.asphalt.mid),
      patchingOrRehab: roundCurrency(breakdown.patching.mid),
      utilityAdjustments: roundCurrency(breakdown.utilityAdjustments.mid),
      trafficAndMobilization: roundCurrency(breakdown.trafficMobilization.mid)
    }
  }
}

function estimateSidewalkRepairCost(segment) {
  const condition = String(segment?.label || '').toLowerCase() // Good/Fair/Poor normalized in your app
  const material = normalizeMaterial(segment)
  const lengthFt = toNum(segment?.approxLengthFt)
  const widthFt = inferSidewalkWidthFt(segment)

  if (!Number.isFinite(lengthFt) || lengthFt <= 0) {
    return {
      ok: false,
      kind: 'sidewalks',
      reason: 'Missing/invalid sidewalk length',
      badgeText: 'Cost N/A'
    }
  }

  const areaSqFt = lengthFt * widthFt
  const areaSqYd = areaSqFt / 9
  const tonsPerSqYdPerInch = 0.055
  const typeText = String(segment?.sidewalkType || segment?.name || '').toLowerCase()
  const isRampLike = typeText.includes('ramp') || typeText.includes('curb cut')
  const isDrivewayLike = typeText.includes('driveway') || typeText.includes('apron')

  let urbanFactorMid = 1.12
  if (areaSqYd < 20) urbanFactorMid += 0.08
  if (isRampLike) urbanFactorMid += 0.05
  urbanFactorMid = clamp(urbanFactorMid, 1.05, 1.28)
  const urbanFactorLow = Math.max(1.02, urbanFactorMid - 0.06)
  const urbanFactorHigh = urbanFactorMid + 0.10

  const overhead = (low, mid, high) => ({
    low: low + clamp(areaSqYd, 4, 80) * 8,
    mid: mid + clamp(areaSqYd, 4, 80) * 12,
    high: high + clamp(areaSqYd, 4, 80) * 18
  })

  let treatment = 'Monitor / minor maintenance'
  let confidence = 'low'
  let low = 0
  let mid = 0
  let high = 0
  let breakdown = {
    baseRepair: 0,
    rampOrTileAllowance: 0,
    curbAllowance: 0,
    trafficAndMobilization: 0
  }

  if (condition === 'good') {
    treatment = 'Monitor / spot trip-hazard repairs'
    confidence = 'low'
    const base = {
      low: areaSqYd * 8,
      mid: areaSqYd * 18,
      high: areaSqYd * 35
    }
    const oh = overhead(500, 900, 1800)
    low = base.low + oh.low
    mid = base.mid + oh.mid
    high = base.high + oh.high
    breakdown.baseRepair = roundCurrency(base.mid)
    breakdown.trafficAndMobilization = roundCurrency(oh.mid)
  } else if (condition === 'fair') {
    treatment = material === 'asphalt'
      ? 'Partial patching / resurfacing'
      : 'Panel repairs / trip hazard correction'
    confidence = 'medium'

    if (material === 'asphalt') {
      // Assume partial-depth patching/resurfacing on ~35-60% of segment
      const shareLow = 0.30
      const shareMid = 0.45
      const shareHigh = 0.65
      const thicknessIn = 2.0

      const tonsLow = areaSqYd * shareLow * thicknessIn * tonsPerSqYdPerInch
      const tonsMid = areaSqYd * shareMid * thicknessIn * tonsPerSqYdPerInch
      const tonsHigh = areaSqYd * shareHigh * thicknessIn * tonsPerSqYdPerInch

      const base = {
        low: tonsLow * 170 * urbanFactorLow + areaSqYd * 8,
        mid: tonsMid * 230 * urbanFactorMid + areaSqYd * 14,
        high: tonsHigh * 310 * urbanFactorHigh + areaSqYd * 25
      }
      const oh = overhead(700, 1200, 2200)
      low = base.low + oh.low
      mid = base.mid + oh.mid
      high = base.high + oh.high
      breakdown.baseRepair = roundCurrency(base.mid)
      breakdown.trafficAndMobilization = roundCurrency(oh.mid)
    } else {
      const base = {
        low: areaSqYd * 45 * urbanFactorLow,
        mid: areaSqYd * 80 * urbanFactorMid,
        high: areaSqYd * 135 * urbanFactorHigh
      }
      const oh = overhead(700, 1300, 2500)
      low = base.low + oh.low
      mid = base.mid + oh.mid
      high = base.high + oh.high
      breakdown.baseRepair = roundCurrency(base.mid)
      breakdown.trafficAndMobilization = roundCurrency(oh.mid)
    }
  } else {
    // Poor or unknown -> plan for replacement
    treatment = material === 'asphalt'
      ? 'Full sidewalk replacement (asphalt)'
      : 'Full sidewalk replacement (concrete)'
    confidence = condition === 'poor' ? 'medium' : 'low'

    if (material === 'asphalt') {
      // HMA sidewalk / driveway replacement
      const thicknessIn = isDrivewayLike ? 3.0 : 2.0
      const hmaTons = areaSqYd * thicknessIn * tonsPerSqYdPerInch
      const base = {
        low: hmaTons * 170 * urbanFactorLow + areaSqYd * 10,
        mid: hmaTons * 235 * urbanFactorMid + areaSqYd * 18,
        high: hmaTons * 320 * urbanFactorHigh + areaSqYd * 30
      }
      const oh = overhead(900, 1600, 3000)
      low = base.low + oh.low
      mid = base.mid + oh.mid
      high = base.high + oh.high
      breakdown.baseRepair = roundCurrency(base.mid)
      breakdown.trafficAndMobilization = roundCurrency(oh.mid)
    } else {
      // Concrete / unknown / brick -> concrete-style replacement allowance
      const base = {
        low: areaSqYd * 120 * urbanFactorLow,
        mid: areaSqYd * 175 * urbanFactorMid,
        high: areaSqYd * 280 * urbanFactorHigh
      }
      const oh = overhead(900, 1700, 3200)

      let rampTile = { low: 0, mid: 0, high: 0 }
      let curb = { low: 0, mid: 0, high: 0 }

      if (isRampLike) {
        // Ramp + detectable warning + extra formwork/detailing
        rampTile = {
          low: 600,
          mid: 1500,
          high: 4500
        }
        curb = {
          low: 300,
          mid: 900,
          high: 2200
        }
      }

      low = base.low + rampTile.low + curb.low + oh.low
      mid = base.mid + rampTile.mid + curb.mid + oh.mid
      high = base.high + rampTile.high + curb.high + oh.high

      breakdown.baseRepair = roundCurrency(base.mid)
      breakdown.rampOrTileAllowance = roundCurrency(rampTile.mid)
      breakdown.curbAllowance = roundCurrency(curb.mid)
      breakdown.trafficAndMobilization = roundCurrency(oh.mid)
    }
  }

  return {
    ok: true,
    kind: 'sidewalks',
    treatment,
    confidence,
    quantities: {
      lengthFt,
      widthFt,
      areaSqFt,
      areaSqYd
    },
    low: roundCurrency(low),
    mid: roundCurrency(mid),
    high: roundCurrency(high),
    badgeText: compactUSD(roundCurrency(mid)),
    rangeText: `${fullUSD(roundCurrency(low))} – ${fullUSD(roundCurrency(high))}`,
    breakdown
  }
}

export function estimateRepairCost(selectedSegment) {
  if (!selectedSegment) return null
  if (selectedSegment.mode === 'roads') return estimateRoadRepairCost(selectedSegment)
  if (selectedSegment.mode === 'sidewalks') return estimateSidewalkRepairCost(selectedSegment)
  return null
}

export function formatRepairCostBadge(estimate) {
  if (!estimate?.ok) return 'Cost N/A'
  return `Est. ${estimate.badgeText}`
}

export function repairCostTone(estimate) {
  if (!estimate?.ok) return 'neutral'
  const v = estimate.mid
  if (v >= 75000) return 'critical'
  if (v >= 25000) return 'high'
  if (v >= 8000) return 'medium'
  return 'low'
}