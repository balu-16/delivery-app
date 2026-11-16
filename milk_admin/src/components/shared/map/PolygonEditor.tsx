// Zone polygon editor — lazy chunk (leaflet only loads here). Drag vertex handles
// to reshape a service-zone boundary; vertices are persisted through onSave.
import { useState } from 'react'
import 'leaflet/dist/leaflet.css'
import { MapContainer, TileLayer, Polygon, Marker, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { Button } from '@/components/ui/base'

export interface PolygonEditorProps {
  center: [number, number]
  initialPoints: [number, number][]
  color?: string
  onSave: (points: [number, number][]) => void
  onCancel?: () => void
}

const vertexIcon = L.divIcon({
  className: 'dairy-pin',
  html: '<span style="display:block;width:14px;height:14px;border-radius:4px;background:#2E7D1A;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)"></span>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
})

function ClickToAdd({ onAdd }: { onAdd: (p: [number, number]) => void }) {
  useMapEvents({
    click(e) {
      onAdd([+e.latlng.lat.toFixed(5), +e.latlng.lng.toFixed(5)])
    },
  })
  return null
}

export default function PolygonEditor({ center, initialPoints, color = '#2E7D1A', onSave, onCancel }: PolygonEditorProps) {
  const [points, setPoints] = useState<[number, number][]>(initialPoints.length >= 3 ? initialPoints : initialPoints.concat([initialPoints[0] ?? center]))

  return (
    <div className="relative h-[420px] w-full">
      <MapContainer center={center} zoom={12} scrollWheelZoom className="h-full w-full" style={{ background: '#e8f0e2' }}>
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          className="map-tiles-soft"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <ClickToAdd onAdd={(p) => setPoints((ps) => [...ps, p])} />
        {points.length >= 3 && (
          <Polygon positions={points} pathOptions={{ color, fillColor: color, fillOpacity: 0.16, weight: 2, dashArray: '6 4' }} />
        )}
        {points.map((p, i) => (
          <Marker
            key={i}
            position={p}
            draggable
            icon={vertexIcon}
            eventHandlers={{
              dragend: (e) => {
                const { lat, lng } = (e.target as L.Marker).getLatLng()
                setPoints((ps) => ps.map((q, k) => (k === i ? [+lat.toFixed(5), +lng.toFixed(5)] as [number, number] : q)))
              },
            }}
            aria-label={`Vertex ${i + 1}`}
          />
        ))}
      </MapContainer>
      <div className="pointer-events-none absolute left-3 top-3 z-[500] rounded-xl border border-border bg-card/95 px-3 py-2 text-[11px] font-medium text-muted-foreground shadow-soft">
        Drag the green handles to reshape the zone · click the map to add a vertex
      </div>
      <div className="absolute bottom-3 right-3 z-[500] flex gap-2">
        {onCancel && <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>}
        <Button size="sm" variant="primary" onClick={() => onSave(points)} disabled={points.length < 3}>
          Save zone boundary ({points.length} vertices)
        </Button>
      </div>
    </div>
  )
}
