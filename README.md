# Pavement & Sidewalk Condition Viewer

An interactive infrastructure decision-support tool built with Cyvl data to help cities prioritize pavement and sidewalk repairs.

The platform visualizes PCI scores, estimates planning-level repair costs, and integrates 360° street panoramas to connect condition data with real-world conditions.

---

## Overview

Cities collect detailed infrastructure condition data, but it is often buried in spreadsheets and technical reports. This project transforms Cyvl’s GeoJSON pavement, sidewalk, and imagery datasets into an interactive, map-based prioritization tool.

The goal is to make infrastructure condition data:

- Clear  
- Visual  
- Transparent  
- Actionable  

---

## Features

### Condition Visualization
- Road segments color-coded by PCI severity
- Sidewalk segments categorized by condition rating
- Dynamic legend toggling
- Real-time distribution summaries

### Priority Ranking
- Automatic ranking of lowest-performing segments
- "Top Worst" leaderboard
- Dynamic updates based on filtered data

### 360° Panorama Integration
- Click any segment to view the nearest street-level panorama
- Distance-based panorama matching
- Visual validation of recorded condition data

### Planning-Level Cost Estimation
- Rough order-of-magnitude (ROM) repair cost estimates
- Treatment inferred from PCI or sidewalk condition
- Geometry-based quantity calculations (length × width)
- Municipal-scale unit cost assumptions (Massachusetts planning-level ranges)

This is intended for planning insight, not bid-level precision.

---

## Tech Stack

- **React** – State management and UI logic  
- **Leaflet.js** – Interactive geospatial rendering  
- **GeoJSON** – Infrastructure dataset format  
- **Vite** – Frontend build tool  

---

## Technical Implementation

### Severity Classification
- PCI ranges mapped to severity categories
- Sidewalk condition normalized and bucketed
- Dynamic filtering based on active legend toggles

### Geometry Processing
- Segment length computed from GeoJSON coordinates
- Width and material fields parsed from dataset
- Area calculations used for cost modeling

### Panorama Matching
- Haversine distance calculation
- Nearest panorama selected on click
- Popup + sidebar integration

### Cost Estimation Logic
The cost estimator:
- Infers likely repair treatment from condition severity
- Calculates material quantities from segment geometry
- Applies planning-level municipal unit cost ranges
- Outputs rough order-of-magnitude repair estimates

---

## Current Functionality

The application currently supports:

- Condition filtering
- Severity legend toggling
- Segment ranking
- Panorama integration
- Planning-level cost estimation
- Real-time GeoJSON rendering

Performance is maintained using memoization and selective re-rendering to efficiently handle hundreds of segments simultaneously.

---

## Data Sources

This project uses publicly shared infrastructure datasets provided by Cyvl:

- Pavement Condition Index (PCI) data
- Sidewalk asset condition data
- 360° panoramic imagery

No new primary data was collected.

---

## Data Privacy

This application:
- Does not collect user data
- Does not require authentication
- Does not store personal information

All datasets used are publicly shared infrastructure data.

---

## Transparency & Limitations

The system ranks segments using:
- Recorded PCI scores
- Standardized sidewalk condition ratings
- Clearly defined severity thresholds

Limitations:
- Condition scores represent inspection snapshots in time
- The tool does not predict future deterioration
- The cost estimator provides planning-level approximations only
- Final repair decisions remain human-driven

This is a decision-support tool, not an automated decision-maker.

---

## Future Improvements

With additional time and partnerships, this project could:

- Expand to additional cities
- Integrate deeper asset layers
- Incorporate LiDAR-derived insights
- Refine cost modeling using municipal bid datasets
- Add contextual datasets (traffic volume, equity indicators)

Long term, this could evolve into a broader infrastructure intelligence and transparency platform.
