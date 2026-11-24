import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../utils'
import { requests, setRoute } from '../mockServer'
import { DeliveryPincodes } from '@/pages/DeliveryPincodes'
import { OperationalSettings } from '@/pages/OperationalSettings'
import Payments from '@/pages/Payments'

describe('FALLBACK: admin operational controls', () => {
  it('rejects duplicate PINs and sends edits with the current version', async () => {
    const user = userEvent.setup()
    setRoute('GET', /^\/v1\/admin\/delivery-pincodes$/, () => [{
      id:'11111111-1111-4111-8111-111111111111',pincode:'520001',storeId:'store-1',storeName:'Central',
      storeStatus:'ONLINE',locality:'Old',active:true,version:'4',updatedAt:'2026-11-18T00:00:00.000Z',
    }])
    setRoute('PATCH', /^\/v1\/admin\/delivery-pincodes\/[^/]+$/, () => ({}))
    renderWithProviders(<DeliveryPincodes />, { authenticated:true })
    await user.type(screen.getByLabelText('PIN codes'), '520002, 520002')
    await user.click(screen.getByRole('button', {name:'Add PIN codes'}))
    expect(screen.getByText('Remove repeated PIN codes before saving.')).toBeInTheDocument()
    expect(requests.some(request => request.method === 'POST' && request.path.includes('delivery-pincodes'))).toBe(false)
    const locality = await screen.findByLabelText('Area or locality for 520001')
    await user.clear(locality)
    await user.type(locality,'Central area')
    await user.click(screen.getByRole('button',{name:'Save changes'}))
    await waitFor(() => expect(requests.find(request => request.method === 'PATCH' && request.path.includes('delivery-pincodes'))?.body)
      .toEqual({storeId:'store-1',locality:'Central area',active:true,version:'4'}))
  })

  it('validates order limits and sends currency as exact paise', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OperationalSettings config={{minOrderPaise:'1000',maxOrderPaise:'10000',deliveryFeeSlabs:[{maxOrderValuePaise:null,feePaise:'0'}]}} />)
    const minimum = screen.getByLabelText('Minimum order')
    const row = minimum.closest('div.flex.flex-wrap') as HTMLElement
    await user.clear(minimum)
    await user.type(minimum,'101.00')
    await user.click(within(row).getByRole('button',{name:'Save'}))
    expect(within(row).getByText('The minimum cannot be greater than the maximum order.')).toBeInTheDocument()
    expect(requests.some(request => request.method === 'POST' && request.path.includes('minOrderPaise'))).toBe(false)
    await user.clear(minimum)
    await user.type(minimum,'99.99')
    await user.click(within(row).getByRole('button',{name:'Save'}))
    await waitFor(() => expect(requests.find(request => request.method === 'PATCH' && request.path === '/v1/admin/config')?.body)
      .toEqual({changes:[{key:'minOrderPaise',value:'9999'},{key:'maxOrderPaise',value:'10000'}]}))
  })

  it('starts a fresh wallet request only after the server reports the previous confirmation expired', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window,'confirm').mockReturnValue(true)
    let approvals = 0
    setRoute('POST', /^\/v1\/admin\/wallet\/adjustments$/, () => ({approvalId:'approval-1'}))
    setRoute('POST', /^\/v1\/admin\/wallet\/adjustments\/[^/]+\/approve$/, () => {
      approvals++
      return approvals === 1 ? {status:409,body:{code:'APPROVAL_EXPIRED'}} : {}
    })
    renderWithProviders(<Payments />, {authenticated:true})
    await user.click(screen.getByRole('tab',{name:'Wallet ledger'}))
    await user.click(screen.getByRole('button',{name:'Wallet adjustment'}))
    fireEvent.change(screen.getByLabelText('Customer user id'),{target:{value:'11111111-1111-4111-8111-111111111111'}})
    fireEvent.change(screen.getByLabelText('Amount in rupees'),{target:{value:'50.50'}})
    fireEvent.change(screen.getByLabelText('Reason for wallet adjustment'),{target:{value:'Goodwill credit'}})
    await user.click(screen.getByRole('button',{name:'Confirm adjustment'}))
    await screen.findByText('The confirmation expired without being applied. Review the details and confirm again.')
    await user.click(screen.getByRole('button',{name:'Confirm adjustment'}))
    await waitFor(() => expect(approvals).toBe(2))
    const adjustments=requests.filter(request => request.method === 'POST' && request.path === '/v1/admin/wallet/adjustments')
    expect(adjustments).toHaveLength(2)
    expect(adjustments[0]!.body).toEqual({userId:'11111111-1111-4111-8111-111111111111',bucket:'cash',direction:'CREDIT',amountPaise:'5050',reason:'Goodwill credit'})
    expect(adjustments[0]!.headers['idempotency-key']).not.toBe(adjustments[1]!.headers['idempotency-key'])
    expect(requests.filter(request => request.method === 'GET' && request.path.startsWith('/v1/admin/payments/attempts')).length).toBeLessThanOrEqual(1)
    confirm.mockRestore()
  }, 15000)
})
