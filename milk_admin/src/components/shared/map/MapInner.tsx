// Leaflet internals — ONLY imported from the lazy map chunk (LazyMap), so
// react-leaflet + leaflet + its CSS never touch the initial bundle.
import 'leaflet/dist/leaflet.css'
import { MapContainer, TileLayer, CircleMarker, Polyline, Polygon, ZoomControl, Tooltip as LeafTooltip } from 'react-leaflet'

export interface MapMarker { coords: [number, number]; color: string; label?: string; radius?: number }

export interface MapPolygon { points: [number, number][]; color: string; label?: string }

export interface MapInnerProps {
  polygons?: MapPolygon[]
  center: [number, number]
  zoom?: number
  markers?: MapMarker[]
  polyline?: [number, number][]
  origin?: [number, number] | null
  destination?: [number, number] | null
  liveMarker?: [number, number] | null
  showZoom?: boolean
  scrollWheelZoom?: boolean
}

export default function MapInner({ center, zoom = 10, markers = [], polygons = [], polyline, origin, destination, liveMarker, showZoom, scrollWheelZoom = false }: MapInnerProps) {
  return (
    <MapContainer center={center} zoom={zoom} scrollWheelZoom={scrollWheelZoom} className="h-full w-full" style={{ background: '#e8f0e2' }}>
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        className="map-tiles-soft"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      {showZoom && <ZoomControl position="bottomright" />}
      {polygons?.map((poly, i) => (
        <Polygon key={i} positions={poly.points} pathOptions={{ color: poly.color, fillColor: poly.color, fillOpacity: 0.18, weight: 2 }}>
          {poly.label && <LeafTooltip>{poly.label}</LeafTooltip>}
        </Polygon>
      ))}
      {polyline && polyline.length > 1 && <Polyline positions={polyline} pathOptions={{ color: '#2E7D1A', weight: 4, opacity: 0.9 }} />}
      {markers.map((m, i) => (
        <CircleMarker key={i} center={m.coords} radius={m.radius ?? 9} pathOptions={{ color: '#ffffff', weight: 2, fillColor: m.color, fillOpacity: 0.85 }}>
          {m.label && <LeafTooltip>{m.label}</LeafTooltip>}
        </CircleMarker>
      ))}
      {origin && <CircleMarker center={origin} radius={8} pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#5DAE2B', fillOpacity: 0.95 }} />}
      {destination && <CircleMarker center={destination} radius={8} pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#B05560', fillOpacity: 0.95 }} />}
      {liveMarker && (
        <CircleMarker center={liveMarker} radius={11} pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#2E7D1A', fillOpacity: 1 }}>
          <LeafTooltip>Delivery partner · live</LeafTooltip>
        </CircleMarker>
      )}
    </MapContainer>
  )
}
