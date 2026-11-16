import { fmtINR } from '../lib/utils'

// Heavy export libraries are loaded ONLY when the user actually triggers an
// export — they never touch the initial bundle or any route chunk.
async function loadXlsx() {
  return import('xlsx')
}
async function loadJsPdf() {
  const mod = await import('jspdf')
  return mod.jsPDF
}

/** Real .xlsx download via SheetJS (loaded on demand) */
export async function downloadXlsx(sheets: Array<{ name: string; rows: Record<string, unknown>[] }>, filename: string) {
  const XLSX = await loadXlsx()
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows)
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31))
  }
  XLSX.writeFile(wb, filename)
}

export async function downloadCsv(rows: Record<string, unknown>[], filename: string) {
  const XLSX = await loadXlsx()
  const ws = XLSX.utils.json_to_sheet(rows)
  const csv = XLSX.utils.sheet_to_csv(ws)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Real .pdf invoice via jsPDF (loaded on demand) */
export async function generateInvoicePdf(order: {
  id: string; customerName: string; customerPhone: string; cityId: string; amount: number
  deliveryFee: number; discount: number; placedAt: string; paymentMethod: string; paymentStatus: string
  items: Array<{ name: string; qty: number; price: number; total: number }>
}, cityName: string) {
  const JsPDF = await loadJsPdf()
  const doc = new JsPDF({ unit: 'pt', format: 'a4' })
  doc.setFillColor(46, 125, 26)
  doc.rect(0, 0, 595, 90, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.text('DairyDirect', 40, 42)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text('Invoice — Admin Portal · support@dairydirect.in', 40, 62)
  doc.setTextColor(20, 30, 20)
  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.text(`Invoice for Order #${order.id}`, 40, 130)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text([
    `Customer: ${order.customerName}`,
    `Phone: ${order.customerPhone}`,
    `City: ${cityName}`,
    `Placed: ${new Date(order.placedAt).toLocaleString('en-IN')}`,
    `Payment: ${order.paymentMethod.toUpperCase()} · ${order.paymentStatus.replace('_', ' ')}`,
  ], 40, 155)

  let y = 230
  doc.setDrawColor(220, 230, 215)
  doc.line(40, y - 14, 555, y - 14)
  doc.setFont('helvetica', 'bold')
  doc.text('Item', 40, y); doc.text('Qty', 330, y); doc.text('Price', 390, y); doc.text('Total', 490, y)
  doc.setFont('helvetica', 'normal')
  y += 22
  for (const it of order.items) {
    doc.text(it.name, 40, y)
    doc.text(String(it.qty), 330, y)
    doc.text(fmtINR(it.price), 390, y)
    doc.text(fmtINR(it.total), 490, y)
    y += 20
  }
  y += 12
  doc.line(330, y, 555, y)
  y += 20
  doc.text(`Subtotal: ${fmtINR(order.amount - order.deliveryFee - order.discount)}`, 400, y); y += 18
  if (order.discount > 0) { doc.text(`Discount: −${fmtINR(order.discount)}`, 400, y); y += 18 }
  doc.text(`Delivery Fee: ${fmtINR(order.deliveryFee)}`, 400, y); y += 20
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text(`Total: ${fmtINR(order.amount)}`, 400, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(120, 130, 120)
  doc.text('Thank you for choosing DairyDirect — fresh dairy, delivered daily.', 40, 780)
  doc.save(`invoice-${order.id}.pdf`)
}

export function downloadText(content: string, filename: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
